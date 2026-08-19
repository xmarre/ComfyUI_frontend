import { describe, expect, it } from 'vitest'

import { useWorkflowDraftStoreV2 } from './workflowDraftStoreV2'

describe('workflowDraftStoreV2 persistence control', () => {
  it('supports nested idempotent persistence pauses', () => {
    const store = useWorkflowDraftStoreV2()
    const resumeOuter = store.pausePersistence()
    const resumeInner = store.pausePersistence()

    expect(store.isPersistencePaused()).toBe(true)
    resumeInner()
    expect(store.isPersistencePaused()).toBe(true)
    resumeInner()
    expect(store.isPersistencePaused()).toBe(true)
    resumeOuter()
    expect(store.isPersistencePaused()).toBe(false)
  })

  it('deduplicates one continuous save-failure episode', () => {
    const store = useWorkflowDraftStoreV2()

    expect(store.shouldNotifySaveFailure()).toBe(true)
    expect(store.shouldNotifySaveFailure()).toBe(false)

    store.markSaveSucceeded()
    expect(store.shouldNotifySaveFailure()).toBe(true)
    expect(store.shouldNotifySaveFailure()).toBe(false)

    store.reset()
    expect(store.shouldNotifySaveFailure()).toBe(true)
  })
})
