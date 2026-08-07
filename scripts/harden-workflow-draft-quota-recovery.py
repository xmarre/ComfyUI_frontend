from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


path = Path('src/platform/workflow/persistence/stores/workflowDraftStoreV2.ts')
text = path.read_text()
text = replace_once(
    text,
    """        if (!persistIndex(cleanedIndex)) {
          indexCacheByWorkspace.value[workspaceId] = originalIndex
          return false
        }
""",
    """        if (!persistIndex(cleanedIndex)) {
          rollbackQuotaEvictions(workspaceId, originalIndex, evictedPayloads)
          return false
        }
""",
    'stale-order rollback',
)
text = replace_once(
    text,
    """        if (!persistIndex(cleanedIndex)) {
          indexCacheByWorkspace.value[workspaceId] = originalIndex
          return false
        }
""",
    """        if (!persistIndex(cleanedIndex)) {
          rollbackQuotaEvictions(workspaceId, originalIndex, evictedPayloads)
          return false
        }
""",
    'removeEntry fallback rollback',
)
text = replace_once(
    text,
    """      if (!persistIndex(result.index)) {
        indexCacheByWorkspace.value[workspaceId] = originalIndex
        return false
      }
""",
    """      if (!persistIndex(result.index)) {
        rollbackQuotaEvictions(workspaceId, originalIndex, evictedPayloads)
        return false
      }
""",
    'eviction index rollback',
)
path.write_text(text)


path = Path(
    'src/platform/workflow/persistence/stores/workflowDraftStoreV2.quotaSafety.test.ts'
)
text = path.read_text()
text = replace_once(
    text,
    "import { MAX_DRAFTS } from '../base/draftTypes'\n",
    "import { MAX_DRAFTS } from '../base/draftTypes'\nimport { hashPath } from '../base/hashUtil'\n",
    'hashPath test import',
)
marker = """  it('does not delete an LRU draft before the replacement index commits', async () => {
"""
new_tests = """  it('restores prior evictions when a later eviction-index write fails', async () => {
    const store = await freshStore()
    expect(
      store.saveDraft('workflows/a.json', '{\"id\":\"a\"}', {
        name: 'a',
        isTemporary: false
      })
    ).toBe(true)
    expect(
      store.saveDraft('workflows/b.json', '{\"id\":\"b\"}', {
        name: 'b',
        isTemporary: false
      })
    ).toBe(true)

    const targetKey = StorageKeys.draftPayload(
      'workflows/incoming.json',
      'personal'
    )
    const indexKey = StorageKeys.draftIndex('personal')
    let targetAttempts = 0
    let evictionIndexWrites = 0
    fakeStorage.shouldFailWrite = (key) => {
      if (key === targetKey) {
        targetAttempts++
        return true
      }
      if (key === indexKey) {
        evictionIndexWrites++
        return evictionIndexWrites === 2
      }
      return false
    }

    expect(
      store.saveDraft('workflows/incoming.json', 'x'.repeat(1024), {
        name: 'incoming',
        isTemporary: false
      })
    ).toBe(false)

    expect(targetAttempts).toBeGreaterThan(1)
    expect(store.getDraft('workflows/a.json')?.data).toBe('{\"id\":\"a\"}')
    expect(store.getDraft('workflows/b.json')?.data).toBe('{\"id\":\"b\"}')
    expect(store.getDraft('workflows/incoming.json')).toBeNull()
  })

  it('restores prior evictions when the final incoming index cannot commit', async () => {
    const store = await freshStore()
    expect(
      store.saveDraft('workflows/a.json', '{\"id\":\"a\"}', {
        name: 'a',
        isTemporary: false
      })
    ).toBe(true)
    expect(
      store.saveDraft('workflows/b.json', '{\"id\":\"b\"}', {
        name: 'b',
        isTemporary: false
      })
    ).toBe(true)

    const targetPath = 'workflows/incoming.json'
    const targetKey = StorageKeys.draftPayload(targetPath, 'personal')
    const targetDraftKey = hashPath(targetPath)
    const indexKey = StorageKeys.draftIndex('personal')
    let targetWrites = 0
    fakeStorage.shouldFailWrite = (key, value) => {
      if (key === targetKey) {
        targetWrites++
        return targetWrites === 1
      }
      if (key === indexKey) {
        const index = JSON.parse(value) as {
          entries?: Record<string, unknown>
        }
        return Boolean(index.entries?.[targetDraftKey])
      }
      return false
    }

    expect(
      store.saveDraft(targetPath, '{\"id\":\"incoming\"}', {
        name: 'incoming',
        isTemporary: false
      })
    ).toBe(false)

    expect(targetWrites).toBeGreaterThan(1)
    expect(store.getDraft('workflows/a.json')?.data).toBe('{\"id\":\"a\"}')
    expect(store.getDraft('workflows/b.json')?.data).toBe('{\"id\":\"b\"}')
    expect(store.getDraft(targetPath)).toBeNull()
  })

"""
text = replace_once(text, marker, new_tests + marker, 'quota rollback tests')
path.write_text(text)
