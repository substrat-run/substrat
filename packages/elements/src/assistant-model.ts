/**
 * What a conversation with the assistant knows, with no DOM in it.
 *
 * `<sub-assistant>` draws this, and a host with its own input drives it: `send` from a
 * palette's field, `stop` from its own button. The host creates the model and keeps it, so
 * closing the overlay around the element keeps the conversation. A new model is a new
 * conversation.
 *
 * The source is injected, as `TableSource` is for the table: one method that sends a turn and
 * yields the protocol's events. A whole-body POST is a short generator, and a streamed or
 * resumable thread is another source for the same model. A source hands over events it has
 * already read (`readAssistantStreamEvent`, or built itself), so this file imports only types
 * and a bundle without zod pays nothing for it.
 *
 * Answers a hand-written chat keeps getting wrong, held here once:
 *
 *   - the question is drawn at once, before anything comes back;
 *   - one question at a time, and whatever lands after Stop is dropped;
 *   - a stream that closes without saying how it ended claims nothing (`ended-early`);
 *   - a step cut off and restarted drops its partial text rather than showing it twice;
 *   - a turn paused for an approval this version cannot draw never looks actionable;
 *   - Stop ends the work on the server when the source can; `detach` only stops listening.
 *
 * It has no clock, and no words of its own: the element measures silence against `activity`
 * and says things, and the model hands over codes and what the server wrote.
 */
import type { AssistantStreamBody } from '@substrat-run/contracts/assistant-stream';

/** The protocol brands its instants, which is a parser's promise; a source building its own has a plain string. */
type PlainInstants<E> = E extends unknown ? { [K in keyof E]: K extends 'producedAt' | 'resetsAt' ? string : E[K] } : never;

/** An event as a source hands it over. `id` is the record's, so a source building its own has none. */
export type AssistantEvent = PlainInstants<AssistantStreamBody> & { id?: number };

export interface AssistantHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantSend {
  text: string;
  /** The answered turns before this one, oldest first. A source that owns its thread ignores it. */
  history: readonly AssistantHistoryEntry[];
}

/** Where the answers come from. Aborting `signal` means only "I stopped listening". */
export interface AssistantSource {
  send(turn: AssistantSend, ctx: { signal: AbortSignal }): AsyncIterable<AssistantEvent>;
  /** Ends the work on the server. Absent, no Stop is offered. */
  cancel?(): Promise<void>;
}

/** What a turn is made of, in the order it happened. */
export type AssistantPart =
  | { kind: 'text'; id: string; step: string | null; text: string }
  | { kind: 'tool'; id: string; tool: string; status: 'running' | 'done' | 'failed' }
  | { kind: 'note'; id: string; note: string; text: string };

/**
 * How a turn stands. `stopped` is neither success nor failure, and `ended-early` is a stream
 * that closed without saying how it ended: nothing can be claimed about it either way.
 */
export type AssistantTurnStatus = 'running' | 'done' | 'stopped' | 'ended-early' | 'failed' | 'budget' | 'needs-approval';

/**
 * Why a turn failed. `code` is `turn-error`'s slug, or `transport`, `refused`, `rate-limited`,
 * `unavailable` or `failed` for a source that threw. `message` is what the server wrote for the
 * person; null when nothing did, and the element says it in its own words.
 */
export interface AssistantFailure {
  code: string;
  message: string | null;
}

export interface AssistantProvenance {
  producedAt: string;
  model: string | null;
  sources: number | null;
}

/**
 * Something an answer rests on. `ref` is the host's own handle on it; `url` is http(s) or absent.
 * `kind` is what sort of thing it is, as the server named it, and `detail` is the short line the
 * element draws beside the title (where it lives, when the title does not say).
 */
export interface AssistantCitation {
  sid: string;
  title: string;
  url: string | null;
  ref: string | null;
  kind: string | null;
  detail: string | null;
}

export interface AssistantTurn {
  /** Stable for the life of the model, and kept by a retry. */
  id: number;
  question: string;
  parts: readonly AssistantPart[];
  citations: readonly AssistantCitation[];
  provenance: AssistantProvenance | null;
  /** The person's or the team's budget ran out, on this turn or with it. */
  budgetExhausted: boolean;
  status: AssistantTurnStatus;
  failure: AssistantFailure | null;
  /** The step the next text belongs to, so a restart can find it. */
  step: string | null;
}

export interface AssistantSnapshot {
  turns: readonly AssistantTurn[];
  running: boolean;
  /** Bumps with every event, so a renderer can measure silence with its own clock. */
  activity: number;
  /** A run is in flight and the source can end it on the server. */
  canStop: boolean;
}

/** What moved between two snapshots, for a renderer that has to say so. */
export type AssistantTurnChange = 'started' | 'answered' | 'stopped' | 'ended-early' | 'failed' | 'budget' | 'needs-approval';

const newTurn = (id: number, question: string): AssistantTurn => ({
  id,
  question,
  parts: [],
  citations: [],
  provenance: null,
  budgetExhausted: false,
  status: 'running',
  failure: null,
  step: null,
});

/** A link a client may draw: `http:` or `https:` only. A source that built its own event was never parsed. */
function httpUrl(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function upsertTool(parts: readonly AssistantPart[], id: string, tool: string, status: 'running' | 'done' | 'failed'): AssistantPart[] {
  const part: AssistantPart = { kind: 'tool', id, tool, status };
  return parts.some((p) => p.kind === 'tool' && p.id === id) ? parts.map((p) => (p.kind === 'tool' && p.id === id ? part : p)) : [...parts, part];
}

/** One event applied to one turn. An event this version does not know leaves the turn as it was. */
export function reduceTurn(turn: AssistantTurn, event: AssistantEvent): AssistantTurn {
  switch (event.t) {
    case 'step-start':
      return { ...turn, step: event.step };
    case 'step-end':
      return { ...turn, step: null };
    case 'step-restart':
      return { ...turn, step: event.step, parts: turn.parts.filter((p) => !(p.kind === 'text' && p.step === event.step)) };
    case 'text-start':
      return turn.parts.some((p) => p.kind === 'text' && p.id === event.pid)
        ? turn
        : { ...turn, parts: [...turn.parts, { kind: 'text', id: event.pid, step: turn.step, text: '' }] };
    case 'text-delta':
      return turn.parts.some((p) => p.kind === 'text' && p.id === event.pid)
        ? { ...turn, parts: turn.parts.map((p) => (p.kind === 'text' && p.id === event.pid ? { ...p, text: p.text + event.delta } : p)) }
        : { ...turn, parts: [...turn.parts, { kind: 'text', id: event.pid, step: turn.step, text: event.delta }] };
    case 'tool-input':
      return { ...turn, parts: upsertTool(turn.parts, event.callId, event.tool, 'running') };
    case 'tool-output':
      return { ...turn, parts: upsertTool(turn.parts, event.callId, event.tool, 'done') };
    case 'tool-error':
      return { ...turn, parts: upsertTool(turn.parts, event.callId, event.tool, 'failed') };
    case 'host-event':
      return { ...turn, parts: [...turn.parts, { kind: 'note', id: `note-${turn.parts.length}`, note: event.kind, text: event.text }] };
    case 'source': {
      const citation: AssistantCitation = {
        sid: event.sid,
        title: event.title,
        url: httpUrl(event.url),
        ref: event.ref ?? null,
        kind: event.kind ?? null,
        detail: event.detail || null,
      };
      return turn.citations.some((c) => c.sid === event.sid)
        ? { ...turn, citations: turn.citations.map((c) => (c.sid === event.sid ? citation : c)) }
        : { ...turn, citations: [...turn.citations, citation] };
    }
    case 'data-provenance':
      return { ...turn, provenance: { producedAt: event.producedAt, model: event.model ?? null, sources: event.sources ?? null } };
    case 'budget-notice':
      return event.exhausted ? { ...turn, budgetExhausted: true } : turn;
    case 'turn-finish':
      return { ...turn, status: finishStatus(event.reason), budgetExhausted: turn.budgetExhausted || event.reason === 'budget' };
    case 'turn-error':
      return { ...turn, status: 'failed', failure: { code: event.code, message: event.message || null } };
    default:
      return turn;
  }
}

/** An unknown reason comes to rest as `done`: a pause this version cannot name must offer nothing. */
function finishStatus(reason: string): AssistantTurnStatus {
  if (reason === 'stopped') return 'stopped';
  if (reason === 'budget') return 'budget';
  if (reason === 'awaiting-approval') return 'needs-approval';
  return 'done';
}

/** A turn's answer: its text parts, in order. */
export function answerOf(turn: AssistantTurn): string {
  return turn.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('');
}

/** What to send with a new question: each answered turn, oldest first. A failed one is not repeated to the model. */
export function historyOf(turns: readonly AssistantTurn[]): AssistantHistoryEntry[] {
  return turns.flatMap((turn) => {
    const answer = answerOf(turn);
    if (!answer || turn.status === 'failed' || turn.status === 'ended-early') return [];
    return [
      { role: 'user' as const, text: turn.question },
      { role: 'assistant' as const, text: answer },
    ];
  });
}

/** What moved at the end of the conversation. Null for a first look, which has nothing to compare. */
export function turnChange(before: AssistantSnapshot | null, after: AssistantSnapshot): AssistantTurnChange | null {
  const now = after.turns[after.turns.length - 1];
  if (!before || !now) return null;
  const was = before.turns[before.turns.length - 1];
  const wasRunning = was?.id === now.id && was.status === 'running';
  if (now.status === 'running') return wasRunning ? null : 'started';
  if (!wasRunning) return null;
  return now.status === 'done' ? 'answered' : now.status;
}

/** Why a source threw, from the numeric `status` the package's errors carry. A network failure has none. */
function failureOf(error: unknown): AssistantFailure {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return { code: 'transport', message: null };
  const message = error instanceof Error && error.message ? error.message : null;
  if (status === 401 || status === 403) return { code: 'refused', message };
  if (status === 429) return { code: 'rate-limited', message };
  return { code: status >= 500 ? 'unavailable' : 'failed', message };
}

export class AssistantModel {
  readonly #source: AssistantSource;
  readonly #listeners = new Set<(snapshot: AssistantSnapshot) => void>();
  #snapshot: AssistantSnapshot = { turns: [], running: false, activity: 0, canStop: false };
  #run: { id: number; controller: AbortController } | null = null;
  #nextId = 1;

  constructor(options: { source: AssistantSource }) {
    this.#source = options.source;
  }

  get snapshot(): AssistantSnapshot {
    return this.#snapshot;
  }

  /** Called with the current snapshot now and on every change; returns the unsubscribe. */
  subscribe(listener: (snapshot: AssistantSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  /** Ask. False when there is nothing to send or a run is in flight, so a host knows to keep its field. */
  send(text: string): boolean {
    const question = text.trim();
    if (!question || this.#run) return false;
    const history = historyOf(this.#snapshot.turns);
    const turn = newTurn(this.#nextId++, question);
    void this.#drive(turn, [...this.#snapshot.turns, turn], history);
    return true;
  }

  /** Ask the last question again, in its place. False unless it failed and nothing is running. */
  retry(): boolean {
    const turns = this.#snapshot.turns;
    const last = turns[turns.length - 1];
    if (this.#run || !last || (last.status !== 'failed' && last.status !== 'ended-early')) return false;
    const before = turns.slice(0, -1);
    const turn = newTurn(last.id, last.question);
    void this.#drive(turn, [...before, turn], historyOf(before));
    return true;
  }

  /** End the run here and on the server, when the source can. What was written so far stays. */
  stop(): void {
    if (this.#detach()) void Promise.resolve().then(() => this.#source.cancel?.()).catch(() => undefined);
  }

  /** Stop listening and leave the server to it: for a host going away, not for a person pressing Stop. */
  detach(): void {
    this.#detach();
  }

  #detach(): boolean {
    const run = this.#run;
    if (!run) return false;
    this.#run = null;
    run.controller.abort();
    this.#settle(run.id, (turn) => ({ ...turn, status: 'stopped' }));
    return true;
  }

  async #drive(turn: AssistantTurn, turns: readonly AssistantTurn[], history: readonly AssistantHistoryEntry[]): Promise<void> {
    const controller = new AbortController();
    this.#run = { id: turn.id, controller };
    this.#publish(turns);
    const current = () => this.#run?.controller === controller;
    const finish = (change: (turn: AssistantTurn) => AssistantTurn) => {
      this.#run = null;
      this.#settle(turn.id, change);
    };
    try {
      for await (const event of this.#source.send({ text: turn.question, history }, { signal: controller.signal })) {
        if (!current()) return;
        if (event.t === 'turn-finish' || event.t === 'turn-error') {
          finish((t) => reduceTurn(t, event));
          return;
        }
        this.#apply(turn.id, event);
      }
      if (current()) finish((t) => ({ ...t, status: 'ended-early' }));
    } catch (error) {
      if (current()) finish((t) => ({ ...t, status: 'failed', failure: failureOf(error) }));
    }
  }

  #apply(id: number, event: AssistantEvent): void {
    this.#publish(
      this.#snapshot.turns.map((t) => (t.id === id ? reduceTurn(t, event) : t)),
      1,
    );
  }

  #settle(id: number, change: (turn: AssistantTurn) => AssistantTurn): void {
    this.#publish(this.#snapshot.turns.map((t) => (t.id === id ? change(t) : t)));
  }

  #publish(turns: readonly AssistantTurn[], activity = 0): void {
    const running = this.#run !== null && turns.some((t) => t.id === this.#run?.id && t.status === 'running');
    this.#snapshot = { turns, running, activity: this.#snapshot.activity + activity, canStop: running && this.#source.cancel !== undefined };
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

/**
 * A source that plays a script, for tests, docs and a preview with no backend. `delayMs` spaces
 * the events out, which is how a streaming answer is drawn with nothing streaming behind it.
 */
export function scriptedSource(
  script: readonly AssistantEvent[] | ((turn: AssistantSend) => readonly AssistantEvent[]),
  options: { delayMs?: number; cancel?: () => Promise<void> } = {},
): AssistantSource {
  const { delayMs = 0, cancel } = options;
  return {
    async *send(turn, { signal }) {
      for (const event of typeof script === 'function' ? script(turn) : script) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (signal.aborted) return;
        yield event;
      }
    },
    ...(cancel ? { cancel } : {}),
  };
}
