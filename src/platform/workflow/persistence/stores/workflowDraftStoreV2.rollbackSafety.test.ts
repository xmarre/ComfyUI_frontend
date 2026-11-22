import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetStorageAvailable } from '@/platform/workflow/persistence/base/storageIO'
import { StorageKeys } from '@/platform/workflow/persistence/base/storageKeys'
import { useWorkflowDraftStoreV2 } from './workflowDraftStoreV2'

vi.mock<unknown>(import('@/scripts/api'), () => ({
  api: {
    clientId: 'test-client',
    initialClientId: 'test-client'
  }
}))

vi.mock<unknown>(import('@/scripts/app'), () => ({
  app: {
    loadGraphData: vi.fn().mockResolvedValue(undefined)
  }
}))

class FaultInjectingStorage implements Storage {
  [key: string]: unknown

  readonly map = new Map<string, string>()
  writeError: (key: string, value: string) => Error | null = () => null

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
    const error = this.writeError(key, value)
    if (error) throw error
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}

let storage: FaultInjectingStorage
let realLocalStorage: Storage

function quotaError(): DOMException {
  return new DOMException('Quota exceeded', 'QuotaExceededError')
}

describe('workflowDraftStoreV2 overwrite and rollback safety', () => {
  beforeEach(() => {
    realLocalStorage = globalThis.localStorage
    storage = new FaultInjectingStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true
    })
    sessionStorage.clear()
    resetStorageAvailable()
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

  it('does not read the existing workflow payload on a successful overwrite', async () => {
    const store = useWorkflowDraftStoreV2()
    const path = 'workflows/target.json'
    const payloadKey = StorageKeys.draftPayload(path, 'personal')

    expect(
      store.saveDraft(path, '{"version":1}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(true)

    const getItemSpy = vi.spyOn(storage, 'getItem')
    getItemSpy.mockClear()

    expect(
      store.saveDraft(path, '{"version":2}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(true)

    expect(getItemSpy).not.toHaveBeenCalledWith(payloadKey)
    expect(store.getDraft(path)?.data).toBe('{"version":2}')
  })

  it('preserves the prior CRDT lineage after a cold-cache overwrite', () => {
    const store = useWorkflowDraftStoreV2()
    const path = 'workflows/lineage-target.json'
    const meta = { name: 'lineage-target', isTemporary: false }
    const lineage = { workflowId: 'workflow-identity', lineageSeq: 7 }

    expect(store.saveDraft(path, '{"version":1}', meta)).toBe(true)
    store.setLineage(path, lineage)
    store.reset()

    expect(store.saveDraft(path, '{"version":2}', meta)).toBe(true)
    expect(store.getDraft(path)).toMatchObject({
      data: '{"version":2}',
      lineage
    })

    const payloadKey = StorageKeys.draftPayload(path, 'personal')
    const getItemSpy = vi.spyOn(storage, 'getItem')
    getItemSpy.mockClear()
    expect(store.saveDraft(path, '{"version":3}', meta)).toBe(true)
    expect(getItemSpy).not.toHaveBeenCalledWith(payloadKey)
  })

  it('leaves the committed payload untouched when the metadata write fails', async () => {
    const store = useWorkflowDraftStoreV2()
    const path = 'workflows/target.json'
    const payloadKey = StorageKeys.draftPayload(path, 'personal')
    const indexKey = StorageKeys.draftIndex('personal')

    expect(
      store.saveDraft(path, '{"version":1}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(true)
    const previousPayload = storage.getItem(payloadKey)!

    storage.writeError = (key) => (key === indexKey ? quotaError() : null)

    expect(
      store.saveDraft(path, '{"version":2}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(false)

    expect(storage.getItem(payloadKey)).toBe(previousPayload)
    storage.writeError = () => null
    expect(store.getDraft(path)?.data).toBe('{"version":1}')
  })

  it('keeps the old payload recoverable if restoring metadata after quota failure also fails', async () => {
    const store = useWorkflowDraftStoreV2()
    const path = 'workflows/target.json'
    const payloadKey = StorageKeys.draftPayload(path, 'personal')
    const indexKey = StorageKeys.draftIndex('personal')

    expect(
      store.saveDraft(path, '{"version":1}', {
        name: 'target',
        isTemporary: false,
        isModified: true
      })
    ).toBe(true)
    const previousPayload = storage.getItem(payloadKey)!

    let payloadWrites = 0
    let indexWrites = 0
    storage.writeError = (key) => {
      if (key === indexKey) {
        indexWrites++
        if (indexWrites === 2) return quotaError()
      }
      if (key === payloadKey) {
        payloadWrites++
        if (payloadWrites === 1) return quotaError()
      }
      return null
    }

    expect(
      store.saveDraft(path, '{"version":2}', {
        name: 'target',
        isTemporary: false,
        isModified: false
      })
    ).toBe(false)

    expect(payloadWrites).toBeGreaterThan(0)
    expect(indexWrites).toBeGreaterThan(1)
    expect(storage.getItem(payloadKey)).toBe(previousPayload)

    storage.writeError = () => null
    expect(store.getDraft(path)).toMatchObject({
      data: '{"version":1}',
      isModified: true
    })
  })

  it('refuses an indexed overwrite without deleting other drafts and retries later', () => {
    const store = useWorkflowDraftStoreV2()
    const meta = { name: 'target', isTemporary: false }
    expect(
      store.saveDraft('workflows/other.json', '{"id":"other"}', meta)
    ).toBe(true)
    expect(
      store.saveDraft('workflows/target.json', '{"id":"old"}', meta)
    ).toBe(true)
    const before = new Map(storage.map)
    const key = StorageKeys.draftPayload('workflows/target.json', 'personal')
    storage.writeError = (path) => (path === key ? quotaError() : null)
    expect(
      store.saveDraft('workflows/target.json', '{"id":"new"}', meta)
    ).toBe(false)
    expect(storage.map).toEqual(before)
    storage.writeError = () => null
    expect(
      store.saveDraft('workflows/target.json', '{"id":"new"}', meta)
    ).toBe(true)
    expect(store.getDraft('workflows/other.json')?.data).toBe('{"id":"other"}')
  })

  it('restores exact orphan bytes when a fresh-index checkpoint fails', () => {
    const store = useWorkflowDraftStoreV2()
    const meta = { name: 'target', isTemporary: false }
    expect(store.saveDraft('workflows/other.json', '{}', meta)).toBe(true)
    const path = 'workflows/target.json'
    const key = StorageKeys.draftPayload(path, 'personal')
    const original = '{ "data": "{}", "updatedAt": 1 }'
    storage.setItem(key, original)
    const before = new Map(storage.map)
    storage.writeError = (path) =>
      path === StorageKeys.draftIndex('personal') ? quotaError() : null
    expect(
      store.saveDraft(path, '{"id":"new"}', meta, { evict: false })
    ).toBe(false)
    expect(storage.map).toEqual(before)
  })
})
