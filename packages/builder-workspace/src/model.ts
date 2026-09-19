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

export type ModelEmitStatus =
	/** The artifact is now current — written, or already identical. */
	| 'emitted'
	/** No `spec/model.ts`: the model phase has not run. Not a failure. */
	| 'absent'
	/** The emitter could not do its job. Non-fatal — see `emitProjectModel`. */
	| 'failed';

export interface ModelEmitResult {
	readonly status: ModelEmitStatus;
	/** The emitter's combined output, kept only when it failed. */
	readonly output: string;
}

const MAX_OUTPUT = 4_000;

/**
 * Emit `<verticalDir>/model.json` from `<verticalDir>/spec/model.ts`.
 *
 * **Never throws, and a failure never fails the turn.** The artifact is a
 * projection of code the gates already judge: a `spec/model.ts` that cannot be
 * imported is a red `model` gate with a compiler's diagnostics, which says far
 * more than this emitter could. Refusing to commit the turn over it would throw
 * away the work that produced the broken file. The failure is reported, not
 * swallowed — the caller carries it in the turn result.
 */
export async function emitProjectModel(
	ws: Workspace,
	verticalDir: string,
): Promise<ModelEmitResult> {
	if (!(await ws.exists(`${verticalDir}/${MODEL_SOURCE_PATH}`))) {
		return { status: 'absent', output: '' };
	}
	try {
		// The tool runs from the workspace root, where `tools/` and the installed
		// toolchain are — the same calling convention the standalone permission and
		// api gates use.
		const { stdout, stderr, exitCode } = await ws.exec(
			`pnpm exec tsx tools/model-diff.mts --root ${JSON.stringify(verticalDir)}`,
		);
		if (exitCode === 0) return { status: 'emitted', output: '' };
		const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
		return { status: 'failed', output: combined.slice(-MAX_OUTPUT) };
	} catch (e) {
		return { status: 'failed', output: e instanceof Error ? e.message : String(e) };
	}
}
