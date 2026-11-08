/**
 * A project's migrations, generated from its model (`tools/migrations-emit.mts --root`), as
 * `model.json` is: `journal.json` is the record and `src/migrations.generated.ts` the shape the
 * kernel registers, so a build never writes DDL for the model's tables and the two cannot disagree.
 * Runs in the turn loop beside the model emit, so both run modes produce it.
 */
import type { Workspace } from './workspace.js';
import type { ModelEmitResult } from './model.js';

/** The emitter, relative to the workspace root it runs from. */
export const MIGRATIONS_EMITTER_PATH = 'tools/migrations-emit.mts';

const MAX_OUTPUT = 4_000;

/**
 * Emit (or, with `check`, compare) `<verticalDir>/journal.json` and its module from
 * `<verticalDir>/spec/model.ts`. Never throws: a failure is the gate's to report.
 */
export async function emitProjectMigrations(
	ws: Workspace,
	verticalDir: string,
	opts: { readonly check?: boolean } = {},
): Promise<ModelEmitResult> {
	try {
		if (!(await ws.exists(`${verticalDir}/spec/model.ts`))) return { status: 'absent', output: '' };
		if (!(await ws.hasTool(MIGRATIONS_EMITTER_PATH))) return { status: 'unavailable', output: '' };
		const { stdout, stderr, exitCode } = await ws.exec(
			`pnpm exec tsx ${MIGRATIONS_EMITTER_PATH} --root ${JSON.stringify(verticalDir)}${opts.check ? ' --check' : ''}`,
		);
		if (exitCode === 0) return { status: 'emitted', output: '' };
		const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n').slice(-MAX_OUTPUT);
		if (exitCode === 1) return opts.check && /is (stale|behind)/.test(stderr) ? { status: 'stale', output: combined } : { status: 'blocked', output: combined };
		return { status: 'failed', output: combined };
	} catch (e) {
		return { status: 'blocked', output: e instanceof Error ? e.message : String(e) };
	}
}
