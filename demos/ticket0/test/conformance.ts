/**
 * ticket0's entity-check claim, in the one place both the test and the trust page
 * read it.
 *
 * The asymmetry that makes a pass mean something is different here from todo's. In
 * this app the STAFF keys — `conversation:read`, `conversation:draft` and the rest —
 * are held scope-wide by every agent, so an agent would satisfy any entity check
 * trivially and prove nothing. The probe is therefore a principal holding **no role at
 * all**, granted one permission on one conversation at a time. That is also exactly
 * how a customer reaches their own conversation, so the suite drives the real shape.
 */
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { ticket0Operations } from '../spec/model.js';

/**
 * The follower both follow cases name — empty here, filled by the suite.
 *
 * `ticket0/follow-conversation` needs a principal that is IN the desk's directory
 * (#1086 follows #1079's rule), and a directory row is minted by a seed run, so this
 * file cannot name one the way `todo/share-list` names Ada's address. A mutable object
 * handed to the kit is the documented way round that: `test/entity-checks.test.ts`
 * writes the seeded agent into it in `beforeAll`, and the kit reads the entry per CASE
 * rather than once at collect time.
 *
 * Forgetting to fill it does not pass quietly. The host parses a declared input before
 * any check runs, so `''` fails `min(1)` and case 2 — which requires a permission
 * denial and tolerates nothing else — goes red.
 */
export const CONFORMANCE_FOLLOWER: { follower: string } = { follower: '' };

export const conformance = declareEntityChecks({
  subject: 'ticket0',
  operations: ticket0Operations,
  // Only what each schema REQUIRES beyond the entity id — the kit supplies that
  // itself and asks for nothing else it can work out.
  inputs: {
    'ticket0/record-kb-articles': { articles: [] },
    /**
     * A token that is deliberately not one. The check this pair proves is the ENTITY
     * check — that the operation refuses a principal who was not granted on THIS
     * source — and it is reached before the hash comparison, which is what the hook
     * cases in `test/assistant.test.ts` drive.
     */
    'ticket0/redeem-kb-refresh-token': { token: 't0kb_conformance-not-a-real-hook' },
    'ticket0/record-kb-ingest-failure': { error: 'The conformance kit could not read it' },
    'ticket0/post-note': { body: 'A note from the conformance kit' },
    'ticket0/post-public-reply': { body: 'A reply from the conformance kit' },
    // Nobody, and it has to be: `assignee` must now name a principal with a profile
    // (#1079), and this file is a static declaration the trust page also reads — it
    // has no way to name a principal a seed run invented. `null` is a legal
    // assignment either way, and what this pair proves is the ENTITY check, not who
    // may be assigned. `test/scenario.test.ts` drives the real person and the
    // refusal.
    'ticket0/assign': { assignee: null },
    // Both halves of #1086's follower pair, sharing one object because they name the
    // same person: putting somebody on a thread and taking them off again is only a
    // pair if it is the same somebody.
    'ticket0/follow-conversation': CONFORMANCE_FOLLOWER,
    'ticket0/unfollow-conversation': CONFORMANCE_FOLLOWER,
    'ticket0/set-priority': { priority: 'urgent' },
    'ticket0/snooze': { until: '2030-01-01T00:00:00.000Z' },
    'ticket0/tag-conversation': { tag: 'conformance' },
    'ticket0/untag-conversation': { tag: 'conformance' },
    'ticket0/submit-csat': { score: 5 },
    'ticket0/record-assistant-failure': {
      turnId: 'conformance-failed-turn',
      model: 'conformance/none',
      error: 'The conformance kit could not run the assistant',
    },
    'ticket0/record-answer': {
      turnId: 'conformance-turn',
      model: 'conformance/none',
      body: 'An answer from the conformance kit',
      inputTokens: 1,
      outputTokens: 1,
      citedArticleIds: [],
      outcome: 'drafted',
    },
  },
  /**
   * The follower pair opens on `conversation:assign` and honours it, then hands
   * `conversation:read` to the follower with `ctx.grant` — which only narrows a
   * permission the CALLER already holds on that entity. Every staff role here holds
   * `conversation:read` scope-wide, so no agent ever meets that second gate; the
   * probe, holding no role at all, meets it on the first call. Granting it narrowed to
   * the same conversation is what lets the pair measure the declared check rather than
   * a `ctx.grant` refusal underneath it — and keeps case 1 able to catch a node check,
   * since nothing here is scope-wide.
   */
  alsoGrant: {
    'ticket0/follow-conversation': {
      permissions: ['conversation:read'],
      because:
        'the handler delegates conversation:read to the follower via ctx.grant, and ' +
        'delegation only narrows a permission the caller already holds on that entity',
    },
    'ticket0/unfollow-conversation': {
      permissions: ['conversation:read'],
      because:
        'ctx.revoke takes the same guardrail as ctx.grant — a caller may only withdraw ' +
        'a grant it could have made, so it must hold the key on that entity too',
    },
    // The macro rule (#1087), met by the kit exactly as it is met by a person: a
    // macro needs every key its parts need, and a public reply is a part. The kit's
    // saved reply carries no actions, so reply-public is the whole of the rest.
    'ticket0/apply-saved-reply': {
      permissions: ['conversation:reply-public'],
      because:
        'a macro checks the union of the keys its parts declare, and sending its reply ' +
        'publicly is ticket0/post-public-reply, which declares conversation:reply-public',
    },
  },
  /**
   * `merge` names a second conversation, and needs a real one (#939).
   *
   * A sample id in `inputs` could not drive it: the handler checks
   * `conversation:merge` on BOTH conversations, the loser and the survivor, so an id
   * that names nothing — or one the probe holds no grant on — is refused on the
   * survivor and the pair reads as a broken handler. The double check is deliberate:
   * one check would let a caller fold a conversation into one they cannot see.
   *
   * So the kit makes the survivor the way it makes the loser, fresh per case, and
   * grants the same key on it. The fixture seeds every conformance conversation under
   * ONE contact, so case 1 is a merge the business rule allows (#919 refuses a
   * cross-contact merge) rather than a refusal the kit merely tolerates. What the pair
   * still does not assert is the survivor check itself — `test/scenario.test.ts`
   * drives that by hand, against a conversation the caller cannot see.
   *
   * Nothing is left undriven: an operation that becomes undrivable fails the suite's
   * exact-list assertion until it is named here, with its reason.
   */
  coEntities: {
    'ticket0/merge': { intoConversationId: 'conversation' },
    // The reply being rendered is not the entity the check narrows to — the
    // conversation is — but it still has to EXIST, or case 1 measures a
    // `not_found` it merely tolerates rather than the permission answer it is
    // for. So the kit makes one per case, the same way it makes the survivor a
    // merge folds into.
    'ticket0/render-saved-reply': { savedReplyId: 'savedReply' },
    // The same reason, for the macro that sends it.
    'ticket0/apply-saved-reply': { savedReplyId: 'savedReply' },
  },
});
