import { createTestingPinia } from '@pinia/testing'
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
