/**
 * V2 Workflow Draft Store
 *
 * Uses per-draft keys in localStorage instead of a single blob.
 * Refuses quota-blocked writes without evicting other drafts.
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

import { reportError } from '@comfyorg/telemetry/reportError'
import { useApp } from '@/scripts/appInstance'

import type {
  DraftIndexV2,
  DraftLineage,
  DraftPayloadV2
} from '@/platform/workflow/persistence/base/draftTypes'
import {
  createEmptyIndex,
  getEntryByPath,
  getMostRecentKey,
  moveEntry,
  removeEntry,
  removeOrphanedEntries,
  touchOrder,
  upsertEntry
} from '@/platform/workflow/persistence/base/draftCacheV2'
import { hashPath } from '@/platform/workflow/persistence/base/hashUtil'
import { getWorkspaceId } from '@/platform/workflow/persistence/base/storageKeys'
import {
  deleteOrphanPayloads,
  deletePayload,
  getPayloadKeys,
  isStorageAvailable,
  measureLocalStorage,
  readIndex,
  readPayload,
  readPayloadRaw,
  writeIndex,
  writePayload,
  writePayloadRaw
} from '@/platform/workflow/persistence/base/storageIO'

interface DraftMeta {
  name: string
  isTemporary: boolean
  isModified?: boolean
}

interface LoadPersistedWorkflowOptions {
  preferredPath?: string | null
  fallbackToLatestDraft?: boolean
  isCurrent?: () => boolean
}

export const useWorkflowDraftStoreV2 = defineStore('workflowDraftV2', () => {
  // In-memory cache of the index per workspace (synced with localStorage)
  // Key is workspaceId, value is the cached index
  const indexCacheByWorkspace = ref<Record<string, DraftIndexV2>>({})
  const lineageByDraft = new Map<string, DraftLineage | null>()
  const reportedQuotaByDraft = new Set<string>()
  const authSubject = ref<string | null | undefined>(undefined)
  let saveFailureNotified = false
  let persistencePauseDepth = 0

  /**
   * Gets the current workspace ID fresh (not cached).
   * This ensures operations use the correct workspace after switches.
   */
  function currentWorkspaceId(): string {
    const workspaceId = getWorkspaceId()
    const subject = authSubject.value
    if (subject === undefined) return workspaceId
    return `${encodeURIComponent(subject ?? 'unauthenticated')}:${workspaceId}`
  }

  function setAuthSubject(subject: string | null | undefined): void {
    authSubject.value = subject
  }

  function lineageKey(workspaceId: string, draftKey: string): string {
    return `${workspaceId}:${draftKey}`
  }

  function payloadFor(
    workspaceId: string,
    draftKey: string,
    data: string,
    updatedAt: number,
    isModified?: boolean
  ): DraftPayloadV2 {
    const key = lineageKey(workspaceId, draftKey)
    if (!lineageByDraft.has(key)) {
      // Read a pre-existing lineage at most once after a cold start. Subsequent
      // autosaves, including drafts without lineage, must not copy the previous
      // workflow payload just to construct the next envelope.
      lineageByDraft.set(
        key,
        readPayload(workspaceId, draftKey)?.lineage ?? null
      )
    }
    const lineage = lineageByDraft.get(key)
    return { data, updatedAt, ...(lineage && { lineage }), isModified }
  }

  /**
   * Returns true only for the first failure in a continuous persistence-failure
   * episode. localStorage quota/availability is shared by all workflow paths,
   * and a single graph load can invoke both draft-save callers.
   */
  function shouldNotifySaveFailure(): boolean {
    if (saveFailureNotified) return false
    saveFailureNotified = true
    return true
  }

  /** Any successful draft save proves persistence recovered and resets the episode. */
  function markSaveSucceeded(): void {
    saveFailureNotified = false
  }

  /**
   * Temporarily suppresses draft writes initiated by graph-load lifecycle hooks.
   * This is caller-coordination state rather than a storage mutex: lifecycle
   * callers check isPersistencePaused() before invoking the low-level saveDraft
   * primitive. The returned resume function is idempotent and supports nesting.
   */
  function pausePersistence(): () => void {
    persistencePauseDepth++
    let resumed = false
    return () => {
      if (resumed) return
      resumed = true
      persistencePauseDepth = Math.max(0, persistencePauseDepth - 1)
    }
  }

  function isPersistencePaused(): boolean {
    return persistencePauseDepth > 0
  }

  /**
   * Loads the index from localStorage or creates empty.
   */
  function loadIndex(): DraftIndexV2 {
    const workspaceId = currentWorkspaceId()

    const cached = getCachedIndex(workspaceId)
    if (cached) return cached

    const stored = readIndex(workspaceId)
    if (stored) {
      // Clean up any index/payload drift
      const payloadKeys = new Set(getPayloadKeys(workspaceId))
      const cleaned = removeOrphanedEntries(stored, payloadKeys)
      indexCacheByWorkspace.value[workspaceId] = cleaned

      // Also clean up orphan payloads
      const indexKeys = new Set(cleaned.order)
      deleteOrphanPayloads(workspaceId, indexKeys)

      return cleaned
    }

    const emptyIndex = createEmptyIndex()
    indexCacheByWorkspace.value[workspaceId] = emptyIndex
    return emptyIndex
  }

  function getCachedIndex(workspaceId: string): DraftIndexV2 | null {
    return indexCacheByWorkspace.value[workspaceId]
  }

  /**
   * Persists the current index to localStorage.
   */
  function persistIndex(index: DraftIndexV2): boolean {
    const workspaceId = currentWorkspaceId()
    if (!writeIndex(workspaceId, index)) return false
    indexCacheByWorkspace.value[workspaceId] = index
    return true
  }

  /**
   * Write metadata before replacing an indexed payload. A failed index write
   * leaves the previous payload intact without reading or copying it.
   * localStorage.setItem is atomic on failure; only the index needs rollback
   * if the subsequent payload write fails.
   */
  function saveIndexedOverwrite(
    workspaceId: string,
    draftKey: string,
    payload: DraftPayloadV2,
    index: DraftIndexV2,
    newIndex: DraftIndexV2
  ): 'index' | 'payload' | null {
    if (!persistIndex(newIndex)) return 'index'

    let written = false
    let restored = false
    try {
      written = writePayload(workspaceId, draftKey, payload)
    } finally {
      if (!written) {
        try {
          restored = persistIndex(index)
        } finally {
          if (!restored) delete indexCacheByWorkspace.value[workspaceId]
        }
      }
    }
    return written ? null : 'payload'
  }

  function saveNewDraft(
    workspaceId: string,
    draftKey: string,
    payload: DraftPayloadV2,
    newIndex: DraftIndexV2
  ): 'index' | 'payload' | null {
    const previousPayload = readPayloadRaw(workspaceId, draftKey)
    if (!writePayload(workspaceId, draftKey, payload)) return 'payload'

    let committed = false
    try {
      committed = persistIndex(newIndex)
    } finally {
      if (
        !committed &&
        !restoreTargetPayload(workspaceId, draftKey, previousPayload)
      ) {
        delete indexCacheByWorkspace.value[workspaceId]
        console.error(
          '[Workflow Drafts] Failed to restore target payload after index write failure'
        )
      }
    }
    return committed ? null : 'index'
  }

  /**
   * Saves a draft without evicting any other indexed draft. The existing
   * evict: false option selects a fresh index for recovery checkpoints,
   * avoiding the ordinary cached-index cleanup path.
   */
  function saveDraft(
    path: string,
    data: string,
    meta: DraftMeta,
    { evict = true, minUpdatedAt = 0 } = {}
  ): boolean {
    if (!isStorageAvailable()) return false

    const workspaceId = currentWorkspaceId()
    const draftKey = hashPath(path)
    const draftId = lineageKey(workspaceId, draftKey)
    const now = Math.max(Date.now(), minUpdatedAt)
    const index = evict
      ? loadIndex()
      : (readIndex(workspaceId) ?? createEmptyIndex())
    const existingEntry = getIndexEntry(index, draftKey)
    // Keep the modification flag with the atomic payload write, rather than
    // publishing a new clean/dirty flag for the old graph if rollback fails.
    const { isModified, ...indexMeta } = meta
    const { index: newIndex } = upsertEntry(
      index,
      path,
      { ...indexMeta, updatedAt: now },
      Number.POSITIVE_INFINITY
    )
    const payload = payloadFor(workspaceId, draftKey, data, now, isModified)
    const failure = existingEntry
      ? saveIndexedOverwrite(workspaceId, draftKey, payload, index, newIndex)
      : saveNewDraft(workspaceId, draftKey, payload, newIndex)

    if (failure) {
      reportQuotaExhausted(draftId, index, payloadByteSize(payload), failure)
      return false
    }

    reportedQuotaByDraft.delete(draftId)
    markSaveSucceeded()
    return true
  }

  function restoreTargetPayload(
    workspaceId: string,
    draftKey: string,
    previousPayload: string | null
  ): boolean {
    if (previousPayload === null) {
      return deletePayload(workspaceId, draftKey)
    }

    try {
      if (writePayloadRaw(workspaceId, draftKey, previousPayload)) return true
    } catch (error) {
      console.error(
        '[Workflow Drafts] Failed to restore target payload directly',
        error
      )
    }

    // Replacing a larger failed payload can itself hit quota. Removing the
    // uncommitted replacement first frees its bytes before retrying the exact
    // previous payload.
    if (!deletePayload(workspaceId, draftKey)) return false

    try {
      return writePayloadRaw(workspaceId, draftKey, previousPayload)
    } catch (error) {
      console.error(
        '[Workflow Drafts] Failed to restore target payload after cleanup',
        error
      )
      return false
    }
  }

  function getIndexEntry(
    index: DraftIndexV2,
    key: string
  ): DraftIndexV2['entries'][string] | undefined {
    return index.entries[key]
  }

  /**
   * Measures the UTF-8 byte size of the serialized payload envelope.
   */
  function payloadByteSize(payload: DraftPayloadV2): number {
    return new TextEncoder().encode(JSON.stringify({ ...payload, updatedAt: 0 }))
      .length
  }

  function reportQuotaExhausted(
    draftId: string,
    index: DraftIndexV2,
    payloadBytes: number,
    writeTarget: 'payload' | 'index'
  ): void {
    if (reportedQuotaByDraft.has(draftId)) return
    reportedQuotaByDraft.add(draftId)

    reportError(
      new Error('localStorage quota exhausted while saving workflow draft'),
      {
        surface: 'graph',
        errorType: 'storage_quota_exhausted',
        level: 'warning',
        tags: { store: 'workflowDraftStoreV2' },
        context: {
          remainingDrafts: index.order.length,
          incomingPayloadBytes: payloadBytes,
          writeTarget,
          ...measureLocalStorage()
        }
      }
    )
  }

  /**
   * Removes a draft.
   */
  function removeDraft(path: string): boolean {
    if (!isStorageAvailable()) return false
    const workspaceId = currentWorkspaceId()
    const draftId = lineageKey(workspaceId, hashPath(path))
    const index = loadIndex()
    const { index: newIndex, removedKey } = removeEntry(index, path)

    if (!removedKey) {
      reportedQuotaByDraft.delete(draftId)
      return true
    }
    if (!persistIndex(newIndex)) return false

    reportedQuotaByDraft.delete(draftId)
    lineageByDraft.delete(lineageKey(workspaceId, removedKey))
    return deletePayload(workspaceId, removedKey)
  }

  /**
   * Moves a draft from one path to another (rename).
   */
  function moveDraft(oldPath: string, newPath: string, name: string): void {
    if (!isStorageAvailable()) return
    const workspaceId = currentWorkspaceId()
    const index = loadIndex()
    const result = moveEntry(index, oldPath, newPath, name)

    if (result) {
      const isRenameOntoSelf = result.oldKey === result.newKey
      if (isRenameOntoSelf) {
        if (persistIndex(result.index)) {
          reportedQuotaByDraft.delete(lineageKey(workspaceId, result.oldKey))
        }
        return
      }
      const oldPayload = readPayloadRaw(workspaceId, result.oldKey)
      if (oldPayload === null) return
      const previousPayload = readPayloadRaw(workspaceId, result.newKey)
      if (!writePayloadRaw(workspaceId, result.newKey, oldPayload)) return

      let committed = false
      try {
        committed = persistIndex(result.index)
      } finally {
        if (
          !committed &&
          !restoreTargetPayload(workspaceId, result.newKey, previousPayload)
        ) {
          delete indexCacheByWorkspace.value[workspaceId]
          console.error('[Workflow Drafts] Failed to restore rename target')
        }
      }
      if (!committed) return

      const oldId = lineageKey(workspaceId, result.oldKey)
      const newId = lineageKey(workspaceId, result.newKey)
      reportedQuotaByDraft.delete(oldId)
      reportedQuotaByDraft.delete(newId)
      deletePayload(workspaceId, result.oldKey)
      if (lineageByDraft.has(oldId)) {
        lineageByDraft.set(newId, lineageByDraft.get(oldId) ?? null)
      } else {
        lineageByDraft.delete(newId)
      }
      lineageByDraft.delete(oldId)
    }
  }

  function getDraft(
    path: string,
    { fresh = false } = {}
  ): {
    data: string
    name: string
    isTemporary: boolean
    updatedAt: number
    isModified?: boolean
    lineage?: DraftLineage
  } | null {
    const workspaceId = currentWorkspaceId()
    const index = fresh ? readIndex(workspaceId) : loadIndex()
    if (!index) return null
    const entry = getEntryByPath(index, path)
    if (entry?.path !== path) return null

    const draftKey = hashPath(path)
    if (!index.order.includes(draftKey)) return null
    const payload = readPayload(workspaceId, draftKey)
    if (!payload) {
      if (!fresh) removeDraft(path)
      return null
    }
    if (!fresh) {
      const key = lineageKey(workspaceId, draftKey)
      if (payload.lineage) lineageByDraft.set(key, payload.lineage)
      else if (!lineageByDraft.has(key)) lineageByDraft.set(key, null)
    }

    return {
      data: payload.data,
      name: entry.name,
      isTemporary: entry.isTemporary,
      updatedAt: payload.updatedAt,
      isModified:
        typeof payload.isModified === 'boolean'
          ? payload.isModified
          : entry.isModified,
      lineage: payload.lineage
    }
  }

  function setLineage(path: string, lineage: DraftLineage): void {
    const workspaceId = currentWorkspaceId()
    const draftKey = hashPath(path)
    lineageByDraft.set(lineageKey(workspaceId, draftKey), lineage)
    const payload = readPayload(workspaceId, draftKey)
    if (
      payload &&
      (payload.lineage?.workflowId !== lineage.workflowId ||
        payload.lineage.lineageSeq !== lineage.lineageSeq)
    )
      writePayload(workspaceId, draftKey, { ...payload, lineage })
  }

  /**
   * Marks a draft as recently used without rewriting its payload.
   */
  function markDraftUsed(path: string): void {
    const index = loadIndex()
    const entry = getEntryByPath(index, path)
    if (!entry) return

    const draftKey = hashPath(path)
    persistIndex({
      ...index,
      updatedAt: Date.now(),
      order: touchOrder(index.order, draftKey)
    })
  }

  /**
   * Gets the most recent draft path.
   */
  function getMostRecentPath(): string | null {
    const index = loadIndex()
    const key = getMostRecentKey(index)
    if (!key) return null

    return getIndexEntry(index, key)?.path ?? null
  }

  /**
   * Tries to load workflow data into the graph.
   */
  async function tryLoadGraph(
    payload: string | null,
    workflowName: string | null,
    isCurrent?: () => boolean,
    onFailure?: () => void
  ): Promise<boolean> {
    if (!payload) return false
    try {
      const workflow = JSON.parse(payload)
      if (isCurrent?.() === false) return false
      await useApp().loadGraphData(workflow, true, true, workflowName)
      return true
    } catch (err) {
      console.error('Failed to load persisted workflow', err)
      onFailure?.()
      return false
    }
  }

  async function loadDraft(
    path: string,
    isCurrent?: () => boolean
  ): Promise<boolean> {
    const draft = getDraft(path)
    if (!draft) return false

    const loaded = await tryLoadGraph(draft.data, draft.name, isCurrent, () => {
      removeDraft(path)
    })
    if (loaded) {
      markDraftUsed(path)
    }

    return loaded
  }

  async function loadPersistedWorkflow(
    options: LoadPersistedWorkflowOptions
  ): Promise<boolean> {
    const { preferredPath, fallbackToLatestDraft = false, isCurrent } = options

    if (preferredPath && (await loadDraft(preferredPath, isCurrent))) {
      return true
    }

    if (fallbackToLatestDraft && isCurrent?.() !== false) {
      const mostRecent = getMostRecentPath()
      if (mostRecent && (await loadDraft(mostRecent, isCurrent))) {
        return true
      }
    }

    return false
  }

  /**
   * Resets the store (clears in-memory cache for current workspace).
   */
  function reset(): void {
    const workspaceId = currentWorkspaceId()
    delete indexCacheByWorkspace.value[workspaceId]
    saveFailureNotified = false
    for (const key of lineageByDraft.keys()) {
      if (key.startsWith(`${workspaceId}:`)) lineageByDraft.delete(key)
    }
    for (const key of reportedQuotaByDraft) {
      if (key.startsWith(`${workspaceId}:`)) reportedQuotaByDraft.delete(key)
    }
  }

  return {
    setAuthSubject,
    getScope: currentWorkspaceId,
    saveDraft,
    removeDraft,
    moveDraft,
    markDraftUsed,
    getDraft,
    setLineage,
    getMostRecentPath,
    loadPersistedWorkflow,
    reset,
    shouldNotifySaveFailure,
    markSaveSucceeded,
    pausePersistence,
    isPersistencePaused
  }
})
