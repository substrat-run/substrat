/**
 * The eval harness — builder-studio.md §9.6, D-51, issue #630.
 *
 * Contract-tests for the GENERATOR: N frozen concept documents, each with
 * expected structural outcomes (gates pass, these operations exist, these
 * roles hold these permissions). Any change to the skills, the model, the
 * effort, or the harness runs the sweep; the metric that ranks two runs is
 * token usage per PASSING build (builder-harness.md §4).
 *
 * Three properties are load-bearing:
 *
 * - **Mode A only** (§3.1): everything here is `Workspace` + child processes —
 *   an eval suite that needs a container runtime gets run once a quarter.
 * - **The oracle never rides in the prompt.** The driver's messages are frozen
 *   constants; expectations are checked from the OUTSIDE (gates + the probe),
 *   so a fixture cannot be passed by parroting its expect file.
 * - **The driver mirrors the studio's turn loop** (server.ts handleTurn): pass →
 *   gates → capped repair, same MAX_GATE_REPAIRS, same carried gate report.
 *   An eval that drives the generator through a *different* harness measures
 *   the wrong thing.
 */
import type {
	GateRun,
	GateSpec,
	Workspace,
} from '@substrat-run/builder-workspace';
import {
	ensureVerticalRepo,
	gateRepairPrompt,
	gateReport,
	MAX_GATE_REPAIRS,
	repairNeeded,
	runTurn,
	workspaceBrief,
} from '@substrat-run/builder-workspace';
import type {
	BuildEvent,
	GeneratorTurn,
	StepUsage,
	VerticalGenerator,
} from '@substrat-run/builder-generator';
import { buildContext, detectPhase, type BuildPhase } from '../phase.js';
import { runProbe, type ProbeFn, type ProbeResult } from './probe.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * The frozen expectations for one concept — expect.json beside the concept.
 * Everything is optional except what the fixture pins; gates-green is always
 * required and never declared (a fixture that tolerates red gates is not an
 * eval, it is a wish).
 */
export interface EvalExpectations {
	/** Operation names that must exist in the registered modules, e.g. `fixline/create-ticket`. */
	readonly operations?: readonly string[];
	/**
	 * Role key → permission keys the role must hold, at minimum. Superset is
	 * fine — vocabulary beyond the pinned set is the model's freedom; dropping
	 * a pinned key is the regression.
	 */
	readonly roles?: Readonly<Record<string, readonly string[]>>;
	/** Paths (relative to the project) that must exist, e.g. `test`. */
	readonly files?: readonly string[];
	/** Turn ceiling for this fixture (driver default applies when absent). */
	readonly maxTurns?: number;
}

/**
 * A fixture starts at ONE of two places, and which one decides what is measured.
 *
 * **`concept`** — the frozen concept document, verbatim. The sweep drives model
 * → scenario → scaffold → iterate. This measures how faithfully a fully
 * specified design gets built: obedience.
 *
 * **`prompt` + `answers`** — the brief a customer would actually give
 * ("I want to create a todo app"), and everything the builder said, as ONE
 * block. The run starts in the interview phase and produces its own
 * `spec/concept.md`, so the interview → concept link is inside the measurement
 * for the first time. This measures judgment: what a model assumes when nobody
 * told it, and whether those assumptions land on the forks `expect.json` pins.
 *
 * **Why the answers are one block rather than question-answer pairs.** The
 * questions vary run to run — that is the point of an interview — so anything
 * matching on their wording breaks on the first re-run. Delivered whole, the
 * interview skill finds its frontier covered and proposes.
 */
export interface EvalFixture {
	readonly name: string;
	/** The frozen concept document, verbatim. Absent when the fixture starts at the prompt. */
	readonly concept?: string;
	/** The underspecified brief. Its presence is what starts the run in the interview phase. */
	readonly prompt?: string;
	/** Everything the builder answered, as one block. Only meaningful with `prompt`. */
	readonly answers?: string;
	readonly expect: EvalExpectations;
}

/** Does this fixture start at the prompt (interview measured) or at the concept? */
export function startsAtPrompt(fixture: EvalFixture): boolean {
	return fixture.prompt !== undefined;
}

/**
 * A fixture must start at exactly one place. Checked rather than assumed: a
 * fixture carrying both would silently run as whichever branch was tested last,
 * and one carrying neither would drive a project with no concept and no brief.
 */
export function assertFixtureStart(fixture: EvalFixture): void {
	const hasConcept = fixture.concept !== undefined;
	const hasPrompt = fixture.prompt !== undefined;
	if (hasConcept === hasPrompt) {
		throw new Error(
			`fixture ${fixture.name}: give EITHER concept.md (start at the frozen concept) ` +
				'OR prompt.md + answers.md (start at the brief, measuring the interview) — ' +
				(hasConcept ? 'both were supplied' : 'neither was supplied'),
		);
	}
	if (hasPrompt && fixture.answers === undefined) {
		throw new Error(
			`fixture ${fixture.name}: prompt.md needs answers.md beside it — an interview ` +
				'replay with nothing to answer stalls at the first round of questions',
		);
	}
}

/** Validation without a schema dep: expect.json is our file, read hostilely anyway. */
export function parseExpectations(raw: unknown, source: string): EvalExpectations {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error(`${source}: expected an object`);
	}
	const o = raw as Record<string, unknown>;
	const strings = (v: unknown, field: string): readonly string[] => {
		if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
			throw new Error(`${source}: ${field} must be an array of strings`);
		}
		return v as string[];
	};
	const out: {
		operations?: readonly string[];
		roles?: Record<string, readonly string[]>;
		files?: readonly string[];
		maxTurns?: number;
	} = {};
	if (o.operations !== undefined) out.operations = strings(o.operations, 'operations');
	if (o.files !== undefined) out.files = strings(o.files, 'files');
	if (o.roles !== undefined) {
		if (typeof o.roles !== 'object' || o.roles === null || Array.isArray(o.roles)) {
			throw new Error(`${source}: roles must be an object of role → permission[]`);
		}
		const roles: Record<string, readonly string[]> = {};
		for (const [key, perms] of Object.entries(o.roles)) {
			roles[key] = strings(perms, `roles.${key}`);
		}
		out.roles = roles;
	}
	if (o.maxTurns !== undefined) {
		if (typeof o.maxTurns !== 'number' || !Number.isInteger(o.maxTurns) || o.maxTurns < 1) {
			throw new Error(`${source}: maxTurns must be a positive integer`);
		}
		out.maxTurns = o.maxTurns;
	}
	const known = new Set(['operations', 'roles', 'files', 'maxTurns']);
	for (const k of Object.keys(o)) {
		if (!known.has(k)) throw new Error(`${source}: unknown field ${JSON.stringify(k)}`);
	}
	return out;
}

// ── expectation checking ─────────────────────────────────────────────────────

export interface ExpectationOutcome {
	readonly kind: 'file' | 'operation' | 'role' | 'probe';
	readonly target: string;
	readonly ok: boolean;
	/** What was actually found, when it differs from what was pinned. */
	readonly detail?: string;
}

/**
 * Structural checks against the built project. Files via the workspace;
 * operations and roles via the probe (the project's own exported MODULES +
 * ROLES — the same objects `pnpm lint:permissions` renders, so the eval cannot
 * drift from what a host would enforce).
 */
export async function checkExpectations(
	ws: Workspace,
	projectDir: string,
	expect: EvalExpectations,
	probe: ProbeFn,
): Promise<readonly ExpectationOutcome[]> {
	const outcomes: ExpectationOutcome[] = [];

	for (const path of expect.files ?? []) {
		const ok = await ws.exists(`${projectDir}/${path}`);
		outcomes.push({ kind: 'file', target: path, ok });
	}

	const needsProbe = (expect.operations?.length ?? 0) > 0 || Object.keys(expect.roles ?? {}).length > 0;
	if (!needsProbe) return outcomes;

	let result: ProbeResult;
	try {
		result = await probe(ws, projectDir);
	} catch (err) {
		outcomes.push({
			kind: 'probe',
			target: 'structural probe',
			ok: false,
			detail: err instanceof Error ? err.message : String(err),
		});
		return outcomes;
	}

	if (expect.operations?.length) {
		if (result.modules === null) {
			outcomes.push({
				kind: 'probe',
				target: 'MODULES export',
				ok: false,
				detail: result.error ?? 'no MODULES export found in the seed/provision entry',
			});
		} else {
			const found = new Set(result.modules.flatMap((m) => m.operations));
			for (const op of expect.operations) {
				outcomes.push({
					kind: 'operation',
					target: op,
					ok: found.has(op),
					...(found.has(op) ? {} : { detail: `found: ${[...found].sort().join(', ') || '(none)'}` }),
				});
			}
		}
	}

	if (expect.roles && Object.keys(expect.roles).length) {
		if (result.roles === null) {
			outcomes.push({
				kind: 'probe',
				target: 'ROLES export',
				ok: false,
				detail: result.error ?? 'no ROLES export found in the seed/provision entry',
			});
		} else {
			const byKey = new Map(result.roles.map((r) => [r.key, new Set(r.permissions)]));
			for (const [role, perms] of Object.entries(expect.roles)) {
				const held = byKey.get(role);
				if (!held) {
					outcomes.push({
						kind: 'role',
						target: role,
						ok: false,
						detail: `role not defined; defined: ${[...byKey.keys()].sort().join(', ') || '(none)'}`,
					});
					continue;
				}
				const missing = perms.filter((p) => !held.has(p));
				outcomes.push({
					kind: 'role',
					target: role,
					ok: missing.length === 0,
					...(missing.length ? { detail: `missing: ${missing.join(', ')}` } : {}),
				});
			}
		}
	}

	return outcomes;
}

// ── the driver ───────────────────────────────────────────────────────────────

/**
 * The frozen turn messages. These are part of what an eval holds constant —
 * edit them and every historical result is against a different harness.
 */
export const BUILD_MESSAGE =
	'The concept in spec/concept.md is approved and frozen. Build the vertical it describes, ' +
	'straight through: scaffold, seed world, scenario test. Do not ask questions — the concept ' +
	'document is the authority; where it is silent, follow platform defaults and record the ' +
	'assumption in your plan.';

export const CONTINUE_MESSAGE =
	'Continue until the concept in spec/concept.md is fully implemented and the gates are green. ' +
	'The concept document is the authority.';

/**
 * The third turn of an interview replay, and the only one the harness authors.
 *
 * `interview.md` requires the concept be presented in prose and written only
 * after the builder agrees, so a replay cannot end at the answers — it needs a
 * turn that says yes. It doubles as the reply to a second round of questions
 * (take the conventional option), which keeps the replay from stalling when a
 * model asks more than the answers block anticipated.
 *
 * Deliberately says nothing about the DOMAIN. Anything domain-specific here
 * would be the oracle riding in the prompt: the fixture's assumptions are what
 * is being measured, so the harness must not supply any.
 */
export const APPROVE_MESSAGE =
	'Approved — that is what I want. Where you offered choices or are still unsure, take the ' +
	'most conventional option and record it as an assumption. Write spec/concept.md as ' +
	'presented and end the turn.';

export const ANSWER_MESSAGE =
	'Proceed with your stated assumption, or the most conventional option where you offered ' +
	'choices. The frozen concept document is the only authority available in this run — ' +
	'continue building without further questions.';

export interface EvalUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedInputTokens: number;
	readonly cacheWriteTokens: number;
	readonly steps: number;
	/** Per-request breakdown across the whole eval — what tiered pricing needs. */
	readonly stepUsage: readonly StepUsage[];
}

export interface EvalResult {
	readonly fixture: string;
	readonly generatorId: string;
	readonly passed: boolean;
	/** Generator passes that were full build/continue turns (repairs not included). */
	readonly turns: number;
	/** Gate-repair passes across all turns. */
	readonly repairs: number;
	/** ask_user calls across the run — the stop-discipline metric (§9.6). */
	readonly questions: number;
	readonly usage: EvalUsage;
	readonly gates: GateRun | null;
	readonly expectations: readonly ExpectationOutcome[];
	readonly durationMs: number;
	readonly projectDir: string;
	/** Fatal error that ended the run early, when one did. */
	readonly error?: string;
}

export interface RunEvalOptions {
	/** The monorepo-root workspace (gates, git, probe run here). */
	readonly ws: Workspace;
	/** The project-root workspace the generator acts through (§5.3). */
	readonly projectWs: Workspace;
	/** Project directory relative to the monorepo root. */
	readonly projectDir: string;
	readonly fixture: EvalFixture;
	/**
	 * Fresh generator per turn, so the phase ladder binds the right skills —
	 * the same contract as server.ts makeGenerator.
	 */
	readonly makeGenerator: (phase: BuildPhase) => Promise<VerticalGenerator>;
	readonly gates: readonly GateSpec[];
	/** Injectable for tests; defaults to the tsx probe. */
	readonly probe?: ProbeFn;
	/** Driver default when the fixture pins nothing. */
	readonly maxTurns?: number;
	readonly onEvent?: (e: BuildEvent) => void;
	readonly signal?: AbortSignal;
}

export const DEFAULT_MAX_TURNS = 3;

/**
 * Turns an interview replay spends before the build starts: brief, answers,
 * approval. Added to the ceiling for a prompt fixture so it gets the same
 * number of BUILD turns as a concept fixture — otherwise starting at the prompt
 * would look worse for having had further to walk.
 */
export const INTERVIEW_TURNS = 3;

/**
 * Drive one fixture to a verdict. The project directory must already exist as
 * a fresh project repo with ONLY spec/concept.md committed — `prepareProject`
 * does that; the split keeps this function free of destructive file ops.
 */
export async function runEval(opts: RunEvalOptions): Promise<EvalResult> {
	const { ws, projectWs, projectDir, fixture } = opts;
	const probe = opts.probe ?? runProbe;
	assertFixtureStart(fixture);
	const baseTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
	const maxTurns =
		fixture.expect.maxTurns ?? baseTurns + (startsAtPrompt(fixture) ? INTERVIEW_TURNS : 0);
	const emit = opts.onEvent ?? (() => {});
	const started = Date.now();

	const history: GeneratorTurn[] = [];
	const stepUsage: StepUsage[] = [];
	let totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, steps: 0 };
	let turns = 0;
	let repairs = 0;
	let questions = 0;
	let questionsThisTurn = 0;
	let answersSent = false;
	let buildSent = false;
	let lastGates: GateRun | null = null;
	let lastGateReport: string | undefined;
	let fatal: string | undefined;
	let generatorId = 'unknown';

	const runPass = async (
		generator: VerticalGenerator,
		text: string,
		phase: BuildPhase,
		carriedReport?: string,
	): Promise<void> => {
		let prose = '';
		for await (const event of generator.run({
			workspace: projectWs,
			verticalDir: '.',
			// `buildContext`, not a raw read of spec/concept.md — the same seam
			// server.ts uses, and the only one that answers during the interview
			// phase, where the file does not exist yet.
			concept: await buildContext(projectWs, phase),
			message: text,
			workspaceBrief: await workspaceBrief(ws, projectDir).catch(() => undefined),
			...(carriedReport ? { gateReport: carriedReport } : {}),
			history: [...history.slice(-24)],
			...(opts.signal ? { signal: opts.signal } : {}),
		})) {
			emit(event);
			if (event.type === 'assistant-text') prose += event.text;
			if (event.type === 'question') {
				questions += 1;
				questionsThisTurn += 1;
			}
			if (event.type === 'error' && event.fatal) fatal = event.message;
			if (event.type === 'usage') {
				totals = {
					inputTokens: totals.inputTokens + event.inputTokens,
					outputTokens: totals.outputTokens + event.outputTokens,
					cachedInputTokens: totals.cachedInputTokens + (event.cachedInputTokens ?? 0),
					cacheWriteTokens: totals.cacheWriteTokens + (event.cacheWriteTokens ?? 0),
					steps: totals.steps + event.steps,
				};
				if (event.stepUsage) stepUsage.push(...event.stepUsage);
			}
		}
		history.push({ role: 'user', text });
		if (prose) history.push({ role: 'assistant', text: prose });
	};

	const runChecks = async (label: string) =>
		await runTurn(ws, { verticalDir: projectDir, message: label, gates: opts.gates });

	let expectations: readonly ExpectationOutcome[] = [];

	try {
		for (let turnNo = 1; turnNo <= maxTurns && !fatal && !opts.signal?.aborted; turnNo++) {
			const phase = await detectPhase(projectWs);
			const generator = await opts.makeGenerator(phase);
			generatorId = generator.id;
			// The sequence keyed on PHASE, not on turn number, so a replay that
			// needs an extra round self-corrects instead of approving a concept
			// that was never proposed. Both modes converge on BUILD_MESSAGE the
			// moment a concept exists — which is what makes their build halves
			// comparable.
			let message: string;
			if (phase === 'interview') {
				if (turnNo === 1) {
					message = fixture.prompt ?? BUILD_MESSAGE;
				} else if (!answersSent && fixture.answers !== undefined) {
					message = fixture.answers;
					answersSent = true;
				} else {
					message = APPROVE_MESSAGE;
				}
			} else if (!buildSent) {
				message = BUILD_MESSAGE;
				buildSent = true;
			} else {
				message = questionsThisTurn > 0 ? ANSWER_MESSAGE : CONTINUE_MESSAGE;
			}
			questionsThisTurn = 0;
			turns += 1;

			await runPass(generator, message, phase, lastGateReport);
			let turn = await runChecks(`eval ${fixture.name} · turn ${turnNo}`);
			for (
				let attempt = 1;
				attempt <= MAX_GATE_REPAIRS &&
				repairNeeded(turn.gates) &&
				turn.changedFiles.length > 0 &&
				!fatal &&
				!opts.signal?.aborted;
				attempt++
			) {
				repairs += 1;
				await runPass(generator, gateRepairPrompt(turn.gates, attempt, MAX_GATE_REPAIRS), phase);
				turn = await runChecks(`eval ${fixture.name} · turn ${turnNo} · repair ${attempt}/${MAX_GATE_REPAIRS}`);
			}

			lastGates = turn.gates;
			lastGateReport = gateReport(turn.gates) ?? undefined;

			expectations = await checkExpectations(ws, projectDir, fixture.expect, probe);
			if (turn.gates.ok && expectations.every((o) => o.ok)) break;
		}
	} catch (err) {
		fatal = err instanceof Error ? err.message : String(err);
	}

	// A run that crashed before its first check still reports its expectations.
	if (expectations.length === 0 && fatal) {
		expectations = await checkExpectations(ws, projectDir, fixture.expect, probe).catch(
			() => [] as ExpectationOutcome[],
		);
	}

	const passed = !fatal && (lastGates?.ok ?? false) && expectations.every((o) => o.ok);

	return {
		fixture: fixture.name,
		generatorId,
		passed,
		turns,
		repairs,
		questions,
		usage: { ...totals, stepUsage },
		gates: lastGates,
		expectations,
		durationMs: Date.now() - started,
		projectDir,
		...(fatal ? { error: fatal } : {}),
	};
}

/**
 * Wipe and re-create the fixture's project directory as a fresh standalone
 * repo holding exactly the frozen concept. Destructive by design, so it
 * refuses to touch anything outside the eval namespace.
 */
export const EVAL_PROJECT_PREFIX = '.builder/projects/eval-';

export async function prepareProject(
	ws: Workspace,
	projectDir: string,
	fixture: EvalFixture,
): Promise<void> {
	assertFixtureStart(fixture);
	if (!projectDir.startsWith(EVAL_PROJECT_PREFIX)) {
		throw new Error(
			`refusing to prepare ${projectDir}: eval projects live under ${EVAL_PROJECT_PREFIX}* ` +
				`(the wipe below must never reach a real project)`,
		);
	}
	await ws.exec(`rm -rf ${JSON.stringify(projectDir)}`);
	const ensured = await ensureVerticalRepo(ws, projectDir);
	if (ensured.mode !== 'project') {
		throw new Error(`${projectDir} came up in ${ensured.mode} mode — expected a fresh project repo`);
	}
	if (fixture.concept !== undefined) {
		await ws.mkdir(`${projectDir}/spec`, { recursive: true });
		await ws.writeFile(`${projectDir}/spec/concept.md`, fixture.concept);
	}
	// Commit with zero gates. For a concept fixture the ledger starts at
	// "concept exists", which lands detectPhase on `model` for turn 1. For a
	// prompt fixture NOTHING is written: no spec/concept.md is exactly what puts
	// turn 1 in the interview phase, which is the whole point of the mode — the
	// concept has to be produced by the run rather than handed to it.
	const label = fixture.concept !== undefined ? 'freeze concept' : 'empty project (starts at the prompt)';
	await runTurn(ws, { verticalDir: projectDir, message: `eval ${fixture.name}: ${label}`, gates: [] });
}

// ── reporting ────────────────────────────────────────────────────────────────

export function formatEvalResult(r: EvalResult): string {
	const lines: string[] = [];
	const verdict = r.passed ? 'PASS' : 'FAIL';
	lines.push(
		`${verdict} ${r.fixture} — ${r.turns} turn(s), ${r.repairs} repair(s), ${r.questions} question(s), ` +
			`${r.usage.inputTokens}+${r.usage.outputTokens} tokens in ${(r.durationMs / 1000).toFixed(0)}s`,
	);
	if (r.error) lines.push(`  fatal: ${r.error}`);
	if (r.gates && !r.gates.ok) {
		const red = r.gates.results.filter((g) => g.status === 'failed' || g.status === 'blocked');
		lines.push(`  gates red: ${red.map((g) => `${g.name} (${g.status})`).join(', ')}`);
	}
	for (const o of r.expectations) {
		if (o.ok) continue;
		lines.push(`  ✗ ${o.kind} ${o.target}${o.detail ? ` — ${o.detail}` : ''}`);
	}
	if (r.passed && r.expectations.length) {
		lines.push(`  ✓ ${r.expectations.length} structural expectation(s) met`);
	}
	return lines.join('\n');
}
