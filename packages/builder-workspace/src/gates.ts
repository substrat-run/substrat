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
 * Exit-code convention, owned by Substrat's OWN checkers (boundary-lint,
 * lint:permissions, lint:api):
 *   0 = fine · 1 = drift/violation · 2 = the tool could not do its job
 * A `2` is reported as `blocked`, not `failed`: it means we learned nothing, and
 * treating "the checker crashed" as "the code is bad" trains the agent to
 * "fix" the wrong thing.
 *
 * That convention is opt-in PER GATE (`exitConvention: 'substrat'`) because
 * external tools do not speak it: tsc exits 2 on ordinary type errors, so a
 * blanket "2 = blocked" silently disarmed the repair loop for exactly the gate
 * that fails most — the model was told "this is NOT a code problem" about its
 * own type errors. Default: every nonzero exit is a plain failure.
 */
import type { Workspace } from './workspace.js';

export type GateName =
	| 'install'
	| 'model'
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
	/**
	 * Exit-code dialect. `'substrat'` = the 0/1/2 convention above (2 → blocked);
	 * only our own checkers speak it. Absent = binary: any nonzero exit is
	 * `failed`. Misclassifying a crashed external checker as failed shows the
	 * model some noise; the reverse (tsc's exit-2 type errors as blocked) mutes
	 * the repair loop entirely — so binary is the default.
	 */
	readonly exitConvention?: 'substrat';
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
		{ name: 'boundary-lint', cmd: 'node tools/boundary-lint.mjs', exitConvention: 'substrat' },
		{ name: 'permissions', cmd: 'pnpm lint:permissions --check', exitConvention: 'substrat' },
		{
			name: 'api',
			cmd: 'pnpm lint:api --check',
			exitConvention: 'substrat',
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
/**
 * Does this project declare a permission surface for `permission-diff` to render?
 *
 * The tool's own discovery rule (`substrat.permissions` in package.json), asked
 * here so the gate SKIPS with a note rather than reporting `blocked` on a project
 * that has not written a module yet — a scaffold mid-build is not a broken
 * checker. Once the entry exists, every way the render can fail is the tool's
 * exit 2, which the substrat convention reports as blocked.
 *
 * An unreadable or malformed package.json answers false: the `typecheck` and
 * `install` gates own that failure and say so far better than a permission gate
 * would.
 */
async function declaresPermissions(ws: Workspace, projectDir: string): Promise<boolean> {
	try {
		const pkg = JSON.parse(await ws.readFile(`${projectDir}/package.json`)) as {
			substrat?: { permissions?: string };
		};
		return typeof pkg.substrat?.permissions === 'string';
	} catch {
		return false;
	}
}

export function standaloneGates(projectDir: string): GateSpec[] {
	const pkg = async (ws: Workspace): Promise<boolean> => await ws.exists(`${projectDir}/package.json`);
	return [
		{
			// The model phase's gate (#680). Typechecking `spec/model.ts` IS the
			// check: `defineEntities` / `defineOperations` carry the reference
			// integrity in their types, so a parent that names no entity, an
			// `entityIdFrom` that names no output field, or a payload carrying an
			// erasable field are all compile errors here — before a line of the
			// module exists.
			name: 'model',
			cmd: `pnpm --filter ./${projectDir} exec tsc --noEmit spec/model.ts`,
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/spec/model.ts`),
			note: 'no spec/model.ts yet — the model phase has not run',
		},
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
			exitConvention: 'substrat',
		},
		{
			// Standalone mode (#628): `permission-diff --root <project>` renders the
			// project's OWN PERMISSIONS.md from the `substrat.permissions` entry its
			// package.json declares, instead of sweeping demos/+apps/. Same render, same
			// string-equality drift check, same 0/1/2 — only the discovery differs, so a
			// generated vertical's permission surface reaches the same human checkpoint
			// every demo's does.
			name: 'permissions',
			cmd: `pnpm exec tsx tools/permission-diff.mts --root ${projectDir} --check`,
			appliesWhen: (ws) => declaresPermissions(ws, projectDir),
			note: 'no substrat.permissions entry in package.json — no permission surface declared yet',
			exitConvention: 'substrat',
		},
		{
			// api-diff is opt-in per vertical (api-surface.md §3), exactly as in the
			// monorepo gates: a vertical without src/api.ts is not documented yet, which
			// is not a failure.
			name: 'api',
			cmd: `pnpm exec tsx tools/api-diff.mts --root ${projectDir} --check`,
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/src/api.ts`),
			note: 'no src/api.ts — vertical has not opted into the API catalog yet',
			exitConvention: 'substrat',
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
	const status: GateStatus =
		exitCode === 0
			? 'passed'
			: spec.exitConvention === 'substrat' && exitCode === 2
				? 'blocked'
				: 'failed';

	return { name: spec.name, status, exitCode, durationMs, output: trimOutput(stdout, stderr) };
}

/**
 * Dependency install is a HOST responsibility, not a model chore. A fresh
 * project under `.builder/projects/*` becomes a workspace member after the
 * image (or a local checkout) last ran `pnpm install`, so its `workspace:*`
 * deps resolve only after another install — and leaving that to the model by
 * prompt alone loses to the step ceiling, after which every gate fails with
 * phantom module-not-found errors. `runTurn` calls this when the turn touched
 * a package.json or the vertical has one with no node_modules. Reported as a
 * GateResult so a genuinely failed install (bad version spec, registry down)
 * reaches the model with pnpm's own output instead of as type errors.
 */
export async function runInstall(ws: Workspace): Promise<GateResult> {
	const started = Date.now();
	const { stdout, stderr, exitCode } = await ws.exec('pnpm install');
	return {
		name: 'install',
		status: exitCode === 0 ? 'passed' : 'failed',
		exitCode,
		durationMs: Date.now() - started,
		output: trimOutput(stdout, stderr),
	};
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

// ── feeding the oracle back to the model (builder-harness.md H5) ─────────────
//
// The gates run at turn end, but their verdict must not die in the UI: the
// model is the only party who can act on a red typecheck, and the studio's
// audience (a non-technical builder) can do nothing with raw lint output. Two
// consumers share these helpers, and the POLICY lives here — above the seam —
// so the server and the dev CLI cannot drift:
//
//   1. `gateReport(run)` — the model-facing report of a red run, carried into
//      the NEXT turn's volatile context (rides with the workspace brief).
//   2. `gateRepairPrompt(run, n, max)` — the host-authored message that drives
//      an in-turn repair attempt. Recorded in the durable history verbatim, so
//      the transcript stays truthful about who said what.

/**
 * Ceiling on host-driven repair attempts per turn. Every attempt is a full
 * billable model run, so this cap is a billing control as much as a safety
 * one — after it, the red state is surfaced honestly instead of silently
 * burning the builder's budget (aider caps its edit reflections at 3 for the
 * same reason).
 */
export const MAX_GATE_REPAIRS = 2;

/**
 * True when a repair attempt could help: at least one gate FAILED. `blocked`
 * (exit 2) is deliberately excluded — it means the checker could not do its
 * job, and asking the model to "fix" that trains it to fix the wrong thing
 * (same reasoning as the status split above).
 */
export function repairNeeded(run: GateRun): boolean {
	return run.results.some((r) => r.status === 'failed');
}

/**
 * Ceiling on host-driven continuation passes per turn (builder-harness.md H6).
 * A pass that ends `truncated` was cut by the step ceiling mid-work — that is
 * "not done yet", not "done but broken", so the host continues it BEFORE the
 * gates run. Without this, a big scaffold spends the whole repair budget on
 * mere continuation (the gates go red on incompleteness, and the repair
 * prompt's "fix the failures" framing derails the model's own plan). Shared
 * with MAX_GATE_REPAIRS the same billing logic: every pass is a full model
 * run, so the cap is per TURN, not per pass.
 */
export const MAX_CONTINUATIONS = 2;

/**
 * The host-authored message driving one continuation pass. Kept here so all
 * run modes send byte-identical instructions (same reasoning as
 * `gateRepairPrompt`).
 */
export function continuationPrompt(attempt: number, maxAttempts: number): string {
	return [
		`[studio] Your last pass hit the step ceiling and was cut off mid-work (continuation ${attempt}/${maxAttempts}).`,
		'Pick up exactly where you left off and finish the remaining work. Do not start over, do not ' +
			're-plan, and do not re-read files you already wrote this turn. If everything you intended ' +
			'is in fact complete, say so briefly and stop.',
	].join('\n\n');
}

/** Per-failure output shown to the model. The tail is where compilers point. */
const REPORT_OUTPUT_CAP = 4_000;

/**
 * Gates whose failure is DRIFT of a committed golden file, not broken code.
 * The fix is regenerating the artifact — after which the diff is a
 * needs-review event for the human (builder-studio §9.1), never something to
 * hand-edit until the checker goes quiet.
 */
const DRIFT_HINTS: Partial<Record<GateName, string>> = {
	permissions:
		'this gate compares committed PERMISSIONS.md against MODULES + ROLES — regenerate it ' +
		'(pnpm lint:permissions, without --check) instead of hand-editing; the resulting diff ' +
		'goes to human review',
	api:
		'this gate compares the committed API document against the operation catalog — regenerate ' +
		'it (pnpm lint:api, without --check) instead of hand-editing; the resulting diff goes to ' +
		'human review',
};

/**
 * The model-facing report of a red gate run, or null when there is nothing a
 * model should act on (all green/skipped, or only blocked). Failed gates carry
 * their trimmed output; blocked gates are listed as facts with an explicit
 * do-not-fix note.
 */
export function gateReport(run: GateRun): string | null {
	const failed = run.results.filter((r) => r.status === 'failed');
	if (failed.length === 0) return null;
	const blocked = run.results.filter((r) => r.status === 'blocked');
	const sections = failed.map((r) => {
		const hint = DRIFT_HINTS[r.name];
		const output =
			r.output.length > REPORT_OUTPUT_CAP
				? `…[${r.output.length - REPORT_OUTPUT_CAP} chars trimmed]…\n${r.output.slice(-REPORT_OUTPUT_CAP)}`
				: r.output;
		return [
			`── ${r.name} FAILED (exit ${r.exitCode})${hint ? ` — ${hint}` : ''}`,
			output || '(no output)',
		].join('\n');
	});
	if (blocked.length) {
		sections.push(
			`── blocked (the checker could not run — this is NOT a code problem; do not try to fix it): ` +
				blocked.map((r) => r.name).join(', '),
		);
	}
	return sections.join('\n\n');
}

/**
 * The host-authored message driving one repair attempt. Kept in one place so
 * both run modes send byte-identical instructions.
 */
export function gateRepairPrompt(run: GateRun, attempt: number, maxAttempts: number): string {
	return [
		`[studio] The tier-1 gates ran after your changes and are RED (repair attempt ${attempt}/${maxAttempts}).`,
		gateReport(run) ?? '(no failing gates — nothing to repair)',
		'Fix the failures above now. The gates are the oracle, not your own judgement: change the ' +
			'code until they pass, do not argue with them and do not weaken or delete tests to get ' +
			'green. If a failure is golden-file drift, regenerate the artifact as its hint says.',
	].join('\n\n');
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
