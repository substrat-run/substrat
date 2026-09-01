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

export const conformance = declareEntityChecks({
  subject: 'ticket0',
  operations: ticket0Operations,
  // Only what each schema REQUIRES beyond the entity id — the kit supplies that
  // itself and asks for nothing else it can work out.
  inputs: {
    'ticket0/record-kb-articles': { articles: [] },
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
    // Names a turn that does not exist, and that is enough: what this pair proves is
    // the ENTITY check, which runs before the row is looked up. The not-found that
    // follows is not a denial, and the kit reads it as one it may ignore.
    'ticket0/mark-turn-sent': { turnId: 'conformance-turn-sent' },
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
  },
});
