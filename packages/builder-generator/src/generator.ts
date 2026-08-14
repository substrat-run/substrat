/**
 * The generator seam — builder-studio.md §5.2, decision D-49.
 *
 * `VerticalGenerator` is where the LLM binds. The provider brings its own harness;
 * we own the `Workspace` it acts through and the `BuildEvent` union it speaks.
 * Nothing above this interface knows which model ran.
 *
 * Why the seam is here and not at the message level (§5.2): the prompt is files
 * (the two skills, spec/concept.md) and the verification is exit codes (§9.1), so
 * both are already provider-neutral for free. The only real question was where the
 * *harness* binds — and since running any LLM is a hard requirement, Claude-only
 * harnesses (Agent SDK, Managed Agents) cannot be the core. They remain valid
 * implementations of this interface.
 */
import type { Workspace } from '@substrat-run/builder-workspace';
import type { BuildEvent } from './events.js';

export interface GeneratorInput {
	/** The workspace the model acts through. Its methods are the model's tools. */
	readonly workspace: Workspace;
	/** Directory of the vertical under construction, relative to the workspace root. */
	readonly verticalDir: string;
	/** The approved concept document (spec/concept.md), or the opening brief on turn 1. */
	readonly concept: string;
	/** This turn's message from the builder. */
	readonly message: string;
	/**
	 * Host-computed project map (file list, recent commits, last diff) — cheap
	 * git output that saves the model from re-discovering the project with
	 * list_files/read_file every turn. Volatile: placed AFTER the cache
	 * breakpoints, never inside the stable prefix.
	 */
	readonly workspaceBrief?: string;
	/** Prior turns. Opaque to callers; each implementation owns its own shape. */
	readonly history?: readonly GeneratorTurn[];
	readonly signal?: AbortSignal;
}

/** One prior exchange, kept provider-neutral so a session can outlive a swap. */
export interface GeneratorTurn {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

export interface VerticalGenerator {
	/** Stable identifier for logs and evals, e.g. `ai-sdk:anthropic/claude-opus-5`. */
	readonly id: string;
	/** Drive one turn to completion, streaming events as they happen. */
	run(input: GeneratorInput): AsyncIterable<BuildEvent>;
}

/** Collect a run into an array — for evals and tests, never for the UI. */
export async function collect(events: AsyncIterable<BuildEvent>): Promise<BuildEvent[]> {
	const out: BuildEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

/**
 * A generator that does nothing, for wiring tests and for proving the studio's
 * plumbing without spending tokens. Not a mock of a real provider — it makes no
 * claim about behaviour, only about the shape of the stream.
 */
export class NullGenerator implements VerticalGenerator {
	readonly id = 'null';
	async *run(input: GeneratorInput): AsyncIterable<BuildEvent> {
		yield {
			type: 'assistant-text',
			text: `NullGenerator: would act on ${input.verticalDir} for "${input.message}"`,
		};
	}
}
