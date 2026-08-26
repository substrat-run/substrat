/**
 * The invites engine's declared operation surface (#865, and #891's recipe
 * applied to the last three packages that had none).
 *
 * ## Why this file exists now
 *
 * It used to not, and the consequence was stated rather than hidden: this
 * engine's node-only claim was a `nodeOnlySuite` tripwire — a grep of
 * `index.ts` for a two-argument `ctx.check`. That is lexical, it proves an
 * absence rather than a behaviour, and a check assembled through a helper is
 * invisible to it. A DECLARATION is exact: `planEntityCheckCoverage` reads these
 * four entries the same way the conformance kit does, so "this engine narrows
 * nowhere" becomes a fact about the surface instead of a fact about the text.
 *
 * The day one of these narrows, `declaredNodeOnlySuite` goes red and the change
 * has to wire the real kit. That is the whole point of writing it down.
 *
 * ## The node checks are the design, not an omission
 *
 * An invitation is an administrative act about the SCOPE — who may join it — so
 * the authority to send one, list them, or revoke one is authority over
 * membership rather than over any single invite. There is no principal who
 * should hold `invites:revoke` for one invitation and not the next. A vertical
 * wanting "revoke only what you sent" is expressing a policy about the inviter,
 * and it belongs to that vertical.
 *
 * ## `invites/accept` checks nothing, and says so
 *
 * Declared with `narrows` and an empty `checks`, which is the reviewable way to
 * state an exception rather than leave a gap. The recipient is not a member of
 * anything yet, so there is no grant they could hold: the INVITATION is the
 * authority, proven by re-hashing the identifier they present. An operation with
 * no `permission` and no `narrows` would be indistinguishable from one somebody
 * forgot to gate — which is exactly what `declaredNodeOnlySuite`'s third
 * assertion refuses to let happen.
 *
 * No `http`: an engine owns no URL shape. The path is the composing vertical's
 * decision, declared with `defineEngineRoutes` against these names.
 */
import { defineOperations, z } from '@substrat-run/contracts';
import { invitation, invitesEntities } from './entities.js';

/** The keys these operations check. Mirrors `INVITES_PERM` in index.ts. */
export const INVITES_PERMISSIONS = ['invites:send', 'invites:read', 'invites:revoke'] as const;

const invitationId = z.object({ invitationId: z.string().min(1) });

export const invitesOperations = defineOperations(invitesEntities, INVITES_PERMISSIONS)({
  'invites/send': {
    summary: 'Invite someone to an organization',
    permission: 'invites:send',
    input: z.object({
      orgId: z.string().min(1),
      /** Plaintext. Hashed before it touches storage, and never persisted. */
      identifier: z.string().min(1),
      roleKey: z.string().min(1),
      /**
       * Overrides the default 14-day standing offer.
       *
       * Deliberately NOT constrained to positive: a negative TTL mints an
       * already-lapsed invitation, which is how the expiry sweep is driven
       * without waiting a fortnight (`invites.test.ts`). Declaring what the code
       * accepts is the job here — a schema written to what it *ought* to accept
       * would have failed a suite that has always passed.
       */
      ttlMs: z.number().int().optional(),
    }),
    // The id and nothing else — the sender never learns whether the recipient
    // already exists, is already a member, or declined before. That silence is
    // what keeps the surface non-enumerable, so it is in the declared output too.
    output: z.object({ id: z.string() }),
  },

  'invites/accept': {
    narrows: {
      reason:
        'The recipient holds nothing yet — they are not a member of anything, so there is no ' +
        'grant a check could resolve. The invitation IS the authority, proven by re-hashing ' +
        'the identifier presented. Stated here so an ungated operation cannot pass for an ' +
        'oversight.',
      checks: [],
    },
    summary: 'Accept an invitation by presenting the identifier it was sent to',
    input: invitationId.extend({ identifier: z.string().min(1) }),
    output: invitation,
  },

  'invites/list': {
    summary: 'Invitations for an organization, with state',
    permission: 'invites:read',
    input: z.object({ orgId: z.string().min(1) }),
    // The published projection, never `invitationRow`: returning the row would
    // publish the identifier hash, which is the one thing hashing exists to keep
    // unreadable.
    output: invitation,
  },

  'invites/revoke': {
    summary: 'Withdraw an invitation before it is accepted',
    permission: 'invites:revoke',
    input: invitationId,
    // Nothing comes back, and the silence is the contract: revoking is
    // idempotent, so an already-settled invitation and a live one answer the
    // same way. Returning the row would let a caller tell them apart.
    output: z.void(),
  },
});
