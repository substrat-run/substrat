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
import type { BuildEvent } from '@substrat-run/builder-generator';
import { formatEvent } from '@substrat-run/builder-generator';
import type { AssistantStreamBody, AssistantStreamEvent } from '@substrat-run/contracts/assistant-stream';
import { STUDIO_HOST, studioScope, type StudioEnv } from './studio.js';

/** Appended in one call at most; the engine takes 200. */
const BATCH = 50;
/** How often buffered events are appended while a turn runs. */
const FLUSH_MS = 5_000;
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

/** The message as `send-message` takes it: at most 32 000 characters and 32 KiB serialized. */
function fitMessage(text: string): string {
	let out = text.length > MESSAGE_MAX ? text.slice(0, MESSAGE_MAX) : text;
	while (byteLength(JSON.stringify(out)) > MESSAGE_BYTES_MAX) out = out.slice(0, Math.floor(out.length * 0.9));
	return out.length < text.length ? `${out.slice(0, -40)}\n…[cut: the message was ${text.length} characters]` : out;
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
	/** The turn's id — the run's lease, and the key a log line names. */
	readonly turnId: string;
	/**
	 * The id of an earlier turn that opened and never finished, when the caller
	 * knows one. That turn still holds the lease; asking under its id closes it
	 * without waiting for the lease to go stale.
	 */
	readonly unfinishedTurnId?: string | null;
	readonly message: string;
	/** Who sent it: the session's subject at the issuer, when the worker passed one. */
	readonly actor: string | null;
	readonly model: string;
}

export type TurnOutcome = { readonly kind: 'done' } | { readonly kind: 'stopped' } | { readonly kind: 'error'; readonly message: string };

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

	private constructor(env: StudioEnv, threadId: string, turn: OpenTurn) {
		this.#env = env;
		this.threadId = threadId;
		this.#runId = turn.turnId;
		this.#log = `record: project ${turn.projectId} turn ${turn.turnId} thread ${threadId}`;
		this.#timer = setInterval(() => void this.flush(), FLUSH_MS);
	}

	static async open(env: StudioEnv, turn: OpenTurn): Promise<TurnRecord | null> {
		try {
			const owner = await studioScope(env);
			const host = await studioScope(env, STUDIO_HOST);
			const threadId =
				turn.threadId ??
				(await owner.invoke<{ id: string }>('assistant/create-thread', { title: clip(turn.title, 200) })).id;
			const send = () => owner.invoke('assistant/send-message', { threadId, text: fitMessage(turn.message) });
			try {
				await send();
			} catch (err) {
				if (reasonOf(err) !== 'turn_in_progress') throw err;
				// The last turn never reached rest: the studio stopped mid-turn. This
				// agent runs one turn at a time, so no run is still holding it: close
				// it under its own lease when it is known, or take the lease over.
				const recovery = turn.unfinishedTurnId ?? `${turn.turnId}-recovery`;
				await host.invoke('assistant/acquire-run', { threadId, runId: recovery, staleMs: 500 });
				await host.invoke('assistant/append-events', {
					threadId,
					runId: recovery,
					events: [{ t: 'turn-error', code: 'interrupted', message: 'The studio stopped before this turn finished.' }],
				});
				await host.invoke('assistant/release-run', { threadId, runId: recovery });
				await send();
			}
			await host.invoke('assistant/acquire-run', { threadId, runId: turn.turnId, staleMs: LEASE_STALE_MS });
			const record = new TurnRecord(env, threadId, turn);
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
					await host.invoke<{ events: AssistantStreamEvent[] }>('assistant/append-events', {
						threadId: this.threadId,
						runId: this.#runId,
						events: batch.slice(i, i + BATCH),
					});
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
				? { t: 'turn-error', code: 'turn_failed', message: clip(outcome.message, TEXT_MAX) }
				: { t: 'turn-finish', reason: outcome.kind },
		);
		await this.flush();
		try {
			const host = await studioScope(this.#env, STUDIO_HOST);
			await host.invoke('assistant/release-run', { threadId: this.threadId, runId: this.#runId });
		} catch (err) {
			console.error(`${this.#log}: lease not released: ${String(err)}`);
		}
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

/** A page of a project's record, after a cursor. */
export async function readRecord(
	env: StudioEnv,
	threadId: string,
	after: number,
): Promise<{ events: AssistantStreamEvent[]; lastSeq: number }> {
	const owner = await studioScope(env);
	return owner.invoke('assistant/read-events', { threadId, after, limit: 500 });
}
