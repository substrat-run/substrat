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
    'ticket0/assign': { assignee: null },
    'ticket0/snooze': { until: '2030-01-01T00:00:00.000Z' },
    'ticket0/tag-conversation': { tag: 'conformance' },
    'ticket0/submit-csat': { score: 5 },
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
   * The one the kit cannot generate, and why.
   *
   * Asserted exactly: turning any other operation into an undrivable shape fails
   * here until this list says so, which is the coverage loss made visible in a diff.
   */
  uncovered: {
    /**
     * The string is the kit's own — it must match exactly, or a reason could drift
     * from the fact it describes. What it does not say, and a reviewer needs:
     *
     * `merge` is uncovered because no sample input is supplied for
     * `intoConversationId`, and that omission is deliberate. Supplying one would let
     * the kit drive it, and the pair would fail — the handler checks
     * `conversation:merge` on BOTH conversations, the loser and the survivor, while
     * the kit grants on one entity. So the second check would refuse a principal the
     * first let through, and the failure would look like a broken handler rather than
     * a shape the harness cannot express. The double check is deliberate: one check
     * would let a caller fold a conversation into one they cannot see.
     */
    'ticket0/merge': 'no sample input for required field(s): intoConversationId',
  },
});
