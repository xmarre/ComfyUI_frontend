from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# storageIO.ts: keep the workspace-transition write fence, remove the sticky
# quota/unavailable latch. A quota failure must be retryable on the next save,
# and reads must never disappear just because a prior write failed.
# ---------------------------------------------------------------------------
path = Path('src/platform/workflow/persistence/base/storageIO.ts')
text = path.read_text()
text = replace_once(
    text,
    """/** Flag indicating if storage is available */
let storageAvailable = true
let workflowWritesBlocked = false
""",
    """let workflowWritesBlocked = false
""",
    'storage state declaration',
)
text = replace_once(
    text,
    """export function isStorageAvailable(): boolean {
  return storageAvailable && !workflowWritesBlocked
}

export function markStorageUnavailable(): void {
  storageAvailable = false
}
""",
    """export function isStorageAvailable(): boolean {
  return !workflowWritesBlocked
}
""",
    'storage availability API',
)
for label, old in [
    ('readIndex availability guard', '  if (!storageAvailable) return null\n\n'),
    ('readPayload availability guard', '  if (!storageAvailable) return null\n\n'),
    ('getPayloadKeys availability guard', '  if (!storageAvailable) return []\n\n'),
]:
    text = replace_once(text, old, '', label)
text = text.replace(
    '  if (!storageAvailable || workflowWritesBlocked) return false\n',
    '  if (workflowWritesBlocked) return false\n',
)
if text.count('if (workflowWritesBlocked) return false') != 2:
    raise RuntimeError('expected writeIndex and writePayload write-fence guards')
text = replace_once(
    text,
    '  if (!storageAvailable || workflowWritesBlocked) return\n',
    '  if (workflowWritesBlocked) return\n',
    'pointer write fence',
)
if 'storageAvailable' in text:
    raise RuntimeError('sticky storageAvailable references remain')
path.write_text(text)


# ---------------------------------------------------------------------------
# storageIO.test.ts: the permanent-unavailable latch no longer exists. Existing
# tests already exercise the independent workspace-transition write fence.
# ---------------------------------------------------------------------------
path = Path('src/platform/workflow/persistence/base/storageIO.test.ts')
text = path.read_text()
text = replace_once(
    text,
    '  markStorageUnavailable,\n',
    '',
    'remove markStorageUnavailable import',
)
text = replace_once(
    text,
    """    it('clears persisted workflows after storage writes are disabled', () => {
      localStorage.setItem('Comfy.Workflow.LastActivePath:personal', '{}')
      sessionStorage.setItem('Comfy.Workflow.ActivePath:client-1', '{}')
      markStorageUnavailable()

      clearAllWorkflowStorage()

      expect(
        localStorage.getItem('Comfy.Workflow.LastActivePath:personal')
      ).toBeNull()
      expect(
        sessionStorage.getItem('Comfy.Workflow.ActivePath:client-1')
      ).toBeNull()
    })
""",
    '',
    'remove obsolete permanent-unavailable cleanup test',
)
path.write_text(text)


# ---------------------------------------------------------------------------
# workflowDraftStoreV2.ts: make save/eviction failure data-preserving.
# - Persist index before deleting normal LRU evictions.
# - Restore the prior target payload if an index commit fails.
# - During quota eviction, snapshot evicted payloads and roll them back if the
#   incoming draft can never be committed.
# - Strip stale order keys instead of aborting quota recovery.
# - Never permanently disable storage after one quota failure.
# ---------------------------------------------------------------------------
path = Path('src/platform/workflow/persistence/stores/workflowDraftStoreV2.ts')
text = path.read_text()
text = replace_once(
    text,
    "import type { DraftIndexV2 } from '../base/draftTypes'",
    "import type { DraftIndexV2, DraftPayloadV2 } from '../base/draftTypes'",
    'draft payload type import',
)
text = replace_once(
    text,
    '  markStorageUnavailable,\n',
    '',
    'remove markStorageUnavailable import',
)
old_save = """  function saveDraft(path: string, data: string, meta: DraftMeta): boolean {
    if (!isStorageAvailable()) return false

    const workspaceId = currentWorkspaceId()
    const draftKey = hashPath(path)
    const now = Date.now()

    // Prime the index cache before writing payload.
    // loadIndex() runs orphan cleanup on cache miss, which would
    // delete a payload written before the index is updated.
    const index = loadIndex()

    // Write payload before persisting the updated index
    const payloadWritten = writePayload(workspaceId, draftKey, {
      data,
      updatedAt: now
    })

    if (!payloadWritten) {
      // Quota exceeded - try eviction loop
      return handleQuotaExceeded(path, data, meta)
    }
    const { index: newIndex, evicted } = upsertEntry(
      index,
      path,
      { ...meta, updatedAt: now },
      MAX_DRAFTS
    )

    // Delete evicted payloads
    deletePayloads(workspaceId, evicted)

    // Persist index
    if (!persistIndex(newIndex)) {
      // Index write failed - try to recover
      deletePayload(workspaceId, draftKey)
      return false
    }

    return true
  }

  /**
   * Handles quota exceeded by evicting oldest drafts until write succeeds.
   */
  function handleQuotaExceeded(
    path: string,
    data: string,
    meta: DraftMeta
  ): boolean {
    const workspaceId = currentWorkspaceId()
    const index = loadIndex()
    const draftKey = hashPath(path)

    // Try evicting oldest entries until we can write
    let currentIndex = index
    while (currentIndex.order.length > 0) {
      const oldestKey = currentIndex.order.find((key) => key !== draftKey)
      if (!oldestKey) break // Only the target draft remains

      // Evict oldest
      const oldestEntry = Object.values(currentIndex.entries).find(
        (e) => hashPath(e.path) === oldestKey
      )
      if (!oldestEntry) break

      const result = removeEntry(currentIndex, oldestEntry.path)
      currentIndex = result.index
      if (result.removedKey) {
        deletePayload(workspaceId, result.removedKey)
      }

      // Try writing again
      const success = writePayload(workspaceId, draftKey, {
        data,
        updatedAt: Date.now()
      })

      if (success) {
        // Update index with the new entry
        const { index: finalIndex } = upsertEntry(
          currentIndex,
          path,
          { ...meta, updatedAt: Date.now() },
          MAX_DRAFTS
        )
        if (!persistIndex(finalIndex)) {
          deletePayload(workspaceId, draftKey)
          return false
        }
        return true
      }
    }

    // All evictions failed - mark storage as unavailable
    markStorageUnavailable()
    return false
  }
"""
new_save = """  function saveDraft(path: string, data: string, meta: DraftMeta): boolean {
    if (!isStorageAvailable()) return false

    const workspaceId = currentWorkspaceId()
    const draftKey = hashPath(path)
    const now = Date.now()

    // Prime the index cache before writing payload.
    // loadIndex() runs orphan cleanup on cache miss, which would
    // delete a payload written before the index is updated.
    const index = loadIndex()
    const previousPayload = readPayload(workspaceId, draftKey)

    // Write payload before persisting the updated index.
    const payloadWritten = writePayload(workspaceId, draftKey, {
      data,
      updatedAt: now
    })

    if (!payloadWritten) {
      return handleQuotaExceeded(path, data, meta, previousPayload)
    }

    const { index: newIndex, evicted } = upsertEntry(
      index,
      path,
      { ...meta, updatedAt: now },
      MAX_DRAFTS
    )

    // Commit index ownership before deleting LRU payloads. If the index write
    // fails, the previous payload/index pair remains recoverable.
    if (!persistIndex(newIndex)) {
      restoreTargetPayload(workspaceId, draftKey, previousPayload)
      indexCacheByWorkspace.value[workspaceId] = index
      return false
    }

    deletePayloads(workspaceId, evicted)
    return true
  }

  function restoreTargetPayload(
    workspaceId: string,
    draftKey: string,
    previousPayload: DraftPayloadV2 | null
  ): void {
    if (previousPayload) {
      writePayload(workspaceId, draftKey, previousPayload)
    } else {
      deletePayload(workspaceId, draftKey)
    }
  }

  function stripOrderKey(index: DraftIndexV2, draftKey: string): DraftIndexV2 {
    return {
      ...index,
      updatedAt: Date.now(),
      order: index.order.filter((key) => key !== draftKey)
    }
  }

  function rollbackQuotaEvictions(
    workspaceId: string,
    originalIndex: DraftIndexV2,
    evictedPayloads: Map<string, DraftPayloadV2>
  ): void {
    for (const [draftKey, payload] of evictedPayloads) {
      if (!readPayload(workspaceId, draftKey)) {
        writePayload(workspaceId, draftKey, payload)
      }
    }

    // If an external writer changed storage during recovery, never recreate an
    // index entry whose payload could not be restored.
    const payloadKeys = new Set(getPayloadKeys(workspaceId))
    const recoveredIndex = removeOrphanedEntries(originalIndex, payloadKeys)
    indexCacheByWorkspace.value[workspaceId] = recoveredIndex
    writeIndex(workspaceId, recoveredIndex)
  }

  /**
   * Handles quota exceeded by evicting oldest drafts until write succeeds.
   * Evictions are rolled back if the incoming draft cannot be committed.
   */
  function handleQuotaExceeded(
    path: string,
    data: string,
    meta: DraftMeta,
    previousPayload: DraftPayloadV2 | null
  ): boolean {
    const workspaceId = currentWorkspaceId()
    const originalIndex = loadIndex()
    const draftKey = hashPath(path)
    const evictedPayloads = new Map<string, DraftPayloadV2>()

    let currentIndex = originalIndex
    while (currentIndex.order.length > 0) {
      const oldestKey = currentIndex.order.find((key) => key !== draftKey)
      if (!oldestKey) break

      const oldestEntry = currentIndex.entries[oldestKey]
      if (!oldestEntry) {
        const cleanedIndex = stripOrderKey(currentIndex, oldestKey)
        if (!persistIndex(cleanedIndex)) {
          indexCacheByWorkspace.value[workspaceId] = originalIndex
          return false
        }
        currentIndex = cleanedIndex
        continue
      }

      const oldestPayload = readPayload(workspaceId, oldestKey)
      const result = removeEntry(currentIndex, oldestEntry.path)
      if (!result.removedKey) {
        const cleanedIndex = stripOrderKey(currentIndex, oldestKey)
        if (!persistIndex(cleanedIndex)) {
          indexCacheByWorkspace.value[workspaceId] = originalIndex
          return false
        }
        currentIndex = cleanedIndex
        continue
      }

      // Make the index stop owning this payload before deleting it. This keeps
      // index/payload invariants recoverable even if the page dies mid-retry.
      if (!persistIndex(result.index)) {
        indexCacheByWorkspace.value[workspaceId] = originalIndex
        return false
      }
      currentIndex = result.index

      if (oldestPayload) {
        evictedPayloads.set(result.removedKey, oldestPayload)
      }
      deletePayload(workspaceId, result.removedKey)

      const now = Date.now()
      if (writePayload(workspaceId, draftKey, { data, updatedAt: now })) {
        const { index: finalIndex } = upsertEntry(
          currentIndex,
          path,
          { ...meta, updatedAt: now },
          MAX_DRAFTS
        )
        if (persistIndex(finalIndex)) return true

        restoreTargetPayload(workspaceId, draftKey, previousPayload)
        rollbackQuotaEvictions(workspaceId, originalIndex, evictedPayloads)
        return false
      }
    }

    rollbackQuotaEvictions(workspaceId, originalIndex, evictedPayloads)
    return false
  }
"""
text = replace_once(text, old_save, new_save, 'save/quota transaction')
if 'markStorageUnavailable' in text:
    raise RuntimeError('markStorageUnavailable reference remains')
path.write_text(text)


# ---------------------------------------------------------------------------
# Add focused red/green regression coverage. The fake storage can fail writes
# to selected keys while still allowing index compaction and rollback, which
# reproduces quota behavior deterministically without depending on browser quota.
# ---------------------------------------------------------------------------
Path('src/platform/workflow/persistence/stores/workflowDraftStoreV2.quotaSafety.test.ts').write_text(
    r'''import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_DRAFTS } from '../base/draftTypes'
import { StorageKeys } from '../base/storageKeys'

vi.mock('@/scripts/api', () => ({
  api: {
    clientId: 'test-client',
    initialClientId: 'test-client'
  }
}))

vi.mock('@/scripts/app', () => ({
  app: {
    loadGraphData: vi.fn().mockResolvedValue(undefined)
  }
}))

class FakeStorage implements Storage {
  readonly map = new Map<string, string>()
  shouldFailWrite: (key: string, value: string) => boolean = () => false

  get length(): number {
    return this.map.size
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.shouldFailWrite(key, value)) {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}

let fakeStorage: FakeStorage
let realLocalStorage: Storage

async function freshStore() {
  vi.resetModules()
  const { useWorkflowDraftStoreV2 } = await import('./workflowDraftStoreV2')
  return useWorkflowDraftStoreV2()
}

describe('workflowDraftStoreV2 quota safety', () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    realLocalStorage = globalThis.localStorage
    fakeStorage = new FakeStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: fakeStorage,
      configurable: true,
      writable: true
    })
    sessionStorage.clear()
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: realLocalStorage,
      configurable: true,
      writable: true
    })
    localStorage.clear()
    sessionStorage.clear()
  })

  it('restores existing draft history when an incoming draft can never fit', async () => {
    const store = await freshStore()
    expect(
      store.saveDraft('workflows/a.json', '{"id":"a"}', {
        name: 'a',
        isTemporary: false
      })
    ).toBe(true)
    expect(
      store.saveDraft('workflows/b.json', '{"id":"b"}', {
        name: 'b',
        isTemporary: false
      })
    ).toBe(true)

    const targetKey = StorageKeys.draftPayload(
      'workflows/too-large.json',
      'personal'
    )
    fakeStorage.shouldFailWrite = (key) => key === targetKey

    expect(
      store.saveDraft('workflows/too-large.json', 'x'.repeat(1024), {
        name: 'too-large',
        isTemporary: false
      })
    ).toBe(false)

    expect(store.getDraft('workflows/a.json')?.data).toBe('{"id":"a"}')
    expect(store.getDraft('workflows/b.json')?.data).toBe('{"id":"b"}')
    expect(store.getDraft('workflows/too-large.json')).toBeNull()
  })

  it('persists again after a transient quota failure without reloading', async () => {
    const store = await freshStore()
    const failingKey = StorageKeys.draftPayload(
      'workflows/blocked.json',
      'personal'
    )
    fakeStorage.shouldFailWrite = (key) => key === failingKey

    expect(
      store.saveDraft('workflows/blocked.json', 'x'.repeat(64), {
        name: 'blocked',
        isTemporary: false
      })
    ).toBe(false)

    fakeStorage.shouldFailWrite = () => false

    expect(
      store.saveDraft('workflows/recovered.json', '{"nodes":[]}', {
        name: 'recovered',
        isTemporary: true
      })
    ).toBe(true)
    expect(store.getDraft('workflows/recovered.json')?.data).toBe(
      '{"nodes":[]}'
    )
  })

  it('restores the previous payload when an index update hits quota', async () => {
    const store = await freshStore()
    expect(
      store.saveDraft('workflows/a.json', '{"version":1}', {
        name: 'a',
        isTemporary: false
      })
    ).toBe(true)

    const indexKey = StorageKeys.draftIndex('personal')
    let failNextIndexWrite = true
    fakeStorage.shouldFailWrite = (key) => {
      if (key !== indexKey || !failNextIndexWrite) return false
      failNextIndexWrite = false
      return true
    }

    expect(
      store.saveDraft('workflows/a.json', '{"version":2}', {
        name: 'a',
        isTemporary: false
      })
    ).toBe(false)

    expect(store.getDraft('workflows/a.json')?.data).toBe('{"version":1}')
  })

  it('does not delete an LRU draft before the replacement index commits', async () => {
    const store = await freshStore()
    for (let i = 0; i < MAX_DRAFTS; i++) {
      expect(
        store.saveDraft(`workflows/draft${i}.json`, `{"id":${i}}`, {
          name: `draft${i}`,
          isTemporary: false
        })
      ).toBe(true)
    }

    const indexKey = StorageKeys.draftIndex('personal')
    let failNextIndexWrite = true
    fakeStorage.shouldFailWrite = (key) => {
      if (key !== indexKey || !failNextIndexWrite) return false
      failNextIndexWrite = false
      return true
    }

    expect(
      store.saveDraft('workflows/new.json', '{"id":"new"}', {
        name: 'new',
        isTemporary: false
      })
    ).toBe(false)

    expect(store.getDraft('workflows/draft0.json')?.data).toBe('{"id":0}')
    expect(store.getDraft('workflows/new.json')).toBeNull()
  })
})
'''
)
