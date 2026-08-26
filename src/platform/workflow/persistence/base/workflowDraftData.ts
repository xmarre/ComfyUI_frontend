import type { ComfyWorkflowJSON } from '@/platform/workflow/validation/schemas/workflowSchema'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeId(value: unknown): value is number | string {
  return typeof value === 'number' || typeof value === 'string'
}

/**
 * Checks the required root shape of persisted workflow data without recursively
 * validating every node. Drafts are written from already-serialized workflows,
 * so this guard is intended to reject corrupt root values before restore while
 * keeping workflow activation synchronous and cheap.
 */
export function isPersistedWorkflowData(
  value: unknown
): value is ComfyWorkflowJSON {
  if (!isRecord(value) || typeof value.version !== 'number') return false
  if (!Array.isArray(value.nodes)) return false

  if (value.version === 1) {
    return isRecord(value.state)
  }

  return (
    isNodeId(value.last_node_id) &&
    typeof value.last_link_id === 'number' &&
    Array.isArray(value.links)
  )
}
