/**
 * The desk's list declarations as they were before migration 0025 (#1087), for the suites
 * that build an older desk and upgrade it.
 *
 * Two declarations moved with 0025. `ticket0/list-saved-replies` was kernel-composed over
 * `savedReply` (sortable by title and created_at) and is composed by its handler now, since
 * "shared or mine" depends on the caller. `ticket0/list-saved-reply-folders` is new, over a
 * table no earlier desk has. An older desk's declarations therefore carry the first and not
 * the second; declaring the folder list against a pre-0025 schema indexes a table that does
 * not exist.
 *
 * No node-only imports, so the workerd suite reads it too.
 */
export function listsBefore0025<L extends { readonly entityType: string }>(lists: readonly L[]): L[] {
  const kept = lists.filter((l) => l.entityType !== 'savedReplyFolder' && l.entityType !== 'savedReply');
  const savedReply = {
    entityType: 'savedReply',
    sortable: ['title', 'created_at'],
    table: 'ticket0_saved_replies',
    idColumn: 'id',
  } as unknown as L;
  return [...kept, savedReply];
}
