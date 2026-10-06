/**
 * The portal's live feed (#938): one conversation, as its customer may see it.
 *
 * `/api/live` is the desk's feed, and a portal customer hears nothing on it: every
 * `liveTargets` key is `conversation:read`, the staff read, and `message` cannot be
 * `conversation:read-own` because internal notes are `message` rows too (the comment on
 * `liveTargets` in `src/manifest.ts` says why). So the portal's one-conversation view
 * holds a socket of its own, rooted at the conversation's `publicThread`:
 *
 * - **The root is the row filter.** Only PUBLIC messages hang under a `publicThread`
 *   (#2044): notes, forwards and assistant drafts never do, so they send nothing here at
 *   all. That is exactly what `ticket0/my-messages` returns.
 * - **The customer's own grant is the gate.** `checkedWithin(…, 'conversation:read-own')`
 *   asks the subscriber's own check on the thread, which walks thread → conversation →
 *   contact to their portal grant: at the handshake (`403` for another contact's
 *   conversation), and again on every pass with a message to announce. A grant taken
 *   away, or a thread no longer under their contact, closes the socket.
 * - **Nudges only.** The customer may not read each message's row under the staff key,
 *   so the scope never says which one changed; the page re-reads `my-messages`.
 *
 * Not reached this way: a customer CC'd on somebody else's conversation. `my-messages`
 * lets them read it by a second proof (`readableAsCc`), which is not a grant the walk
 * can follow, so their handshake is refused and the page polls.
 *
 * Mounted by both hosts beside `/api/live`, so the dev server answers `501` and the page
 * keeps its poll there too.
 */
import type { Context, Env, Hono } from 'hono';
import { checkedWithin, type LiveReadSurface } from '@substrat-run/kernel';
import { mountLiveReads, type LiveSubscriber } from '@substrat-run/vertical-host';
import { T0_PERM } from '../src/manifest.js';

/** The portal's per-conversation feed. The client builds the same path (`app/src/live.ts`). */
export const PORTAL_LIVE_PATH = '/api/conversations/:conversationId/live';

/** The root a customer watching `conversationId` is subscribed within, and the key it is checked on. */
export function portalThreadWithin(conversationId: string) {
  return checkedWithin({ entityType: 'publicThread', entityId: conversationId }, T0_PERM.conversationReadOwn);
}

export function mountPortalLive<E extends Env>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<E, any, any>,
  options: {
    live: (c: Context<E>) => LiveReadSurface<Request, Response> | undefined;
    /** The signed-in caller and their scope, as `/api/live` resolves them; null for nobody. */
    caller: (c: Context<E>) => Promise<Omit<LiveSubscriber, 'within'> | null>;
  },
): void {
  mountLiveReads(app, {
    path: PORTAL_LIVE_PATH,
    live: options.live,
    subscriber: async (c) => {
      const who = await options.caller(c);
      // The route's own pattern names it; the type cannot know that.
      return who ? { ...who, within: portalThreadWithin(c.req.param('conversationId') as string) } : null;
    },
  });
}
