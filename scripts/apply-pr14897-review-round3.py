from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}")
    file.write_text(text.replace(old, new, 1))


migration = "src/platform/workflow/persistence/migration/migrateV1toV2.ts"
replace_once(
    migration,
    """  for (const { draftsKey, orderKey } of v1KeyPairs(workspaceId)) {
    const rawDrafts = localStorage.getItem(draftsKey)
    if (rawDrafts === null) continue

    const rawOrder = localStorage.getItem(orderKey)
    try {
""",
    """  for (const { draftsKey, orderKey } of v1KeyPairs(workspaceId)) {
    let rawDrafts: string | null
    let rawOrder: string | null
    try {
      rawDrafts = localStorage.getItem(draftsKey)
      if (rawDrafts === null) continue
      rawOrder = localStorage.getItem(orderKey)
    } catch {
      hasMalformedSource = true
      continue
    }

    try {
""",
)
replace_once(
    migration,
    """function hasLegacyDraftStorage(workspaceId: string): boolean {
  return v1KeyPairs(workspaceId).some(
    ({ draftsKey }) => localStorage.getItem(draftsKey) !== null
  )
}
""",
    """function hasLegacyDraftStorage(workspaceId: string): boolean {
  try {
    return v1KeyPairs(workspaceId).some(
      ({ draftsKey }) => localStorage.getItem(draftsKey) !== null
    )
  } catch {
    return false
  }
}
""",
)
replace_once(
    migration,
    """  for (const draftKey of finalIndex.order) {
    const currentPayload = readPayload(workspaceId, draftKey)
    const data = currentPayload?.data ?? payloadsToWrite.get(draftKey)?.data
    if (data === legacyWorkflow) {
      return { key: 'workflow', value: legacyWorkflow }
    }
  }
""",
    """  for (const draftKey of finalIndex.order) {
    // Staged migration payloads are already available as parsed snapshots.
    // Check them before touching localStorage so quota-recovery candidates do
    // not get parsed again during the legacy-singleton redundancy scan.
    const pendingPayload = payloadsToWrite.get(draftKey)
    if (pendingPayload) {
      if (pendingPayload.data === legacyWorkflow) {
        return { key: 'workflow', value: legacyWorkflow }
      }
      continue
    }

    const currentPayload = readPayload(workspaceId, draftKey)
    if (currentPayload?.data === legacyWorkflow) {
      return { key: 'workflow', value: legacyWorkflow }
    }
  }
""",
)
replace_once(
    migration,
    """ * @returns Number of V1 payloads recovered into V2, 0 for an empty migration,
 * or -1 when no migration is needed or recovery could not be committed.
""",
    """ * @returns Number of V1 payloads recovered into V2, 0 for an empty migration,
 * or -1 for a non-mutating outcome. The -1 result intentionally covers both a
 * healthy no-op and a preserved-data recovery failure: the only current caller
 * needs to know whether V2 storage changed so it can invalidate its cache.
 * Failed recovery keeps legacy data in place and is retried on the next
 * persistence initialization.
""",
)

storage_io = "src/platform/workflow/persistence/base/storageIO.ts"
replace_once(
    storage_io,
    """/**
 * Reads a draft payload from localStorage.
 */
export function readPayload(
  workspaceId: string,
  draftKey: string
): DraftPayloadV2 | null {
  try {
    const key = `${StorageKeys.prefixes.draftPayload}${workspaceId}:${draftKey}`
    const json = localStorage.getItem(key)
    if (!json) return null

    return JSON.parse(json) as DraftPayloadV2
  } catch {
    return null
  }
}

/**
 * Writes a draft payload to localStorage.
 */
export function writePayload(
  workspaceId: string,
  draftKey: string,
  payload: DraftPayloadV2
): boolean {
  if (workflowWritesBlocked) return false

  try {
    const key = `${StorageKeys.prefixes.draftPayload}${workspaceId}:${draftKey}`
    localStorage.setItem(key, JSON.stringify(payload))
    return true
  } catch (error) {
    if (isQuotaExceeded(error)) return false
    throw error
  }
}
""",
    """function draftPayloadStorageKey(workspaceId: string, draftKey: string): string {
  return `${StorageKeys.prefixes.draftPayload}${workspaceId}:${draftKey}`
}

/** Reads the exact serialized draft payload without parsing workflow data. */
export function readPayloadRaw(
  workspaceId: string,
  draftKey: string
): string | null {
  try {
    return localStorage.getItem(draftPayloadStorageKey(workspaceId, draftKey))
  } catch {
    return null
  }
}

/** Writes an exact serialized draft payload. Used for lossless rollback. */
export function writePayloadRaw(
  workspaceId: string,
  draftKey: string,
  serializedPayload: string
): boolean {
  if (workflowWritesBlocked) return false

  try {
    localStorage.setItem(
      draftPayloadStorageKey(workspaceId, draftKey),
      serializedPayload
    )
    return true
  } catch (error) {
    if (isQuotaExceeded(error)) return false
    throw error
  }
}

/**
 * Reads a draft payload from localStorage.
 */
export function readPayload(
  workspaceId: string,
  draftKey: string
): DraftPayloadV2 | null {
  const json = readPayloadRaw(workspaceId, draftKey)
  if (json === null) return null

  try {
    return JSON.parse(json) as DraftPayloadV2
  } catch {
    return null
  }
}

/**
 * Writes a draft payload to localStorage.
 */
export function writePayload(
  workspaceId: string,
  draftKey: string,
  payload: DraftPayloadV2
): boolean {
  return writePayloadRaw(workspaceId, draftKey, JSON.stringify(payload))
}
""",
)

store = "src/platform/workflow/persistence/stores/workflowDraftStoreV2.ts"
replace_once(
    store,
    """  readIndex,
  readPayload,
  writeIndex,
  writePayload
""",
    """  readIndex,
  readPayload,
  readPayloadRaw,
  writeIndex,
  writePayload,
  writePayloadRaw
""",
)
replace_once(
    store,
    """  /**
   * Temporarily suppresses draft writes initiated by graph-load lifecycle hooks.
   * The returned resume function is idempotent and supports nested pauses.
   */
""",
    """  /**
   * Temporarily suppresses draft writes initiated by graph-load lifecycle hooks.
   * This is caller-coordination state rather than a storage mutex: lifecycle
   * callers check isPersistencePaused() before invoking the low-level saveDraft
   * primitive. The returned resume function is idempotent and supports nesting.
   */
""",
)
replace_once(
    store,
    """    const index = loadIndex()
    const previousPayload = readPayload(workspaceId, draftKey)
""",
    """    const index = loadIndex()
    // Rollback only needs the exact previous bytes. Avoid parsing the full
    // serialized workflow on every autosave and preserve malformed bytes too.
    const previousPayload = readPayloadRaw(workspaceId, draftKey)
""",
)
replace_once(
    store,
    """  function restoreTargetPayload(
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
""",
    """  function restoreTargetPayload(
    workspaceId: string,
    draftKey: string,
    previousPayload: string | null
  ): void {
    if (previousPayload !== null) {
      writePayloadRaw(workspaceId, draftKey, previousPayload)
    } else {
      deletePayload(workspaceId, draftKey)
    }
  }
""",
)
replace_once(
    store,
    """  function rollbackQuotaEvictions(
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
""",
    """  function rollbackQuotaEvictions(
    workspaceId: string,
    originalIndex: DraftIndexV2,
    evictedPayloads: Map<string, DraftPayloadV2>
  ): void {
    let payloadRestoreFailed = false
    for (const [draftKey, payload] of evictedPayloads) {
      if (
        !readPayload(workspaceId, draftKey) &&
        !writePayload(workspaceId, draftKey, payload)
      ) {
        payloadRestoreFailed = true
      }
    }

    // If an external writer changed storage during recovery, never recreate an
    // index entry whose payload could not be restored.
    const payloadKeys = new Set(getPayloadKeys(workspaceId))
    const recoveredIndex = removeOrphanedEntries(originalIndex, payloadKeys)
    if (writeIndex(workspaceId, recoveredIndex)) {
      indexCacheByWorkspace.value[workspaceId] = recoveredIndex
      if (payloadRestoreFailed) {
        console.error(
          '[Workflow Drafts] Quota rollback could not restore every evicted payload'
        )
      }
    } else {
      // The durable index is now the source of truth. Keeping recoveredIndex in
      // cache would make drafts appear restored until reload even though its
      // ownership update never reached storage.
      delete indexCacheByWorkspace.value[workspaceId]
      console.error('[Workflow Drafts] Failed to restore draft index after quota rollback')
    }
  }
""",
)
replace_once(
    store,
    """    previousPayload: DraftPayloadV2 | null
  ): boolean {
""",
    """    previousPayload: string | null
  ): boolean {
""",
)
replace_once(
    store,
    """        const { index: finalIndex } = upsertEntry(
          currentIndex,
          path,
          { ...meta, updatedAt: now },
          MAX_DRAFTS
        )
        if (persistIndex(finalIndex)) return true
""",
    """        const { index: finalIndex, evicted } = upsertEntry(
          currentIndex,
          path,
          { ...meta, updatedAt: now },
          MAX_DRAFTS
        )
        if (persistIndex(finalIndex)) {
          deletePayloads(workspaceId, evicted)
          return true
        }
""",
)

migration_test = "src/platform/workflow/persistence/migration/migrateV1toV2.test.ts"
marker = "\n  })\n\n  describe('legacy key compatibility', () => {"
addition = """

    it('degrades safely when localStorage reads are blocked', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('Storage blocked', 'SecurityError')
      })

      expect(migrateV1toV2(personalWorkspace)).toBe(-1)
      expect(isV2MigrationComplete(personalWorkspace)).toBe(false)
      expect(getMigrationStatus(personalWorkspace)).toEqual({
        v1Exists: false,
        v2Exists: false,
        v1DraftCount: 0,
        v2DraftCount: 0
      })
    })
"""
replace_once(migration_test, marker, addition + marker)

store_test = "src/platform/workflow/persistence/stores/workflowDraftStoreV2.test.ts"
replace_once(
    store_test,
    """      store.markSaveSucceeded()
      expect(store.shouldNotifySaveFailure()).toBe(true)
      expect(store.shouldNotifySaveFailure()).toBe(false)
""",
    """      store.markSaveSucceeded()
      expect(store.shouldNotifySaveFailure()).toBe(true)
      expect(store.shouldNotifySaveFailure()).toBe(false)

      store.reset()
      expect(store.shouldNotifySaveFailure()).toBe(true)
""",
)

quota_test = "src/platform/workflow/persistence/stores/workflowDraftStoreV2.quotaSafety.test.ts"
marker = "\n  it('does not delete an LRU draft before the replacement index commits', async () => {"
addition = r'''

  it('restores exact previous payload bytes when an index update fails', async () => {
    const path = 'workflows/raw-rollback.json'
    const draftKey = hashPath(path)
    const indexKey = StorageKeys.draftIndex('personal')
    const payloadKey = StorageKeys.draftPayload(path, 'personal')
    const rawPayload = 'malformed-but-previously-stored-payload'

    fakeStorage.setItem(
      indexKey,
      JSON.stringify({
        v: 2,
        updatedAt: 1,
        order: [draftKey],
        entries: {
          [draftKey]: {
            path,
            name: 'raw-rollback',
            isTemporary: false,
            updatedAt: 1
          }
        }
      })
    )
    fakeStorage.setItem(payloadKey, rawPayload)

    const store = await freshStore()
    let failNextIndexWrite = true
    fakeStorage.shouldFailWrite = (key) => {
      if (key !== indexKey || !failNextIndexWrite) return false
      failNextIndexWrite = false
      return true
    }

    expect(
      store.saveDraft(path, '{"new":true}', {
        name: 'raw-rollback',
        isTemporary: false
      })
    ).toBe(false)
    expect(fakeStorage.getItem(payloadKey)).toBe(rawPayload)
  })

  it('drops a recovered cache when the rollback index itself cannot persist', async () => {
    const store = await freshStore()
    const aPath = 'workflows/a.json'
    const bPath = 'workflows/b.json'
    expect(
      store.saveDraft(aPath, '{"id":"a"}', {
        name: 'a',
        isTemporary: false
      })
    ).toBe(true)
    expect(
      store.saveDraft(bPath, '{"id":"b"}', {
        name: 'b',
        isTemporary: false
      })
    ).toBe(true)

    const aKey = hashPath(aPath)
    const bKey = hashPath(bPath)
    const targetPath = 'workflows/rollback-index-failure.json'
    const targetKey = StorageKeys.draftPayload(targetPath, 'personal')
    const targetDraftKey = hashPath(targetPath)
    const indexKey = StorageKeys.draftIndex('personal')
    let targetWrites = 0
    let rejectedRollbackIndex = false

    fakeStorage.shouldFailWrite = (key, value) => {
      if (key === targetKey) {
        targetWrites++
        return targetWrites === 1
      }
      if (key !== indexKey) return false

      const index = JSON.parse(value) as {
        entries?: Record<string, unknown>
      }
      if (index.entries?.[targetDraftKey]) return true
      if (
        targetWrites > 1 &&
        index.entries?.[aKey] &&
        index.entries?.[bKey] &&
        !rejectedRollbackIndex
      ) {
        rejectedRollbackIndex = true
        return true
      }
      return false
    }

    expect(
      store.saveDraft(targetPath, '{"id":"target"}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(false)
    expect(rejectedRollbackIndex).toBe(true)

    const durableIndex = JSON.parse(fakeStorage.getItem(indexKey)!) as {
      entries: Record<string, unknown>
    }
    expect(durableIndex.entries[aKey]).toBeUndefined()
    expect(durableIndex.entries[bKey]).toBeDefined()

    fakeStorage.shouldFailWrite = () => false
    expect(
      store.saveDraft('workflows/after-rollback.json', '{"id":"after"}', {
        name: 'after',
        isTemporary: false
      })
    ).toBe(true)
    expect(store.getDraft(aPath)).toBeNull()
    expect(store.getDraft(bPath)?.data).toBe('{"id":"b"}')
  })

  it('deletes payloads evicted by the final quota-retry upsert', async () => {
    const paths = Array.from(
      { length: MAX_DRAFTS + 1 },
      (_, index) => `workflows/over-limit-${index}.json`
    )
    const order: string[] = []
    const entries: Record<
      string,
      {
        path: string
        name: string
        isTemporary: boolean
        updatedAt: number
      }
    > = {}
    const indexKey = StorageKeys.draftIndex('personal')

    for (const [index, path] of paths.entries()) {
      const draftKey = hashPath(path)
      order.push(draftKey)
      entries[draftKey] = {
        path,
        name: `over-limit-${index}`,
        isTemporary: false,
        updatedAt: index + 1
      }
      fakeStorage.setItem(
        StorageKeys.draftPayload(path, 'personal'),
        JSON.stringify({ data: `{"id":${index}}`, updatedAt: index + 1 })
      )
    }
    fakeStorage.setItem(
      indexKey,
      JSON.stringify({ v: 2, updatedAt: 1, order, entries })
    )

    const store = await freshStore()
    const targetPath = 'workflows/quota-retry.json'
    const targetPayloadKey = StorageKeys.draftPayload(targetPath, 'personal')
    let targetWrites = 0
    fakeStorage.shouldFailWrite = (key) => {
      if (key !== targetPayloadKey) return false
      targetWrites++
      return targetWrites === 1
    }

    expect(
      store.saveDraft(targetPath, '{"id":"target"}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(true)

    expect(
      fakeStorage.getItem(StorageKeys.draftPayload(paths[0], 'personal'))
    ).toBeNull()
    expect(
      fakeStorage.getItem(StorageKeys.draftPayload(paths[1], 'personal'))
    ).toBeNull()
    const persistedIndex = JSON.parse(fakeStorage.getItem(indexKey)!) as {
      order: string[]
    }
    expect(persistedIndex.order).toHaveLength(MAX_DRAFTS)
    expect(store.getDraft(targetPath)?.data).toBe('{"id":"target"}')
  })
'''
replace_once(quota_test, marker, addition + marker)
