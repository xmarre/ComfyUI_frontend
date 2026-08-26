import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hashPath } from '../base/hashUtil'
import { migrateV1toV2 } from './migrateV1toV2'

class FaultInjectingStorage implements Storage {
  private readonly values = new Map<string, string>()

  constructor(
    source: Storage,
    private readonly writeError: (key: string, value: string) => Error | null,
    private readonly removeError: (key: string) => Error | null
  ) {
    for (let i = 0; i < source.length; i++) {
      const key = source.key(i)
      if (key === null) continue
      const value = source.getItem(key)
      if (value !== null) this.values.set(key, value)
    }
  }

  get length(): number {
    return this.values.size
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    const error = this.writeError(key, value)
    if (error) throw error
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    const error = this.removeError(key)
    if (error) throw error
    this.values.delete(key)
  }

  clear(): void {
    this.values.clear()
  }
}

describe('migrateV1toV2 quota cleanup rollback', () => {
  let originalStorage: Storage

  beforeEach(() => {
    localStorage.clear()
    originalStorage = globalThis.localStorage
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalStorage,
      configurable: true
    })
    localStorage.clear()
  })

  it('restores removed legacy data when removing the order key fails', () => {
    const path = 'workflows/large.json'
    const draftsKey = 'Comfy.Workflow.Drafts'
    const orderKey = 'Comfy.Workflow.DraftOrder'
    const drafts = {
      [path]: {
        data: '{"id":"large"}',
        updatedAt: 1000,
        name: 'large.json',
        isTemporary: true
      }
    }
    const originalDrafts = JSON.stringify(drafts)
    const originalOrder = JSON.stringify([path])
    localStorage.setItem(draftsKey, originalDrafts)
    localStorage.setItem(orderKey, originalOrder)

    const faultStorage = new FaultInjectingStorage(
      localStorage,
      (key) =>
        key.startsWith('Comfy.Workflow.Draft.v2:') &&
        globalThis.localStorage.getItem(draftsKey) !== null
          ? new DOMException('Quota exceeded', 'QuotaExceededError')
          : null,
      (key) => (key === orderKey ? new Error('remove failed') : null)
    )
    Object.defineProperty(globalThis, 'localStorage', {
      value: faultStorage,
      configurable: true
    })

    expect(migrateV1toV2('personal')).toBe(-1)
    expect(localStorage.getItem(draftsKey)).toBe(originalDrafts)
    expect(localStorage.getItem(orderKey)).toBe(originalOrder)
    expect(
      localStorage.getItem(
        `Comfy.Workflow.Draft.v2:personal:${hashPath(path)}`
      )
    ).toBeNull()
  })
})
