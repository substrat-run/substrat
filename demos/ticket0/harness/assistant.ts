/**
 * The assistant — harness code, and connector-shaped like the ingester.
 *
 * Module code may not reach the network, so the model call happens here, outside the
 * scope's transaction — through the PLATFORM's model host (#1054), which resolves the
 * desk's `provider:model` against the platform's credential and hands back one usage
 * line — and the result comes back in through `ticket0/record-answer`, line included.
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

import type { ModelAttribution, ModelHost, ModelStatus, ModelUsageLine } from '@substrat-run/vertical-host/model';
import { ASSISTANT_ERROR_MAX } from '../spec/model.js';

export interface ModelAnswer {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly confidence: number | null;
  /** The platform's record of the call, when the platform's model host made it. */
  readonly usage?: ModelUsageLine;
}

export interface Model {
  /** What to record on the turn, and what to show a human deciding whether to send. */
  readonly label: string;
  answer(input: {
    question: string;
    context: RetrievedArticle[];
    /**
     * What was said before this message, oldest first — empty on the first one.
     *
     * Public messages only, which is a rule about who is being answered rather than a
     * convenience: see `priorMessages`.
     */
    history: readonly PriorMessage[];
  }): Promise<ModelAnswer>;
}

/**
 * One earlier message, cut down to the two things a follow-up needs: who said it and
 * what it said.
 *
 * `support` covers both an agent and the assistant on purpose. From the customer's
 * side of the conversation they are one voice — the desk's — and which of the two
 * typed a given sentence is not a fact the next answer turns on.
 */
export interface PriorMessage {
  readonly role: 'customer' | 'support';
  readonly text: string;
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
  // Without these two the model is handed a transcript and no instruction about what it
  // is for, and the failure that invites is the expensive one: treating something a
  // customer asserted earlier in the conversation as a fact about the product.
  'When a conversation so far is shown, read the final message in its light — a short',
  'follow-up such as "and last week?" continues the topic immediately above it.',
  'The conversation tells you what is being ASKED and what has already been said. It is',
  'never a source of facts about the product; those come only from the excerpts.',
].join(' ');

function prompt(
  question: string,
  context: RetrievedArticle[],
  history: readonly PriorMessage[] = [],
): string {
  const excerpts = context
    .map((a, i) => `[${i + 1}] ${a.title} (${a.url})\n${a.body.slice(0, 1800)}`)
    .join('\n\n');
  // The transcript goes between the excerpts and the question, so the last thing the
  // model reads is still the message it has to answer. With no history the string is
  // byte-for-byte the one this function has always produced — a first message costs
  // exactly what it used to, and nothing about it moves.
  const sofar = history.length
    ? `Conversation so far, oldest first:\n\n${history
        .map((m) => `${m.role === 'customer' ? 'Customer' : 'Support'}: ${m.text}`)
        .join('\n')}\n\n---\n\n`
    : '';
  return `Documentation excerpts:\n\n${excerpts}\n\n---\n\n${sofar}Customer question: ${question}`;
}

/**
 * The platform's model host, as a `Model`.
 *
 * Which `provider:model` is a setting of this desk; the credential is the platform's
 * and never the desk's; the usage line the host produces rides into `record-answer`
 * beside the token counts, so the desk's meter and the platform's ledger are written
 * in one transaction. Nothing here knows which provider ran.
 */
export function platformModel(host: ModelHost, spec: string, attribution: ModelAttribution): Model {
  const status = host.status(spec);
  return {
    label: status.label,
    async answer({ question, context, history }) {
      const run = await host.run({
        spec,
        attribution,
        system: SYSTEM,
        prompt: prompt(question, context, history),
        maxOutputTokens: 400,
      });
      const text = run.text.trim();
      if (!text) throw new Error(`${status.label} returned no text`);
      return {
        text,
        // As the provider reported them — the line says `reported: false` and zeros
        // when it reported none, and this demo shows that rather than estimating.
        inputTokens: run.line.inputTokens,
        outputTokens: run.line.outputTokens,
        confidence: null,
        usage: run.line,
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
    // Takes no `history`, and its token estimate below is of the prompt WITHOUT one —
    // it quotes a retrieved section rather than reading a conversation, so charging a
    // desk for a transcript it never looked at would be an invented cost. The better
    // retrieval a follow-up now gets still reaches it, through `context`.
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

/** The platform default: runs on Cloudflare's network, costs next to nothing, and answers. */
export const DEFAULT_TICKET0_MODEL = 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fast';

/**
 * Whichever the platform can actually run. Never throws for want of a credential.
 *
 * `spec` is the desk's `TICKET0_MODEL` (per install, through `resolveScopedEnvSpec`);
 * the credential behind it is the platform's, held by the host. A provider the platform
 * holds nothing for falls back to the extractive model, so a desk still answers — and
 * Settings → Assistant says which it is and why.
 */
export function modelFor(opts: {
  spec: string | undefined;
  host: ModelHost;
  attribution: ModelAttribution;
}): Model {
  const spec = opts.spec?.trim() || DEFAULT_TICKET0_MODEL;
  return opts.host.status(spec).configured
    ? platformModel(opts.host, spec, opts.attribution)
    : extractiveModel();
}

/** What Settings → Assistant shows: the model a desk would run, and whether it can. */
export interface ModelDescription {
  /** As a turn records it — `cloudflare/@cf/…`, or `offline/extractive`. */
  readonly label: string;
  readonly generative: boolean;
  /** The desk's setting, defaulted. */
  readonly spec: string;
  /** The platform holds what this row needs. */
  readonly configured: boolean;
  readonly missing: readonly string[];
  /** Where inference runs and what is sent there. */
  readonly hosting: ModelStatus['hosting'] | null;
}

export function describeModel(host: ModelHost, spec: string | undefined): ModelDescription {
  const status = host.status(spec?.trim() || DEFAULT_TICKET0_MODEL);
  return {
    label: status.configured ? status.label : extractiveModel().label,
    generative: status.configured,
    spec: status.spec,
    configured: status.configured,
    missing: status.missing,
    hosting: status.hosting,
  };
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

/** What the customer is told when the assistant could not answer. One sentence, one place. */
export const COULD_NOT_ANSWER =
  'I could not answer this one \u2014 I have passed it to a person, who will pick it up from here.';

/**
 * A thrown thing as a reason a turn can carry: the message, cut to what the model
 * will accept. Cut here and not in the operation, because a reason the operation
 * refused for length would turn a recorded failure back into an unrecorded one.
 */
export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = text.trim() || 'failed without a message';
  return line.length > ASSISTANT_ERROR_MAX ? `${line.slice(0, ASSISTANT_ERROR_MAX - 1)}\u2026` : line;
}

/**
 * The host's last resort: the assistant could not act, so the WIDGET records that.
 *
 * `answerConversation` records the failures it can — a model that threw, an index
 * that refused — through the assistant's own `record-answer`. What it cannot record
 * is the assistant failing to exist: no service principal, no role, its first call
 * refused. The host sees that in its `catch`, and this writes the turn through the
 * principal that just accepted the customer's message. Best effort — if THIS refuses
 * too, the desk's storage is the problem, and the caller logs both.
 */
export async function recordAssistantFailure(
  widget: AssistantTarget,
  input: { conversationId: string; messageId: string; model: string; error: unknown },
): Promise<void> {
  await widget.invoke('ticket0/record-assistant-failure', {
    conversationId: input.conversationId,
    turnId: input.messageId,
    model: input.model,
    error: errorText(input.error),
  });
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
  const send = async (
    text: string,
    citedArticleIds: string[],
    /**
     * The drafted turn this send is delivering, when it is delivering one. Rides ON the
     * reply so the message and the turn's new state commit together: a second call
     * afterwards could fail with the answer already read by the customer, leaving the
     * desk reporting it as still waiting for a person.
     */
    turnId?: string,
  ): Promise<boolean> => {
    try {
      await assistant.invoke(
        'ticket0/post-public-reply',
        {
          conversationId: input.conversationId,
          body: text,
          citedArticleIds,
          ...(turnId ? { turnId } : {}),
        },
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

  /**
   * What the customer has already asked, and what they have already been told.
   *
   * Read before retrieval rather than only before generation, because the half of
   * "keeps the context" that a prompt cannot fix is the SEARCH. *"Ok, and last week?"*
   * reaches the index as its own two longest words and nothing else, so the page the
   * previous answer came from is not in the running — the model then keeps context
   * perfectly over excerpts about the wrong thing.
   *
   * Deliberately after the small-talk branch: a greeting needs no history and should
   * not pay a read for one.
   */
  const history = await priorMessages(assistant, input.conversationId, input.messageId);

  let context: RetrievedArticle[] = [];
  let answer: ModelAnswer;
  try {
    for (const q of searchQueriesOf(input.question, lastCustomerQuestion(history))) {
      const found = await assistant.invoke<{
        results: { id: string; title: string; url: string; body: string }[];
      }>('ticket0/search-kb', { q, limit: topK });
      if (found.results.length === 0) continue;
      context = spreadAcrossDocuments(found.results);
      break;
    }
    answer = await model.answer({ question: input.question, context, history });
  } catch (err) {
    // A model outage is not a lost ticket — and neither is an index that refused.
    // Record the failure WITH its reason, so the turn exists, a human sees the
    // conversation needs them, and the card says why; charge nothing, because nothing
    // ran. The reason used to go to stdout only, which a worker does not have.
    const reason = errorText(err);
    await assistant.invoke('ticket0/record-answer', {
      conversationId: input.conversationId,
      turnId: input.messageId,
      model: model.label,
      body: COULD_NOT_ANSWER,
      inputTokens: 0,
      outputTokens: 0,
      citedArticleIds: [],
      outcome: 'failed',
      error: reason,
    });
    // The customer is owed a sentence even when the model is down.
    await send(COULD_NOT_ANSWER, []);
    return {
      outcome: 'failed',
      turnId: input.messageId,
      model: model.label,
      citations: 0,
      detail: reason,
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
    ...(answer.usage ? { usage: answer.usage } : {}),
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
  /**
   * The turn rides along, so the ROW learns what happened.
   *
   * It was written `drafted` before the send, which is the right order — a turn that
   * has been paid for must survive a refused send. What was missing is the other half:
   * nothing closed the loop, so a desk whose assistant answers every customer directly
   * still held a table full of drafts. The draft card offered to send an answer the
   * customer had already read, the deflection report counted it unsent, and the health
   * panel listed it as waiting for a person. Only the value this function RETURNS was
   * ever right, and it is the one nothing stores.
   */
  const sent = await send(answer.text, context.map((c) => c.id), input.messageId);
  return {
    outcome: sent ? 'answered' : 'drafted',
    turnId: input.messageId,
    model: model.label,
    citations: context.length,
    detail: sent ? undefined : 'this desk keeps a human in the loop',
  };
}

/**
 * Breadth first, depth second: every document's best section, then their next-best.
 *
 * The corpus is split at `##`, so a page that answers well answers several times over —
 * and the model was being handed four excerpts from two pages while the customer saw
 * four citations to the same two places. The first fix for that kept ONE section per
 * document, on the reasoning that ranking had already put the best section first so
 * dropping the rest cost nothing.
 *
 * It cost the answer. bm25's best section of a page is not always the section that
 * answers the question. Asked *"what connectors exist in Substrat?"*, the index ranked
 * `/connectors/#what-a-connector-is-not` above `/connectors/#available-connectors` —
 * the table that lists them — so the one-per-document rule dropped the list and kept a
 * section explaining what a connector is not, next to two engine pages that describe
 * the seam in the abstract. The desk answered that Substrat has no connectors.
 *
 * So a document may contribute up to `perDocument` sections, but only after every other
 * document has contributed its first. The citation spread that motivated the original
 * rule survives — no page can take a second slot while another page is unrepresented —
 * and a page that genuinely answers twice is allowed to say so.
 */
export function spreadAcrossDocuments(
  results: readonly { id: string; title: string; url: string; body: string }[],
  perDocument = 2,
): RetrievedArticle[] {
  // Rank order, twice over: `order` is the documents by their best hit, and each
  // document's own list is the sections in the order the index returned them.
  const order: string[] = [];
  const sections = new Map<string, RetrievedArticle[]>();
  for (const r of results) {
    const document = r.url.split('#')[0]!;
    let held = sections.get(document);
    if (!held) {
      held = [];
      sections.set(document, held);
      order.push(document);
    }
    held.push({ id: r.id, title: r.title, url: r.url, body: r.body });
  }

  const out: RetrievedArticle[] = [];
  for (let round = 0; round < perDocument; round++) {
    for (const document of order) {
      const section = sections.get(document)?.[round];
      if (section) out.push(section);
    }
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
 * Is this a request for a person rather than a question?
 *
 * The widget has always had a "Talk to a human" button, and for everything except the
 * button itself this is the only thing that can tell. A visitor who types *"can I
 * speak to someone?"* means precisely what the button means, and before this the
 * sentence went to retrieval like any other: bm25 found the documentation's
 * best-matching page about people and permissions, the model answered from it, and
 * the customer was told which roles may file an absence. Asking a model to classify
 * this would cost a request per message and put the judgement somewhere nobody can
 * read; deciding it here costs nothing and is a rule you can argue with.
 *
 * Two conditions, both required. There must be a **person** in the sentence — human,
 * agent, someone — and there must be a **handoff**: talking to them, getting them,
 * having them look. The second condition is what keeps the documentation's own
 * subject matter out of it. "Can a person be assigned to a work order?" names a
 * person and asks a question about the product; "can a person take a look at this?"
 * names one and asks for them. A long message is doing something else whatever words
 * it uses, so length caps it, the same way `smallTalk` is capped.
 */
/** A person, in the words a customer uses for one. */
const PERSON = '(human|humans|person|people|agent|agents|someone|somebody|anyone|anybody|staff|operator|representative|support)';

/**
 * The five shapes an ask for a person takes. Patterns rather than a bag of words,
 * because the bag matches the documentation's own subject matter: this product's
 * pages are full of people being assigned things and approving things, and "do I need
 * a person to approve a migration?" is a question for the assistant, not a request
 * for one.
 */
const ASKS = [
  /** The bare ask, where the person IS the message: "human", "a real person please". */
  new RegExp(`^(a |an |the |real |actual |live |can i |i want |i need |get me |talk to |speak to |please )*${PERSON}( being)?( please| now)?$`),
  /** Talking to one: "can I talk to a human", "I'd like to speak with someone". */
  new RegExp(`\\b(talk|talking|speak|speaking|chat|chatting|deal) (to|with) (a |an |the |real |actual |live )*${PERSON}\\b`),
  /** Being handed to one, which needs no noun at all: "escalate this", "transfer me". */
  /\b(escalate|transfer|forward|hand over|handover|pass this on)\b/,
  /** Asking one to act: "can a person take a look at this", "could someone help". */
  new RegExp(`\\b${PERSON}\\b.{0,20}\\b(take a look|takes a look|look at|look into|help|reply|answer|respond|check|pick (this|it) up|get back)\\b`),
  /** The unmistakable adjective: "a real person", "an actual human". */
  new RegExp(`\\b(real|actual|live|actually) ${PERSON}\\b`),
];

/**
 * Is this a request for a person rather than a question?
 *
 * The widget has always had a "Talk to a human" button, and the button now says so
 * outright — but a visitor who TYPES *"can I speak to someone?"* means precisely what
 * the button means, and only this can tell. Before it, the sentence went to retrieval
 * like any other: bm25 found the documentation's best-matching page about people and
 * permissions, the model answered from it, and the customer was told which roles may
 * file an absence.
 *
 * Deliberately a local check and not a model call, for the reason `smallTalk` gives:
 * a request per message to decide one narrow thing, and a judgement nobody can read
 * afterwards. And deliberately liberal at the margin — the cost of being wrong here
 * is asymmetric. A question escalated by mistake reaches a person who answers it; a
 * request for a person answered by the model reaches nobody at all.
 */
export function wantsHuman(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Past a sentence or two it is a description of a problem, not a request for a
  // person — and a description of a problem is what the assistant is for.
  if (words.length === 0 || words.length > 16) return false;
  const line = words.join(' ');
  return ASKS.some((pattern) => pattern.test(line));
}

/** How many earlier messages ride into the prompt. Every one of them is billed. */
export const HISTORY_MESSAGES = 8;
/** How much of each. A long earlier message is context, not the thing being answered. */
const HISTORY_CHARS = 600;
/** Over-fetched: internal notes are dropped after the read, so they still cost a row. */
const HISTORY_FETCH = 30;

/** The shape `ticket0/list-messages` returns, narrowed to what a transcript needs. */
interface HistoryRow {
  readonly id: string;
  readonly author_kind: 'contact' | 'agent' | 'assistant' | 'system';
  readonly visibility: 'public' | 'internal';
  readonly body_text: string | null;
  readonly created_at: string;
}

/**
 * The conversation so far, as the CUSTOMER experienced it.
 *
 * ## Public only, and that is the whole safety argument
 *
 * `ticket0/list-messages` is the staff read: internal notes included, which is right
 * for the screen an agent is looking at and wrong for a prompt whose output may be
 * posted publicly a few lines later. An agent's note reading *"this one's a
 * time-waster, keep it short"* is one summarising model away from being said out loud.
 *
 * So the rule is not "filter some things out" but a line anyone can check: **the
 * assistant sees exactly what the customer saw.** On a supervised desk that excludes
 * the assistant's OWN earlier drafts, which are internal until a person sends them —
 * correctly, because the customer never read them either, and a follow-up is a
 * follow-up to what was actually said.
 *
 * ## It never fails the turn
 *
 * History is what makes a follow-up readable, not what makes an answer possible. A
 * read that refuses costs the answer its context and nothing else; the alternative —
 * a desk that stops answering because a list call went wrong — is plainly worse.
 * Harness code, so the catch here is not the `ctx.atomic` question module code faces.
 */
export async function priorMessages(
  assistant: AssistantTarget,
  conversationId: string,
  messageId: string,
): Promise<PriorMessage[]> {
  let entries: readonly HistoryRow[];
  try {
    const page = await assistant.invoke<{ entries: HistoryRow[] }>('ticket0/list-messages', {
      conversationId,
      limit: HISTORY_FETCH,
      sort: 'created_at',
      order: 'desc',
    });
    entries = page.entries ?? [];
  } catch {
    return [];
  }

  /**
   * Newest first, so everything PAST the message being answered is older than it.
   *
   * Not simply "drop the one with this id": a customer who sends two messages quickly
   * leaves a newer one sitting above this one, and that is not context for this answer
   * — it is the next question, which gets its own turn. A message that is not in the
   * page at all (erased, or a conversation longer than the fetch) leaves the list
   * whole, which is the safe way round: some context beats none.
   */
  const at = entries.findIndex((row) => row.id === messageId);
  const older = at === -1 ? entries : entries.slice(at + 1);

  const kept: PriorMessage[] = [];
  for (const row of older) {
    if (kept.length >= HISTORY_MESSAGES) break;
    if (row.visibility !== 'public') continue;
    // The desk's own acknowledgement, which nobody wrote and nothing follows from.
    if (row.author_kind === 'system') continue;
    const text = row.body_text?.trim();
    // Empty because it was erased under the PII rules, and an erased body is a fact
    // about what may be shown — not a gap to fill from somewhere else.
    if (!text) continue;
    kept.push({
      role: row.author_kind === 'contact' ? 'customer' : 'support',
      text: text.length > HISTORY_CHARS ? `${text.slice(0, HISTORY_CHARS - 1)}\u2026` : text,
    });
  }
  // Collected newest-first; a transcript reads the other way.
  return kept.reverse();
}

/** The customer's previous question — what a bare follow-up is a follow-up TO. */
export function lastCustomerQuestion(history: readonly PriorMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message?.role === 'customer') return message.text;
  }
  return undefined;
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
 *
 * ## The rung a follow-up needs
 *
 * Fact 2 above is also why a conversation's second message searches badly. *"Ok, and
 * last week? Any big releases?"* carries no word the previous question carried, so the
 * ladder is built entirely out of `release`, `last`, `week` and the changelog page the
 * answer just came from never enters the ranking. The customer reads a reply about
 * something else and concludes, correctly, that the desk forgot what they asked.
 *
 * `priorQuestion` adds ONE rung between the pair and the singles: this message's best
 * word AND the topic it is continuing. Placement is the whole design —
 *
 *  - before the singles, because the singles are what quietly succeed with the wrong
 *    page. `release` alone matches plenty; the walk stops there and never tries the
 *    bridge. A rung that only runs after a miss it will never see is not a rung.
 *  - after the pair, because a message that IS self-contained has a specific query that
 *    works, and a question about billing typed into a conversation about webhooks must
 *    not be dragged back to webhooks. When the pair hits, this function returns what it
 *    always returned.
 *
 * So the bridge is consulted exactly when the specific query found nothing — which is
 * the signature of a message that does not stand on its own.
 */
export function searchQueriesOf(question: string, priorQuestion?: string): string[] {
  const asked = rankedTerms(question);
  const prior = priorQuestion ? rankedTerms(priorQuestion) : [];

  // Nothing but grammar — "and what about that one?" — is answerable only as a
  // continuation, so the previous question's terms are not a hint here, they are the
  // query. Without a previous question this is the `help` fallback it has always been.
  if (asked.length === 0) return prior.length === 0 ? ['help'] : prior.slice(0, 3);

  const pair = asked.length >= 2 ? [asked.slice(0, 2).join(' ')] : [];
  // Only a term this message did NOT already carry can widen anything; one is enough,
  // and a second would AND the query back down to nothing.
  const carried = prior.find((word) => !asked.includes(word));
  const bridge = carried ? [`${asked[0]} ${carried}`] : [];

  return [...new Set([...pair, ...bridge, ...asked.slice(0, 3)])];
}

/**
 * A text's content words, most distinctive first.
 *
 * Longer words are the more distinctive ones once the stop-list has taken the grammar
 * out. Crude, and good enough to pick two.
 */
function rankedTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(deSuffix);
  return [...new Set(words)].sort((a, b) => b.length - a.length);
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
