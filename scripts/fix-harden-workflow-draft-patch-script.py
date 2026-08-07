from pathlib import Path

path = Path('scripts/harden-workflow-draft-quota-recovery.py')
text = path.read_text()
old = """text = replace_once(
    text,
    \"\"\"        if (!persistIndex(cleanedIndex)) {
          indexCacheByWorkspace.value[workspaceId] = originalIndex
          return false
        }
\"\"\",
    \"\"\"        if (!persistIndex(cleanedIndex)) {
          rollbackQuotaEvictions(workspaceId, originalIndex, evictedPayloads)
          return false
        }
\"\"\",
    'stale-order rollback',
)
text = replace_once(
    text,
    \"\"\"        if (!persistIndex(cleanedIndex)) {
          indexCacheByWorkspace.value[workspaceId] = originalIndex
          return false
        }
\"\"\",
    \"\"\"        if (!persistIndex(cleanedIndex)) {
          rollbackQuotaEvictions(workspaceId, originalIndex, evictedPayloads)
          return false
        }
\"\"\",
    'removeEntry fallback rollback',
)
"""
new = """cleaned_failure = \"\"\"        if (!persistIndex(cleanedIndex)) {
          indexCacheByWorkspace.value[workspaceId] = originalIndex
          return false
        }
\"\"\"
cleaned_rollback = \"\"\"        if (!persistIndex(cleanedIndex)) {
          rollbackQuotaEvictions(workspaceId, originalIndex, evictedPayloads)
          return false
        }
\"\"\"
if text.count(cleaned_failure) != 2:
    raise RuntimeError(
        f'cleaned-index rollback paths: expected two matches, found {text.count(cleaned_failure)}'
    )
text = text.replace(cleaned_failure, cleaned_rollback, 2)
"""
if text.count(old) != 1:
    raise RuntimeError(f'hardening script block: expected one match, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
