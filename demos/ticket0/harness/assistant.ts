/**
 * The assistant — harness code, and connector-shaped like the ingester.
 *
 * Module code may not reach the network, so the model call happens here, outside the
 * scope's transaction, and the result comes back in through `ticket0/record-answer`.
 * In a hosted deployment this is a registered connector; on the demo's Node server it
 * is a function the widget surface calls. The operations either end are identical.
 *
 * ## The thing worth reading
 *
 * `answerConversation` below tries to send its answer to the customer and **catches the
 * refusal**. That is not error handling being lazy — it is the design executing. Nothing
 * here knows whether this desk trusts its assistant; it asks the kernel by doing the
 * thing, and records `answered` or `drafted` depending on what came back. Substrat's
 * desk sends; Kestrel's does not; same code, same call, different grant.
 */

export interface ModelAnswer {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly confidence: number | null;
}

export interface Model {
  /** What to record on the turn, and what to show a human deciding whether to send. */
  readonly label: string;
  answer(input: { question: string; context: RetrievedArticle[] }): Promise<ModelAnswer>;
}

export interface RetrievedArticle {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly body: string;
}

const SYSTEM = [
  'You are a support agent for a software product.',
  'Answer ONLY from the documentation excerpts provided. They are the whole of what you know.',
  'If the excerpts do not contain the answer, say so plainly and suggest the person ask a human.',
  'Be brief — three sentences unless the question genuinely needs more.',
  'Never invent a URL, a flag, a command or an API that is not in the excerpts.',
  // Answer the question, do not narrate the process of answering it. The customer can
  // see the citation; being told the answer came from the documentation is filler in
  // front of the sentence they actually asked for.
  'Answer directly, in your own words.',
  'Never open with "According to the documentation", "Based on the excerpts", "The docs say"',
  'or any similar preamble — begin with the answer itself.',
].join(' ');

function prompt(question: string, context: RetrievedArticle[]): string {
  const excerpts = context
    .map((a, i) => `[${i + 1}] ${a.title} (${a.url})\n${a.body.slice(0, 1800)}`)
    .join('\n\n');
  return `Documentation excerpts:\n\n${excerpts}\n\n---\n\nCustomer question: ${question}`;
}

/**
 * Cloudflare Workers AI over its REST API.
 *
 * REST rather than the `env.AI` binding because this demo runs on Node. In a deployed
 * worker the binding is the better call — it needs no token and no egress allowance —
 * and swapping is a change to this function and nothing else.
 */
export function workersAiModel(opts: {
  accountId: string;
  apiToken: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Model {
  const model = opts.model ?? '@cf/meta/llama-3.1-8b-instruct';
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    label: `workers-ai/${model}`,
    async answer({ question, context }) {
      const res = await doFetch(
        `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/${model}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: prompt(question, context) },
            ],
            max_tokens: 400,
          }),
        },
      );
      if (!res.ok) throw new Error(`workers-ai ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as {
        success?: boolean;
        errors?: { message: string }[];
        result?: {
          response?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
      };
      if (json.success === false) {
        throw new Error(`workers-ai: ${json.errors?.map((e) => e.message).join('; ') ?? 'failed'}`);
      }
      const text = json.result?.response?.trim();
      if (!text) throw new Error('workers-ai returned no text');
      const usage = json.result?.usage;
      return {
        text,
        // Counted by the provider where it reports them. Estimated only as a last
        // resort, and an estimate that silently became a bill would be worse than a
        // missing one — which is why this demo prices for display and not for money.
        inputTokens: usage?.prompt_tokens ?? estimateTokens(prompt(question, context)),
        outputTokens: usage?.completion_tokens ?? estimateTokens(text),
        confidence: null,
      };
    },
  };
}

/** ~4 characters per token. Good enough to show a cost; never good enough to bill one. */
const estimateTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/**
 * The no-credentials fallback: retrieval with no generation.
 *
 * It quotes the best-matching documentation section verbatim and says where it came
 * from. That is a genuinely useful support answer and an honest one — but it is not a
 * model, so it says so in its label, and nobody reading a turn record can mistake the
 * two.
 */
export function extractiveModel(): Model {
  return {
    label: 'offline/extractive',
    async answer({ question, context }) {
      const best = context[0];
      if (!best) {
        return {
          text: "I couldn't find anything in the documentation about that. Let me get a human to take a look.",
          inputTokens: estimateTokens(question),
          outputTokens: 20,
          confidence: 0,
        };
      }
      // The first substantial paragraph, which in this corpus is the one that answers.
      const paragraph =
        best.body
          .split(/\n\s*\n/)
          .map((p) => p.replace(/\s+/g, ' ').trim())
          .find((p) => p.length > 120 && !p.startsWith('|') && !p.startsWith('```')) ??
        best.body.slice(0, 400);
      const text = `${paragraph}\n\nFrom "${best.title}" — ${best.url}`;
      return {
        text,
        inputTokens: estimateTokens(prompt(question, context)),
        outputTokens: estimateTokens(text),
        confidence: context.length > 1 ? 0.5 : 0.35,
      };
    },
  };
}

/**
 * Whichever the environment can actually run. Never throws for want of a credential.
 *
 * The map is a REQUIRED argument rather than a `process.env` default, because there
 * are now two hosts and only one of them has a `process`: the worker resolves these
 * per install through `resolveScopedEnvSpec`, so the credential a desk is billed
 * against is that desk's, not whatever the deployment-wide binding happened to hold.
 */
export function modelFromEnv(env: Record<string, string | undefined>): Model {
  const accountId = env.CF_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CF_AI_TOKEN ?? env.CLOUDFLARE_API_TOKEN;
  if (accountId && apiToken) {
    return workersAiModel({ accountId, apiToken, model: env.TICKET0_MODEL });
  }
  return extractiveModel();
}

export interface AssistantTarget {
  invoke<T>(operation: string, input: unknown, options?: { idempotencyKey?: string }): Promise<T>;
}

export interface AnswerOutcome {
  readonly outcome: 'answered' | 'drafted' | 'escalated' | 'failed';
  readonly turnId: string;
  readonly model: string;
  readonly citations: number;
  readonly detail?: string;
}

/**
 * Answer one customer message: retrieve, generate, record, and try to send.
 *
 * `turnId` is the message id, so the whole thing is idempotent — a redelivered trigger
 * finds the turn already recorded and bills nothing further.
 */
export async function answerConversation(
  assistant: AssistantTarget,
  input: { conversationId: string; messageId: string; question: string },
  model: Model,
  // Over-fetched on purpose: deduping by document removes hits, and a top-4 that
  // collapses to one page is a narrower answer than the index could have given.
  topK = 8,
): Promise<AnswerOutcome> {
  // Walk the ladder until something answers. Stopping at the first hit keeps the
  // specific query's ranking when there is one, and only widens when there is not.
  /**
   * Try to send, and report whether the desk let it.
   *
   * Every outcome goes through here — answered, not-covered, model down — because the
   * failure mode this closes is silence: a customer who asked something and got
   * nothing back has no way to tell a broken desk from a slow one.
   */
  const send = async (text: string, citedArticleIds: string[]): Promise<boolean> => {
    try {
      await assistant.invoke(
        'ticket0/post-public-reply',
        { conversationId: input.conversationId, body: text, citedArticleIds },
        // The platform's own dedupe, keyed by the message being answered: a retried
        // send returns the first one's recording instead of posting a second public
        // reply and emitting a second `reply-requested`. `record-answer` already had
        // this through the ledger's dedupe key; the send did not.
        { idempotencyKey: `reply:${input.messageId}` },
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A desk that keeps a human in the loop refuses this, and that is not an error.
      if (!/permission denied/i.test(message)) throw err;
      return false;
    }
  };

  /**
   * Small talk is answered directly: no retrieval, no model, no meter entry, and no
   * turn — there is nothing to attribute or to charge for. It still goes through
   * `send`, so a desk that keeps a human in the loop stays in the loop even for this.
   */
  const chat = smallTalk(input.question);
  if (chat) {
    const text =
      chat === 'thanks'
        ? 'Happy to help. Anything else I can look up?'
        : 'Hi! What can I help you with? I can look things up in the documentation.';
    const told = await send(text, []);
    return {
      outcome: told ? 'answered' : 'drafted',
      turnId: input.messageId,
      model: 'none/small-talk',
      citations: 0,
      detail: told ? 'small talk — no model, no cost' : 'this desk keeps a human in the loop',
    };
  }

  let context: RetrievedArticle[] = [];
  for (const q of searchQueriesOf(input.question)) {
    const found = await assistant.invoke<{
      results: { id: string; title: string; url: string; body: string }[];
    }>('ticket0/search-kb', { q, limit: topK });
    if (found.results.length === 0) continue;
    context = distinctDocuments(found.results);
    break;
  }

  let answer: ModelAnswer;
  try {
    answer = await model.answer({ question: input.question, context });
  } catch (err) {
    // A model outage is not a lost ticket. Record the failure so the turn exists and a
    // human sees the conversation needs them; charge nothing, because nothing ran.
    await assistant.invoke('ticket0/record-answer', {
      conversationId: input.conversationId,
      turnId: input.messageId,
      model: model.label,
      body: 'I could not answer this one \u2014 I have passed it to a person, who will pick it up from here.',
      inputTokens: 0,
      outputTokens: 0,
      citedArticleIds: [],
      outcome: 'failed',
    });
    // The customer is owed a sentence even when the model is down.
    await send('I could not answer this one \u2014 I have passed it to a person, who will pick it up from here.', []);
    return {
      outcome: 'failed',
      turnId: input.messageId,
      model: model.label,
      citations: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Recorded first, and as an INTERNAL message: a turn that has been paid for must
  // exist even if the send below is refused.
  await assistant.invoke('ticket0/record-answer', {
    conversationId: input.conversationId,
    turnId: input.messageId,
    model: model.label,
    body: answer.text,
    inputTokens: answer.inputTokens,
    outputTokens: answer.outputTokens,
    citedArticleIds: context.map((c) => c.id),
    confidence: answer.confidence,
    outcome: context.length === 0 ? 'escalated' : 'drafted',
  });

  if (context.length === 0) {
    /**
     * The documentation does not cover it, and that is a real answer.
     *
     * It used to return here having written only an INTERNAL turn, so a customer who
     * asked something off-topic got nothing back at all — indistinguishable from a
     * broken desk. Saying "not in the docs, a person will take it" is both honest and
     * the whole reason this product refuses to guess.
     */
    const told = await send('I could not find anything about that in the documentation, so I would rather not guess. I have passed this to a person \u2014 they will pick it up from here.', []);
    return {
      outcome: 'escalated',
      turnId: input.messageId,
      model: model.label,
      citations: 0,
      detail: told ? 'told the customer it is not covered' : 'this desk keeps a human in the loop',
    };
  }

  /**
   * Now ask the kernel whether this desk lets its assistant speak.
   *
   * Deliberately by DOING it rather than by reading a setting: there is no setting,
   * and a `desk.aiMode` check here would be a second description of a grant that
   * already exists. A refusal leaves the draft internal, which is exactly right.
   */
  // What it actually sent is recorded on the message; the turn keeps its own copy of
  // what the model drew on, and a human who edits the draft can make the two differ.
  const sent = await send(answer.text, context.map((c) => c.id));
  return {
    outcome: sent ? 'answered' : 'drafted',
    turnId: input.messageId,
    model: model.label,
    citations: context.length,
    detail: sent ? undefined : 'this desk keeps a human in the loop',
  };
}

/**
 * One section per document, best-ranked first.
 *
 * The corpus is split at `##`, so a page that answers well answers several times over —
 * and the model was being handed four excerpts from two pages while the customer saw
 * four citations to the same two places. Ranking already put the best section first, so
 * keeping it and dropping the rest of that document costs nothing and buys breadth.
 */
function distinctDocuments(
  results: readonly { id: string; title: string; url: string; body: string }[],
): RetrievedArticle[] {
  const seen = new Set<string>();
  const out: RetrievedArticle[] = [];
  for (const r of results) {
    const document = r.url.split('#')[0]!;
    if (seen.has(document)) continue;
    seen.add(document);
    out.push({ id: r.id, title: r.title, url: r.url, body: r.body });
  }
  return out;
}

/**
 * Is this a pleasantry rather than a question?
 *
 * "Hello" is not covered by the documentation, and neither is "thanks" — but answering
 * either with *"I could not find anything about that, a person will pick it up"* is
 * absurd, and worse, it drags a human into the inbox to say hello back.
 *
 * Deliberately a local check and not a model call. Handing small talk to the model to
 * classify would cost a request per greeting and re-open the door this product exists
 * to close: a model with no documentation in front of it will happily answer a question
 * about bolognese. This decides one narrow thing and defers everything else.
 *
 * Tight on purpose: EVERY word must be a pleasantry, so "hi" matches and "hi, how do I
 * deploy?" does not — it goes to retrieval like any other question.
 */
export type SmallTalk = 'greeting' | 'thanks' | null;

const GREETINGS = new Set([
  'hi','hey','hello','yo','hiya','howdy','morning','afternoon','evening','good','there','all',
]);
const THANKS = new Set([
  'thanks', 'thank', 'thx', 'ty', 'cheers', 'great', 'perfect', 'nice', 'awesome',
  'you', 'much', 'appreciated', 'brilliant', 'lovely',
]);

export function smallTalk(text: string): SmallTalk {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // A long message is doing something other than saying hello, whatever words it uses.
  if (words.length === 0 || words.length > 4) return null;
  if (words.every((w) => THANKS.has(w))) return 'thanks';
  if (words.every((w) => GREETINGS.has(w) || THANKS.has(w))) return 'greeting';
  return null;
}

/**
 * Turn a question into a short list of searches, most specific first.
 *
 * Three facts about the index decide this shape, and all three were measured rather
 * than assumed:
 *
 *  1. **The kernel owns the query syntax.** `ctx.search` splits the input on
 *     non-word characters, quotes every term, and appends the prefix `*` itself.
 *     Writing `OR` or `*` here does not reach FTS5 as syntax — `OR` arrives as a
 *     literal term that every result must then contain, which is a query that matches
 *     nothing and looks like an empty knowledge base.
 *  2. **Terms are ANDed.** So a long question turned into eight terms is a guaranteed
 *     miss. Fewer, better words beat more of them.
 *  3. **Prefixing is not stemming.** The index will match `rotat` → `Rotating`, but
 *     only if the term is already cut back that far; a customer typing "rotate" gets
 *     nothing without the light de-suffixing below.
 *
 * Hence a ladder rather than one query: the two most distinctive words together, then
 * each alone. The caller walks it until something answers, which costs one extra index
 * read on a miss and turns "no results" into an answer far more often than it does not.
 */
export function searchQueriesOf(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(deSuffix);

  const unique = [...new Set(words)];
  if (unique.length === 0) return ['help'];

  // Longer content words are the more distinctive ones once the stop-list has taken
  // the grammar out. Crude, and good enough to pick two.
  const ranked = [...unique].sort((a, b) => b.length - a.length);
  const ladder = ranked.length >= 2 ? [ranked.slice(0, 2).join(' ')] : [];
  return [...new Set([...ladder, ...ranked.slice(0, 3)])];
}

/**
 * A crude de-suffixer, so the customer's word reaches the documentation's word.
 *
 * Deliberately not a real stemmer: a Porter implementation is a dependency and a
 * behaviour nobody can predict from reading the code, whereas this handles the endings
 * an English support question actually varies on. When it cuts too much, the prefix
 * search the kernel builds on top is wider rather than wrong.
 */
function deSuffix(word: string): string {
  const base = word.replace(/(ing|ions|ion|ies|ed|es|s|e)$/, '');
  return base.length >= 3 ? base : word;
}

/**
 * Grammar, not content. Prepositions and auxiliaries are here because the ranking
 * below picks by length, and "against" is longer than "scope" while carrying none of
 * the question.
 */
const STOP = new Set([
  'the','and','for','are','you','was','has','its','can','but','not','all','any','how','why',
  'who','did','does','get','got','way','use','see','set','out','our','one','two','per','via',
  'that','this','with','from','have','what','when','where','which','would','could','should',
  'there','their','about','into','your','yours','been','were','they','them','then','than',
  'some','just','like','make','need','want','know','tell','please','help','using','anyone',
  'against','before','after','during','while','between','without','within','under','over',
  'onto','upon','still','also','only','even','ever','much','many','more','most','less',
]);
