/**
 * The tier-1 gates — builder-studio.md §9.1.
 *
 * These are the checks the generator CANNOT author its own oracle for: the
 * expected output is derived from committed artifacts (PERMISSIONS.md, the API
 * document, the migration list) rather than asserted by whoever wrote the code.
 * That is the entire reason they are trusted and agent-written tests are not
 * (§9.4) — so this runner never reports a gate as passing on anything softer
 * than a zero exit code.
 *
 * Exit-code convention, inherited from boundary-lint and api-diff:
 *   0 = fine · 1 = drift/violation · 2 = the tool could not do its job
 * A `2` is reported as `blocked`, not `failed`: it means we learned nothing, and
 * treating "the checker crashed" as "the code is bad" trains the agent to
 * "fix" the wrong thing.
 */
import type { Workspace } from './workspace.js';

export type GateName =
	| 'typecheck'
	| 'boundary-lint'
	| 'permissions'
	| 'api'
	| 'scenario'
	| 'migration-replay';

export type GateStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

export interface GateResult {
	readonly name: GateName;
	readonly status: GateStatus;
	readonly exitCode: number;
	readonly durationMs: number;
	/** Trimmed combined output — what the generator is shown on failure. */
	readonly output: string;
	/** Why a gate was skipped, when it was. */
	readonly note?: string;
}

export interface GateSpec {
	readonly name: GateName;
	readonly cmd: string;
	/** When present and false at run time, the gate is skipped with `note`. */
	readonly appliesWhen?: (ws: Workspace, verticalDir: string) => Promise<boolean>;
	readonly note?: string;
}

/**
 * The gates as they exist in this repo today. `migration-replay` is specified in
 * generated-verticals.md §6.2 but NOT yet built — it is declared here and
 * reported as `skipped` rather than quietly omitted, so the gap is visible in
 * every run instead of being rediscovered later.
 */
export function defaultGates(verticalDir: string): GateSpec[] {
	return [
		{ name: 'typecheck', cmd: 'pnpm -r typecheck' },
		{ name: 'boundary-lint', cmd: 'node tools/boundary-lint.mjs' },
		{ name: 'permissions', cmd: 'pnpm lint:permissions --check' },
		{
			name: 'api',
			cmd: 'pnpm lint:api --check',
			// api-diff is opt-in per vertical (api-surface.md §3): a vertical without
			// src/api.ts simply is not documented yet, which is not a failure.
			appliesWhen: async (ws) => await ws.exists(`${verticalDir}/src/api.ts`),
			note: 'no src/api.ts — vertical has not opted into the API catalog yet',
		},
		{
			name: 'scenario',
			cmd: `pnpm --filter ./${verticalDir} test`,
			appliesWhen: async (ws) => await ws.exists(`${verticalDir}/test`),
			note: 'no test/ directory in the vertical',
		},
		{
			name: 'migration-replay',
			cmd: '',
			appliesWhen: async () => false,
			note: 'not built — specified in generated-verticals.md §6.2',
		},
	];
}

/**
 * The gates for a STANDALONE project (§4.6) — a vertical in its own repo under
 * `.builder/projects/*`, shaped like `examples/external-vertical`, consuming the
 * kernel and engines as workspace deps rather than living in `demos/`.
 *
 * The monorepo sweeps (`pnpm -r typecheck`, repo-wide boundary-lint, the
 * permission-diff over `demos/`+`apps/`) do not see it, so each gate switches to
 * its per-project form. Where no standalone form exists yet the gate is declared
 * and skipped WITH A NOTE — an invisible gap becomes a visible one (same rule as
 * migration-replay).
 */
export function standaloneGates(projectDir: string): GateSpec[] {
	const pkg = async (ws: Workspace): Promise<boolean> => await ws.exists(`${projectDir}/package.json`);
	return [
		{
			name: 'typecheck',
			cmd: `pnpm --filter ./${projectDir} typecheck`,
			appliesWhen: pkg,
			note: 'no package.json yet — nothing to typecheck',
		},
		{
			// Standalone mode: boundary-lint --root <project> discovers the vertical's
			// own src plus the engines it consumes from node_modules. Exits 2 rather
			// than lying green when there is nothing lintable — reported as blocked.
			name: 'boundary-lint',
			cmd: `node packages/boundary-lint/dist/cli.js --root ${projectDir}`,
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/src`),
			note: 'no src/ yet',
		},
		{
			name: 'permissions',
			cmd: '',
			appliesWhen: async () => false,
			note: 'permission-diff is monorepo tooling; standalone form not built yet',
		},
		{
			name: 'api',
			cmd: '',
			appliesWhen: async () => false,
			note: 'api-diff is monorepo tooling; standalone form not built yet',
		},
		{
			name: 'scenario',
			cmd: `pnpm --filter ./${projectDir} test`,
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/test`),
			note: 'no test/ directory yet',
		},
		{
			name: 'migration-replay',
			cmd: '',
			appliesWhen: async () => false,
			note: 'not built — specified in generated-verticals.md §6.2',
		},
	];
}

const MAX_OUTPUT = 16_000;

function trimOutput(stdout: string, stderr: string): string {
	const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
	if (combined.length <= MAX_OUTPUT) return combined;
	// Keep the tail: compilers and test runners put the useful part last.
	return `…[${combined.length - MAX_OUTPUT} chars trimmed]…\n${combined.slice(-MAX_OUTPUT)}`;
}

export async function runGate(ws: Workspace, spec: GateSpec, verticalDir: string): Promise<GateResult> {
	if (spec.appliesWhen && !(await spec.appliesWhen(ws, verticalDir))) {
		return {
			name: spec.name,
			status: 'skipped',
			exitCode: 0,
			durationMs: 0,
			output: '',
			note: spec.note,
		};
	}

	const started = Date.now();
	const { stdout, stderr, exitCode } = await ws.exec(spec.cmd);
	const durationMs = Date.now() - started;
	const status: GateStatus = exitCode === 0 ? 'passed' : exitCode === 2 ? 'blocked' : 'failed';

	return { name: spec.name, status, exitCode, durationMs, output: trimOutput(stdout, stderr) };
}

export interface GateRun {
	readonly results: readonly GateResult[];
	readonly ok: boolean;
	readonly durationMs: number;
}

/**
 * Runs every gate. Deliberately does NOT stop at the first failure: the generator
 * fixes more per turn when it can see every complaint at once, and these are
 * cheap relative to a model call.
 */
export async function runGates(
	ws: Workspace,
	verticalDir: string,
	gates: readonly GateSpec[] = defaultGates(verticalDir),
	onResult?: (r: GateResult) => void,
): Promise<GateRun> {
	const started = Date.now();
	const results: GateResult[] = [];
	for (const spec of gates) {
		const result = await runGate(ws, spec, verticalDir);
		results.push(result);
		onResult?.(result);
	}
	return {
		results,
		ok: results.every((r) => r.status === 'passed' || r.status === 'skipped'),
		durationMs: Date.now() - started,
	};
}

/** One-line-per-gate summary for a terminal or a chat pane. */
export function formatGateRun(run: GateRun): string {
	const glyph: Record<GateStatus, string> = {
		passed: '✓',
		failed: '✗',
		blocked: '!',
		skipped: '–',
	};
	const lines = run.results.map((r) => {
		const time = r.status === 'skipped' ? '' : ` (${(r.durationMs / 1000).toFixed(1)}s)`;
		const suffix = r.note ? `  ${r.note}` : '';
		return `  ${glyph[r.status]} ${r.name.padEnd(18)}${time}${suffix}`;
	});
	return `${lines.join('\n')}\n  ${run.ok ? 'all gates green' : 'GATES RED'} in ${(run.durationMs / 1000).toFixed(1)}s`;
}
