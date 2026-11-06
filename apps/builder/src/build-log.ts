/**
 * A hosted source build's own record: the steps it reached, every command it ran, and the
 * output of the steps that run the tenant's code. Before this, a build that failed outside
 * a command answered a 500 with no sentence and left nothing but a `console.error` behind,
 * so a failed `substrat push` in CI said "platform build service failed" and no more.
 *
 * The record is kept three ways: in the agent's storage under the build id (written as each
 * step starts, so a reset mid-build still shows how far it got), as one `source.build.log`
 * line in Workers Logs when the build ends, and as the tail in a failed build's answer.
 *
 * Output is kept only for a step that opts in. Git's output can carry authenticated HTTP
 * diagnostics (repositories.ts), so a repository step records its commands and exit codes
 * and never what they printed.
 */
import type { SandboxLike } from '@substrat-run/builder-workspace/edge';
import { CommandFailedError, diagnosedResponse, sourceBuildFailure } from './problem.js';

/** ULID, Web-Crypto only — same wire shape as kernel `ulid()`. */
export function ulid(now = Date.now()): string {
	const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
	let t = now;
	let time = '';
	for (let i = 0; i < 10; i++) {
		time = A[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const rand = crypto.getRandomValues(new Uint8Array(16));
	let out = time;
	for (const b of rand) out += A[b % 32];
	return out;
}

/**
 * The worker names the build before handing it to the agent, so when the agent never
 * answers — its isolate reset, the stub threw — the worker can still say which build
 * stopped, and that id finds the record the agent stored.
 */
export const BUILD_ID_HEADER = 'x-substrat-build-id';

const BUILD_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Whether `id` is shaped like a build id, for a route reading one out of a path. */
export const isBuildId = (id: string): boolean => BUILD_ID.test(id);

/** A build id the worker handed the agent, or a new one when it is absent or malformed. */
export function buildIdFrom(header: string | null): string {
	return header && BUILD_ID.test(header) ? header : ulid();
}

/** Characters of output kept per command, and of the record as a whole. */
export const OUTPUT_TAIL = 4000;
export const RECORD_MAX = 48_000;
/** How many build records an agent keeps before the oldest go. */
export const RECORDS_KEPT = 50;
/** Storage key of one record, and of the index of kept ids (oldest first). */
export const RECORD_PREFIX = 'build-log:';
export const RECORD_INDEX = 'build-logs';

export interface BuildCommand {
	command: string;
	exitCode: number;
	ms: number;
	/** The end of stdout and stderr, only for a step that keeps output. */
	output?: string;
}

export interface BuildStep {
	step: string;
	startedAt: string;
	commands: BuildCommand[];
}

export interface BuildRecord {
	buildId: string;
	/** Null on a build that stopped before it wrote a record of its own. */
	slug: string | null;
	outcome: 'building' | 'built' | 'failed' | 'interrupted';
	steps: BuildStep[];
	/** The failure as the caller was told it. */
	detail?: string;
	/** What the runtime threw when the agent never answered (`interruptionOf`). */
	interruption?: string;
}

const tail = (s: string, n: number): string => (s.length > n ? `…${s.slice(-n)}` : s);

export class BuildLog {
	readonly record: BuildRecord;
	#keepOutput = false;

	constructor(buildId: string, slug: string, private readonly persist: (record: BuildRecord) => Promise<void>, private readonly clock = () => new Date()) {
		this.record = { buildId, slug, outcome: 'building', steps: [] };
	}

	/** The step the build has reached, or none before the first. */
	get step(): string | undefined {
		return this.record.steps.at(-1)?.step;
	}

	/** Starts a step and stores the record, so an interrupted build shows where it stopped. */
	async begin(step: string, opts: { keepOutput?: boolean } = {}): Promise<void> {
		this.#keepOutput = opts.keepOutput ?? false;
		this.record.steps.push({ step, startedAt: this.clock().toISOString(), commands: [] });
		await this.#save();
	}

	/** `sb` with every `exec` recorded under the current step. */
	sandbox(sb: SandboxLike): SandboxLike {
		return {
			...sb,
			exec: async (command, opts) => {
				const started = this.clock().getTime();
				const r = await sb.exec(command, opts);
				const entry: BuildCommand = { command, exitCode: r.exitCode, ms: this.clock().getTime() - started };
				if (this.#keepOutput) entry.output = tail([r.stdout, r.stderr].filter(Boolean).join('\n'), OUTPUT_TAIL);
				(this.record.steps.at(-1) ?? this.#unnamed()).commands.push(entry);
				return r;
			},
		};
	}

	async finish(outcome: 'built' | 'failed', detail?: string): Promise<void> {
		this.record.outcome = outcome;
		if (detail !== undefined) this.record.detail = detail;
		await this.#save();
		// One line per build, whatever its outcome: Workers Logs is where the whole record is searched.
		console.log('source.build.log', JSON.stringify(this.record));
	}

	/** The last lines any step kept, for a failure whose own sentence carries no output. */
	outputTail(lines = 20): string {
		const kept = this.record.steps.flatMap((s) => s.commands).map((c) => c.output).filter(Boolean).join('\n');
		return kept.split('\n').slice(-lines).join('\n');
	}

	#unnamed(): BuildStep {
		const step: BuildStep = { step: 'start', startedAt: this.clock().toISOString(), commands: [] };
		this.record.steps.push(step);
		return step;
	}

	/** The record is the build's account of itself: failing to store it must not fail the build. */
	async #save(): Promise<void> {
		try {
			await this.persist(fitted(this.record));
		} catch (error) {
			console.error('source.build.unstored', { buildId: this.record.buildId, cause: interruptionOf(error) }, error);
		}
	}
}

/** The record cut to `RECORD_MAX`, oldest output first, so it always fits one storage value. */
export function fitted(record: BuildRecord): BuildRecord {
	const copy: BuildRecord = structuredClone(record);
	const outputs = copy.steps.flatMap((s) => s.commands).filter((c) => c.output);
	while (JSON.stringify(copy).length > RECORD_MAX && outputs.length) delete outputs.shift()!.output;
	return copy;
}

/** A failed build's sentence: where it stopped, under which id, and what it printed last. */
export function failureDetail(log: BuildLog, detail: string, opts: { withOutput: boolean }): string {
	const where = `build ${log.record.buildId}${log.step ? `, step "${log.step}"` : ''}`;
	const out = opts.withOutput ? log.outputTail() : '';
	return `${detail} (${where})${out ? `\n--- last build output ---\n${out}` : ''}`;
}

/** `failureDetail` for a thrown error: the retained tail is left out only when the error carries its own output. */
export function errorDetail(log: BuildLog, message: string, error: unknown): string {
	return failureDetail(log, message, { withOutput: !(error instanceof CommandFailedError) });
}

/** Characters of a runtime error kept: its message is the runtime's, of no length we set. */
export const INTERRUPTION_MAX = 1000;

/**
 * What the agent's stub threw, as one line. `retryable` and `overloaded` are the flags workerd
 * sets on a Durable Object error, and they separate a reset from an object refusing work.
 */
export function interruptionOf(error: unknown): string {
	const e = error instanceof Error ? (error as Error & { retryable?: unknown; overloaded?: unknown }) : undefined;
	const flags = [e?.retryable === true && 'retryable', e?.overloaded === true && 'overloaded'].filter(Boolean);
	const text = e ? `${e.name}: ${e.message}` : String(error);
	return `${text.slice(0, INTERRUPTION_MAX)}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
}

/** `handle`'s answer, or a 500 naming the build when a throw gets past `#build`'s own catch. */
export async function orBuildFailure(buildId: string, handle: () => Promise<Response>): Promise<Response> {
	try {
		return await handle();
	} catch (error) {
		const cause = interruptionOf(error);
		console.error('source.build.failed', { buildId, cause }, error);
		return diagnosedResponse(500, `platform build failed: ${sourceBuildFailure(error)} (build ${buildId})`, cause);
	}
}

/**
 * The record of a build the agent never answered for, or null when it has one that already
 * ended: a finished record is the truer account, and this must not overwrite it.
 */
export function interruptedRecord(kept: BuildRecord | undefined, buildId: string, interruption: string): BuildRecord | null {
	if (kept && kept.outcome !== 'building') return null;
	return { ...(kept ?? { buildId, slug: null, steps: [] }), outcome: 'interrupted', interruption };
}

/** The fields a rejected request names: zod puts an unrecognised key in `keys`, with `path` the container. */
export function invalidFields(issues: ReadonlyArray<{ code: string; path: PropertyKey[]; keys?: string[] }>): string[] {
	return issues.flatMap((i) => (i.code === 'unrecognized_keys' && i.keys ? i.keys.map((k) => [...i.path, k].join('.')) : [i.path.join('.') || '(root)']));
}

/**
 * The index of kept records after `buildId` joins it, and the ids that fall out. An index
 * rather than a prefix listing: `storage.list` returns values too, and fifty records is
 * megabytes in an agent whose isolate has already been reset for memory.
 */
export function retained(index: string[], buildId: string): { index: string[]; dropped: string[] } {
	const all = [...index.filter((id) => id !== buildId), buildId];
	const cut = Math.max(0, all.length - RECORDS_KEPT);
	return { index: all.slice(cut), dropped: all.slice(0, cut) };
}
