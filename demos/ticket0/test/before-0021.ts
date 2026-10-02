/**
 * The desk as it was before migration 0021 (#1088), for the suites that upgrade from it.
 *
 * No node-only imports, so the workerd suite reads it too: three suites build the
 * previous version, and one place says what that version declared.
 */

/** The list declaration before `quarantine` was a column, so before it was a filter. */
export function listsBefore0021<L extends { readonly filterable?: readonly string[] }>(lists: readonly L[]): L[] {
  return lists.map((l) => (l.filterable ? { ...l, filterable: l.filterable.filter((f) => f !== 'quarantine') } : l));
}

/** The five live-work partial indexes 0021 narrowed to the inbox. */
export const INBOX_PARTIAL_INDEXES = [
  'ticket0_conversations_waiting',
  'ticket0_conversations_first_response_running',
  'ticket0_conversations_resolution_running',
  'ticket0_conversations_untagged',
  'ticket0_conversations_no_reply_candidate',
] as const;
