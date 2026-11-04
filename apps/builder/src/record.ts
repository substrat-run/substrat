/**
 * The record of a project's conversation — every turn, kept (engine-assistant).
 *
 * Before this, a turn's events existed only on the NDJSON stream to whichever
 * browser was open, and the chat history kept a turn's text only when the turn
 * succeeded. A turn that failed, was stopped or was never watched left nothing
 * but an unattributed line in the worker log, so "what happened with this
 * builder" had no answer. Now each project has one assistant thread in the
 * studio scope (studio.ts), and a turn writes into it as it runs:
 *
 *   - the message, as the user's side (`send-message`, written as the studio's
 *     recorder, which owns every project thread), then who sent it;
 *   - the model's prose as text parts, one part per uninterrupted run of text;
 *   - everything else the turn did — tool calls, files written, checks, gates,
 *     commits, phase, usage, a truncation, a repair prompt — as `host-event`s,
 *     each with a one-line `text` and the event itself as `data`;
 *   - and how it ended: `turn-finish` (`done` or `stopped`), or `turn-error`.
 *
 * Closing a turn also leaves one summary row for it (turns.ts) — team, project,
 * outcome, the gates its last run left red, where its events sit in the thread —
 * which is what a reader filters on before it opens a turn here.
 *
 * The assistant's side is written by the turn loop's system principal under
 * the run lease, so nothing a person can call writes it.
 *
 * Recording is BEST-EFFORT, as metering is: the turn's product is the commit,
 * and the record must never fail it. Events are buffered and appended in
 * batches; a failed append is logged with the project and turn, and the turn
 * goes on. A turn that died before it finished (the DO was evicted mid-turn)
 * is closed as `turn-error` `interrupted` by the next turn, which is the only
 * moment anyone can know it will never finish.
 */
import type { BuildEvent, BuildEventOf } from '@substrat-run/builder-generator';
import { formatEvent } from '@substrat-run/builder-generator';
import type { AssistantStreamBody, AssistantStreamEvent } from '@substrat-run/contracts/assistant-stream';
import { STUDIO_HOST, studioScope, type StudioEnv } from './studio.js';
import type { BuilderRedGate, BuilderTurn, BuilderTurnInput, BuilderTurnOutcome, Page } from '@substrat-run/contracts';

/** Appended in one call at most; the engine takes 200. */
const BATCH = 50;
/** How often buffered events are appended while a turn runs. */
const FLUSH_MS = 5_000;
/**
 * How long a turn waits for its record to open. The record is best-effort: a
 * studio scope that is slow or stuck must not hold the turn up, so past this
 * the turn runs unrecorded (logged), and the next turn closes the one it left.
 */
const OPEN_TIMEOUT_MS = 10_000;
/**
 * The lease's staleness. A turn can sit in one long command with nothing to
 * append; the BuilderAgent runs one turn at a time per team, so another run
 * never contends for the lease — the default 15 s would only invite a takeover.
 */
const LEASE_STALE_MS = 600_000;
/** The engine's bounds, kept under: text-delta characters, user-message characters, host-event text. */
const DELTA_MAX = 16_000;
const MESSAGE_MAX = 32_000;
const MESSAGE_BYTES_MAX = 32 * 1024;
const TEXT_MAX = 2_000;
/** A host-event's `data` bound is 16 KiB serialized; anything larger keeps a preview. */
const DATA_BYTES_MAX = 16 * 1024 - 512;

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

function clip(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** The event as `data`, or a bounded preview of it when it is too large for a row. */
function fit(value: unknown): unknown {
	const text = JSON.stringify(value);
	const bytes = byteLength(text);
	if (bytes <= DATA_BYTES_MAX) return value;
	return { truncated: true, bytes, preview: text.slice(0, DATA_BYTES_MAX / 4) };
}

/**
 * The message as `send-message` takes it: at most 32 000 characters and 32 KiB
 * serialized. A longer one keeps its head and says it was cut — both bounds are
 * judged on the final string, note included, so the cut message always fits.
 */
export function fitMessage(text: string): string {
	const fits = (s: string) => s.length <= MESSAGE_MAX && byteLength(JSON.stringify(s)) <= MESSAGE_BYTES_MAX;
	if (fits(text)) return text;
	const note = `\n…[cut: the message was ${text.length} characters]`;
	let keep = Math.min(text.length, MESSAGE_MAX - note.length);
	while (keep > 0 && !fits(text.slice(0, keep) + note)) keep = Math.floor(keep * 0.9);
	return text.slice(0, keep) + note;
}

function hostEvent(kind: string, text: string, data?: unknown): AssistantStreamBody {
	return { t: 'host-event', kind, text: clip(text, TEXT_MAX), ...(data === undefined ? {} : { data: fit(data) }) };
}

/** A conflict refusal's reason, as the engine raises it. */
function reasonOf(err: unknown): unknown {
	return (err as { extensions?: { reason?: unknown } }).extensions?.reason;
}

export interface OpenTurn {
	/** The project's thread, or null on its first recorded turn. */
	readonly threadId: string | null;
	/** The thread's title when it is created. */
	readonly title: string;
	readonly projectId: string;
	/** The team (= tenant) the project belongs to — the summary's first filter. */
	readonly tenantId: string;
	/** The turn's id — the run's lease, and the key a log line names. */
	readonly turnId: string;
	/**
	 * The id of an earlier turn that opened and never finished, when the caller
	 * knows one. That turn still holds the lease; asking under its id closes it
	 * without waiting for the lease to go stale.
	 */
	readonly unfinishedTurnId?: string | null;
	/** Where that unfinished turn's events begin in the thread, when the caller kept it. */
	readonly unfinishedFirstSeq?: number | null;
	readonly message: string;
	/** Who sent it: the session's subject at the issuer, when the worker passed one. */
	readonly actor: string | null;
	readonly model: string;
}

/** How a turn ended. A failure's message is the turn's fatal `error` event, already recorded. */
export type TurnOutcome = { readonly kind: 'done' | 'stopped' | 'error' };

/** A red gate's first line: what a list of turns shows before anyone opens one. */
const GATE_LINE_MAX = 400;

/** The gates a run did not pass, each with the first line it printed (or its note). */
export function redGatesOf(run: BuildEventOf<'gates'>['run']): BuilderRedGate[] {
	return run.results
		.filter((r): r is typeof r & { status: 'failed' | 'blocked' } => r.status === 'failed' || r.status === 'blocked')
		.slice(0, 32)
		.map((r) => {
			const first = r.output.split('\n').find((l) => l.trim()) ?? r.note ?? '';
			return { name: r.name, status: r.status, line: clip(first.trim(), GATE_LINE_MAX) };
		});
}

/** Write a turn's summary row. Best-effort, like the record itself: never throws. */
async function recordSummary(env: StudioEnv, summary: BuilderTurnInput): Promise<void> {
	try {
		const owner = await studioScope(env);
		await owner.invoke('studio/record-turn', summary);
	} catch (err) {
		console.error(`record: project ${summary.projectId} turn ${summary.turnId}: summary not recorded: ${String(err)}`);
	}
}

/**
 * One turn being written into its project's thread. `open` returns null when
 * the record cannot be opened, and the turn runs unrecorded (logged).
 */
export class TurnRecord {
	readonly threadId: string;
	readonly #env: StudioEnv;
	readonly #log: string;
	readonly #runId: string;
	#pending: AssistantStreamBody[] = [];
	#chain: Promise<void> = Promise.resolve();
	#timer: ReturnType<typeof setInterval>;
	/** The open text part's id, while the model is mid-prose. */
	#pid: string | null = null;
	#parts = 0;
	#finished = false;
	/** The last fatal `error` event's message — what a failed turn ends with. */
	#failure: string | null = null;
	/** What the summary row says about the turn, gathered as its events pass. */
	readonly #turn: OpenTurn;
	readonly #startedAt = new Date().toISOString();
	/** Where this turn's events begin in its thread. */
	readonly firstSeq: number;
	#lastSeq: number;
	#phaseStart: string | null = null;
	#phaseEnd: string | null = null;
	#gates: BuildEventOf<'gates'>['run'] | null = null;
	#repairs = 0;
	#truncated = false;
	#commit: string | null = null;
	#inputTokens = 0;
	#outputTokens = 0;

	private constructor(env: StudioEnv, threadId: string, turn: OpenTurn, firstSeq: number) {
		this.#env = env;
		this.threadId = threadId;
		this.#runId = turn.turnId;
		this.#turn = turn;
		this.firstSeq = firstSeq;
		this.#lastSeq = firstSeq;
		this.#log = `record: project ${turn.projectId} turn ${turn.turnId} thread ${threadId}`;
		this.#timer = setInterval(() => void this.flush(), FLUSH_MS);
	}

	static async open(env: StudioEnv, turn: OpenTurn): Promise<TurnRecord | null> {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise<null>((resolve) => {
			timer = setTimeout(() => {
				console.error(`record: project ${turn.projectId} turn ${turn.turnId} not opened within ${OPEN_TIMEOUT_MS} ms`);
				resolve(null);
			}, OPEN_TIMEOUT_MS);
		});
		try {
			return await Promise.race([TurnRecord.#open(env, turn), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	static async #open(env: StudioEnv, turn: OpenTurn): Promise<TurnRecord | null> {
		try {
			const owner = await studioScope(env);
			const host = await studioScope(env, STUDIO_HOST);
			const threadId =
				turn.threadId ??
				(await owner.invoke<{ id: string }>('assistant/create-thread', { title: clip(turn.title, 200) })).id;
			const send = () =>
				owner.invoke<{ firstSeq: number }>('assistant/send-message', { threadId, text: fitMessage(turn.message) });
			let sent: { firstSeq: number };
			try {
				sent = await send();
			} catch (err) {
				if (reasonOf(err) !== 'turn_in_progress') throw err;
				// The last turn never reached rest: the studio stopped mid-turn. This
				// agent runs one turn at a time, so no run is still holding it: close
				// it under its own lease when it is known, or take the lease over.
				const recovery = turn.unfinishedTurnId ?? `${turn.turnId}-recovery`;
				await host.invoke('assistant/acquire-run', { threadId, runId: recovery, staleMs: 500 });
				const closed = await host.invoke<{ events: AssistantStreamEvent[] }>('assistant/append-events', {
					threadId,
					runId: recovery,
					events: [{ t: 'turn-error', code: 'interrupted', message: 'The studio stopped before this turn finished.' }],
				});
				await host.invoke('assistant/release-run', { threadId, runId: recovery });
				// Only a turn the caller named has an id a summary could be found by.
				if (turn.unfinishedTurnId) {
					await recordSummary(env, {
						...unknownTurn(turn, turn.unfinishedTurnId, threadId),
						// Its events run from where it began to the turn-error that closes it, so the
						// turn opens like any other; without a start, it opens empty.
						firstSeq: turn.unfinishedFirstSeq ?? null,
						lastSeq: turn.unfinishedFirstSeq != null ? (closed.events.at(-1)?.id ?? null) : null,
					});
				}
				sent = await send();
			}
			await host.invoke('assistant/acquire-run', { threadId, runId: turn.turnId, staleMs: LEASE_STALE_MS });
			const record = new TurnRecord(env, threadId, turn, sent.firstSeq);
			record.#push(
				hostEvent('turn-context', `sent by ${turn.actor ?? 'an unknown session'} · ${turn.model}`, {
					actor: turn.actor,
					model: turn.model,
					turnId: turn.turnId,
				}),
			);
			return record;
		} catch (err) {
			console.error(`record: could not open project ${turn.projectId} turn ${turn.turnId}: ${String(err)}`);
			return null;
		}
	}

	/** One event from the turn loop, as it was streamed. */
	event(e: BuildEvent): void {
		if (e.type === 'thinking') return; // presence only, never content
		if (e.type === 'error' && e.fatal) this.#failure = e.message;
		if (e.type === 'phase') {
			this.#phaseStart ??= e.phase;
			this.#phaseEnd = e.phase;
		}
		if (e.type === 'gates') this.#gates = e.run;
		if (e.type === 'commit') this.#commit = e.sha;
		if (e.type === 'truncated') this.#truncated = true;
		if (e.type === 'usage') {
			this.#inputTokens += e.inputTokens;
			this.#outputTokens += e.outputTokens;
		}
		if (e.type === 'assistant-text') {
			if (!this.#pid) {
				this.#pid = `p${++this.#parts}`;
				this.#push({ t: 'text-start', pid: this.#pid });
			}
			for (let i = 0; i < e.text.length; i += DELTA_MAX) {
				this.#push({ t: 'text-delta', pid: this.#pid, delta: e.text.slice(i, i + DELTA_MAX) });
			}
			return;
		}
		this.#closeText();
		this.#push(hostEvent(e.type, formatEvent(e), e));
	}

	/** Something the studio did that is not a BuildEvent — a repair or continuation prompt. */
	note(kind: string, text: string, data?: unknown): void {
		if (kind === 'repair-prompt') this.#repairs += 1;
		this.#closeText();
		this.#push(hostEvent(kind, text, data));
	}

	/** Append what is buffered. Serial, so the record keeps the stream's order. */
	flush(): Promise<void> {
		const batch = this.#pending.splice(0);
		if (!batch.length) return this.#chain;
		this.#chain = this.#chain.then(async () => {
			try {
				const host = await studioScope(this.#env, STUDIO_HOST);
				for (let i = 0; i < batch.length; i += BATCH) {
					const appended = await host.invoke<{ events: AssistantStreamEvent[] }>('assistant/append-events', {
						threadId: this.threadId,
						runId: this.#runId,
						events: batch.slice(i, i + BATCH),
					});
					this.#lastSeq = appended.events.at(-1)?.id ?? this.#lastSeq;
				}
			} catch (err) {
				console.error(`${this.#log}: ${batch.length} events not recorded: ${String(err)}`);
			}
		});
		return this.#chain;
	}

	/** End the turn in the record and give the lease back. Never throws. */
	async finish(outcome: TurnOutcome): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		clearInterval(this.#timer);
		this.#closeText();
		this.#push(
			outcome.kind === 'error'
				? { t: 'turn-error', code: 'turn_failed', message: clip(this.#failure ?? 'The turn failed.', TEXT_MAX) }
				: { t: 'turn-finish', reason: outcome.kind },
		);
		await this.flush();
		try {
			const host = await studioScope(this.#env, STUDIO_HOST);
			await host.invoke('assistant/release-run', { threadId: this.threadId, runId: this.#runId });
		} catch (err) {
			console.error(`${this.#log}: lease not released: ${String(err)}`);
		}
		await recordSummary(this.#env, this.#summary(outcome.kind));
	}

	#summary(outcome: BuilderTurnOutcome): BuilderTurnInput {
		const turn = this.#turn;
		return {
			turnId: turn.turnId,
			tenantId: turn.tenantId,
			projectId: turn.projectId,
			projectName: clip(turn.title, 200),
			threadId: this.threadId,
			firstSeq: this.firstSeq,
			lastSeq: this.#lastSeq,
			model: clip(turn.model, 200),
			phaseStart: this.#phaseStart,
			phaseEnd: this.#phaseEnd,
			outcome,
			failure: outcome === 'error' ? clip(this.#failure ?? 'The turn failed.', TEXT_MAX) : null,
			gatesOk: this.#gates ? this.#gates.ok : null,
			redGates: this.#gates ? redGatesOf(this.#gates) : [],
			repairs: this.#repairs,
			truncated: this.#truncated,
			commitSha: this.#commit,
			inputTokens: this.#inputTokens,
			outputTokens: this.#outputTokens,
			startedAt: this.#startedAt,
		};
	}

	#closeText(): void {
		if (!this.#pid) return;
		this.#push({ t: 'text-end', pid: this.#pid });
		this.#pid = null;
	}

	#push(body: AssistantStreamBody): void {
		this.#pending.push(body);
		if (this.#pending.length >= BATCH) void this.flush();
	}
}

/** The summary of a turn the studio lost track of: only where it was, and that it never finished. */
function unknownTurn(turn: OpenTurn, turnId: string, threadId: string): BuilderTurnInput {
	return {
		turnId,
		tenantId: turn.tenantId,
		projectId: turn.projectId,
		projectName: clip(turn.title, 200),
		threadId,
		firstSeq: null,
		lastSeq: null,
		model: '',
		phaseStart: null,
		phaseEnd: null,
		outcome: 'interrupted',
		failure: 'The studio stopped before this turn finished.',
		gatesOk: null,
		redGates: [],
		repairs: 0,
		truncated: false,
		commitSha: null,
		inputTokens: 0,
		outputTokens: 0,
		startedAt: null,
	};
}

/** A page of a project's record, after a cursor. */
export async function readRecord(
	env: StudioEnv,
	threadId: string,
	after: number,
): Promise<{ events: AssistantStreamEvent[]; lastSeq: number }> {
	const owner = await studioScope(env);
	return owner.invoke('assistant/read-events', { threadId, after, limit: 500 });
}

/** At most this many of a turn's events in one read — a turn's repair passes stay well under it. */
const TURN_EVENTS_MAX = 5_000;

/** A page of turn summaries, studio-wide (turns.ts's `studio/list-turns`). */
export async function listTurns(env: StudioEnv, query: Record<string, unknown>): Promise<Page<BuilderTurn>> {
	const owner = await studioScope(env);
	return owner.invoke('studio/list-turns', query);
}

/**
 * One turn: its summary, and its events out of its project's thread — exactly
 * the `firstSeq`..`lastSeq` range the summary names. Null when no turn has that id.
 */
export async function readTurn(
	env: StudioEnv,
	turnId: string,
): Promise<{ turn: BuilderTurn; events: AssistantStreamEvent[]; cut: boolean } | null> {
	const owner = await studioScope(env);
	const turn = await owner.invoke<BuilderTurn | null>('studio/get-turn', { turnId });
	if (!turn) return null;
	const { threadId, firstSeq, lastSeq } = turn;
	if (!threadId || firstSeq === null || lastSeq === null) return { turn, events: [], cut: false };
	const events: AssistantStreamEvent[] = [];
	let after = firstSeq - 1;
	while (after < lastSeq && events.length < TURN_EVENTS_MAX) {
		const page = await readRecord(env, threadId, after);
		events.push(...page.events.filter((e) => e.id <= lastSeq));
		if (page.lastSeq <= after) break;
		after = page.lastSeq;
	}
	return { turn, events: events.slice(0, TURN_EVENTS_MAX), cut: after < lastSeq };
}
