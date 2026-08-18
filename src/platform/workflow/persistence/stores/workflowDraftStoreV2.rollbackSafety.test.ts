import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

class FaultInjectingStorage implements Storage {
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

async function freshStore() {
  vi.resetModules()
  const { useWorkflowDraftStoreV2 } = await import('./workflowDraftStoreV2')
  return useWorkflowDraftStoreV2()
}

function quotaError(): DOMException {
  return new DOMException('Quota exceeded', 'QuotaExceededError')
}

describe('workflowDraftStoreV2 rollback safety', () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    realLocalStorage = globalThis.localStorage
    storage = new FaultInjectingStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
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

  it('retries exact target rollback after removing an uncommitted replacement', async () => {
    const store = await freshStore()
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

    let indexFailed = false
    let directRollbackFailed = false
    storage.writeError = (key, value) => {
      if (key === indexKey && !indexFailed) {
        indexFailed = true
        return quotaError()
      }
      if (
        key === payloadKey &&
        indexFailed &&
        value === previousPayload &&
        !directRollbackFailed
      ) {
        directRollbackFailed = true
        return quotaError()
      }
      return null
    }

    expect(
      store.saveDraft(path, '{"version":2}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(false)

    expect(indexFailed).toBe(true)
    expect(directRollbackFailed).toBe(true)
    expect(storage.getItem(payloadKey)).toBe(previousPayload)
    expect(store.getDraft(path)?.data).toBe('{"version":1}')
  })

  it('continues quota rollback after target restoration throws', async () => {
    const store = await freshStore()
    const targetPath = 'workflows/target.json'
    const evictedPath = 'workflows/evicted.json'
    const targetPayloadKey = StorageKeys.draftPayload(targetPath, 'personal')
    const indexKey = StorageKeys.draftIndex('personal')

    expect(
      store.saveDraft(targetPath, '{"version":1}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(true)
    expect(
      store.saveDraft(evictedPath, '{"id":"evicted"}', {
        name: 'evicted',
        isTemporary: false
      })
    ).toBe(true)

    let targetWrites = 0
    let indexWrites = 0
    storage.writeError = (key) => {
      if (key === targetPayloadKey) {
        targetWrites++
        if (targetWrites === 1) return quotaError()
        if (targetWrites === 3) return new Error('rollback interrupted')
      }
      if (key === indexKey) {
        indexWrites++
        if (indexWrites === 2) return quotaError()
      }
      return null
    }

    expect(
      store.saveDraft(targetPath, '{"version":2}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(false)

    expect(targetWrites).toBe(4)
    expect(indexWrites).toBe(3)
    expect(store.getDraft(targetPath)?.data).toBe('{"version":1}')
    expect(store.getDraft(evictedPath)?.data).toBe('{"id":"evicted"}')
  })

  it('drops stale cache state when target rollback cannot be completed', async () => {
    const store = await freshStore()
    const path = 'workflows/unrecoverable-target.json'
    const payloadKey = StorageKeys.draftPayload(path, 'personal')
    const indexKey = StorageKeys.draftIndex('personal')

    expect(
      store.saveDraft(path, '{"version":1}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(true)
    const previousPayload = storage.getItem(payloadKey)!

    let indexFailed = false
    storage.writeError = (key, value) => {
      if (key === indexKey && !indexFailed) {
        indexFailed = true
        return quotaError()
      }
      if (key === payloadKey && indexFailed && value === previousPayload) {
        return quotaError()
      }
      return null
    }

    expect(
      store.saveDraft(path, '{"version":2}', {
        name: 'target',
        isTemporary: false
      })
    ).toBe(false)
    expect(storage.getItem(payloadKey)).toBeNull()

    storage.writeError = () => null
    expect(store.getDraft(path)).toBeNull()
  })
})
