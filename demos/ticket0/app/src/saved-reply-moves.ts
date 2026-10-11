/**
 * Move a saved reply into or out of the trash, and drop the entity tag the client holds for it
 * (#2161).
 *
 * The client remembers the tag of the last guarded call on a reply and sends it as `If-Match`
 * on the next guarded write to it. A move is not guarded, so it hands back no tag, yet the
 * kernel's move is an event about the reply and moves its version. Kept, the old tag can only
 * be stale: the next Delete for good (or save) would answer 412, "somebody else changed this",
 * for a reply nobody else touched. Dropped, that next write goes unconditional, as a delete from
 * the trash already does for every reply this client never read.
 *
 * The narrow cost, stated: if a colleague restores, edits and re-bins the reply between this
 * move and your delete for good, that delete removes their edit. Platform side, #2191 would
 * have a move hand back the new version; when it does, this goes and the calls are made as is.
 */
import type { Ticket0Client } from './api.generated.js';

export async function moveSavedReply(
  client: Ticket0Client,
  move: 'trash' | 'restore',
  savedReplyId: string,
): Promise<{ id: string; state: 'active' | 'archived' | 'trashed' }> {
  const moved =
    move === 'trash'
      ? await client.trashSavedReply({ savedReplyId })
      : await client.restoreSavedReply({ savedReplyId });
  // The generated client's key: `entityType:id`.
  client.versions.delete(`savedReply:${savedReplyId}`);
  return moved;
}
