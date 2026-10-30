/**
 * The project's `model.json` — the entity model as an artifact rather than as
 * TypeScript (#684, #697).
 *
 * The model phase writes `spec/model.ts`, and everything downstream is supposed
 * to read the EMITTED form: that is what keeps the authoring notation swappable,
 * and it is the only form something without a TypeScript runtime can read. The
 * studio's Model tab is exactly such a reader — a browser, holding a snapshot,
 * with no way to execute the project's code — so the artifact has to exist in the
 * tree before the tab can render anything.
 *
 * Emitting it is `tools/model-diff.mts --root <project>`: the same emitter that
 * renders every demo's `model.json`, pointed at one project instead of the sweep.
 * Reusing it rather than re-deriving the JSON here is what keeps the studio's
 * artifact byte-identical to the repo's — a second renderer would be a second
 * answer to "what does this vertical declare".
 *
 * Runs in the turn loop, above the `Workspace` seam, so both run modes produce
 * it: the artifact is committed with the turn, lands in the snapshot the hosted
 * host publishes to R2, and the tab reads it with the container asleep.
 */
import type { Workspace } from './workspace.js';

/** Where the model phase writes the declaration, relative to the vertical dir. */
export const MODEL_SOURCE_PATH = 'spec/model.ts';
/** Where the emitted artifact lands, relative to the vertical dir. */
export const MODEL_ARTIFACT_PATH = 'model.json';
/** The emitter, relative to the workspace root it runs from. */
export const MODEL_EMITTER_PATH = 'tools/model-diff.mts';

export type ModelEmitStatus =
	/** The artifact is now current — written, or already identical. */
	| 'emitted'
	/** No `spec/model.ts`: the model phase has not run. Not a failure. */
	| 'absent'
	/** The emitter refused the declaration. Work is preserved with red gates. */
	| 'failed'
	/**
	 * `check` only: the declaration loads and emits, but `model.json` is not what it
	 * renders to. A recheck does not write, so it cannot fix this; the next model turn
	 * does. Reported, never failed: a gate the user cannot clear is not a verdict.
	 */
	| 'stale'
	/**
	 * The emitter did not run to a verdict (the exec or the probe threw, a container gone
	 * mid-turn, the tool itself crashed). Not the declaration's fault, so not the model's
	 * to repair.
	 */
	| 'blocked'
	/** The workspace root holds no emitter: a `--root` outside this monorepo. */
	| 'unavailable';

export interface ModelEmitResult {
	readonly status: ModelEmitStatus;
	/** The emitter's combined output, kept only when it did not emit. */
	readonly output: string;
}

const MAX_OUTPUT = 4_000;
/** The line `tools/model-diff.mts` prints when `--check` finds the artifact stale. */
const MODEL_STALE = /^model-diff: .+ is stale — re-run /m;

/**
 * Emit `<verticalDir>/model.json` from `<verticalDir>/spec/model.ts`.
 *
 * Pass `check` to validate the existing artifact without writing it (gate rechecks).
 * **Never throws.** `runGates` reports a failed emission as a red `model-emit`
 * gate while still committing the work by default. Typechecking alone cannot
 * establish that the module loads or that its artifact was produced.
 *
 * A failure also leaves the PREVIOUS artifact in place, deliberately — deleting it
 * would blank the tab over a transient container hiccup, and the last good picture
 * is worth more than no picture. But a stale picture presented as current is the
 * kind of quiet lie this repo does not accept, so the failure is neither swallowed
 * nor left for a caller to discard: `modelEmitWarning` turns it into the sentence
 * both hosts put in the turn's transcript, beside the red gate it accompanies.
 */
export async function emitProjectModel(
	ws: Workspace,
	verticalDir: string,
	opts: { readonly check?: boolean } = {},
): Promise<ModelEmitResult> {
	try {
		// The probe is INSIDE the guard: a workspace that cannot answer `exists`
		// (a container that went away mid-turn) must not abort the turn either —
		// "never throws" has to hold for the whole function, not for the part after
		// the first await.
		if (!(await ws.exists(`${verticalDir}/${MODEL_SOURCE_PATH}`))) {
			return { status: 'absent', output: '' };
		}
		if (!(await ws.hasTool(MODEL_EMITTER_PATH))) return { status: 'unavailable', output: '' };
		// The tool runs from the workspace root, where `tools/` and the installed
		// toolchain are — the same calling convention the standalone permission and
		// api gates use.
		const { stdout, stderr, exitCode } = await ws.exec(
			`pnpm exec tsx ${MODEL_EMITTER_PATH} --root ${JSON.stringify(verticalDir)}${opts.check ? ' --check' : ''}`,
		);
		if (exitCode === 0) return { status: 'emitted', output: '' };
		const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n').slice(-MAX_OUTPUT);
		// The emitter's 0/1/2: a module that will not load is 2, and stays the declaration's
		// failure. 1 is drift only when the emitter says so — node exits 1 on any uncaught
		// throw too (the tool's own failure to load, an unreadable artifact), and reading
		// that as a stale artifact would pass a check that never ran.
		if (exitCode === 1) {
			return opts.check && MODEL_STALE.test(stderr)
				? { status: 'stale', output: combined }
				: { status: 'blocked', output: combined };
		}
		return { status: 'failed', output: combined };
	} catch (e) {
		return { status: 'blocked', output: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * The one sentence a host puts in the transcript when the emit failed, or null
 * when there is nothing to say.
 *
 * It lives here rather than in each host so the two cannot word it differently,
 * and it is a plain string rather than an event so `builder-workspace` keeps
 * knowing nothing about the generator's event union.
 *
 * What it has to convey is the STALENESS, not the failure: the red `model-emit` gate
 * beside it already says the declaration is broken, and what a builder cannot
 * otherwise discover is that the Model tab is still showing the picture from
 * before this turn.
 */
export function modelEmitWarning(result: ModelEmitResult): string | null {
	if (result.status !== 'failed' && result.status !== 'blocked') return null;
	return (
		`${MODEL_ARTIFACT_PATH} could not be re-emitted from ${MODEL_SOURCE_PATH}, so the Model tab ` +
		`still shows the entity model from before this turn.\n${result.output}`
	);
}
