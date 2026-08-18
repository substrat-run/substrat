/**
 * `pnpm builder evals` — the generator's regression sweep (builder-studio.md
 * §9.6, issue #630).
 *
 * Runs every frozen concept fixture under apps/builder/evals/ through the SAME
 * turn loop the studio uses, in mode A (no container, no Docker), and grades
 * the result structurally: gates green, pinned operations exist, pinned roles
 * hold their permissions. Run it before and after any change to the skills,
 * the model, the effort tier, or the harness; the comparison metric is token
 * usage per PASSING build (builder-harness.md §4).
 *
 * Each fixture builds in `.builder/projects/eval-<name>` — a workspace member
 * (pnpm-workspace.yaml), so `workspace:*` deps resolve and the standalone
 * gates run; gitignored, so the sweep never touches the checkout's history.
 * The project is wiped at the START of a run and kept afterwards for autopsy.
 *
 * Mode A has NO isolation: the model gets shell access to this machine, N
 * times. The same warning as `pnpm builder dev`, multiplied by the fixture
 * count — run it from a scratch clone when that bothers you (it should).
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	formatEvent,
	AiSdkGenerator,
	type BuildEvent,
	type VerticalGenerator,
} from '@substrat-run/builder-generator';
import { LocalWorkspace, standaloneGates } from '@substrat-run/builder-workspace';
import { loadEnvFiles } from './env.js';
import { editToolFor, resolveAutoSpec, samplingFor } from './model-pairs.js';
import { skillsForPhase, writeGuardFor, type BuildPhase } from './phase.js';
import { costOfSteps } from './pricing.js';
import {
	DEFAULT_MODEL,
	explainProviderError,
	ProviderError,
	resolveModel,
} from './providers.js';
import { loadSkills } from './skills.js';
import {
	EVAL_PROJECT_PREFIX,
	formatEvalResult,
	parseExpectations,
	assertFixtureStart,
	prepareProject,
	runEval,
	startsAtPrompt,
	type EvalFixture,
	type EvalResult,
} from './evals/harness.js';

interface Args {
	readonly root: string;
	readonly only?: readonly string[];
	readonly modelFlag?: string;
	readonly maxSteps: number;
	readonly maxTurns?: number;
	readonly list: boolean;
	readonly quiet: boolean;
	readonly help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i === -1 ? undefined : argv[i + 1];
	};
	const only = get('--eval');
	const maxTurns = get('--max-turns');
	return {
		root: get('--root') ?? process.env.INIT_CWD ?? process.cwd(),
		...(only ? { only: only.split(',').map((s) => s.trim()) } : {}),
		modelFlag: get('--model'),
		maxSteps: Number(get('--max-steps') ?? 40),
		...(maxTurns ? { maxTurns: Number(maxTurns) } : {}),
		list: argv.includes('--list'),
		quiet: argv.includes('--quiet'),
		help: argv.includes('--help') || argv.includes('-h'),
	};
}

const USAGE = `pnpm builder evals [options]

  --eval <a,b>        run only these fixtures (default: all under apps/builder/evals/)
  --model <spec>      provider:model (default ${DEFAULT_MODEL}; also SUBSTRAT_BUILDER_MODEL)
  --max-steps <n>     tool-loop ceiling per pass (default 40)
  --max-turns <n>     turn ceiling per fixture (fixture expect.json wins)
  --root <path>       monorepo root (default cwd)
  --list              list fixtures and exit
  --quiet             suppress the event stream; verdicts only
  --help

Grades the generator against frozen concepts (builder-studio.md §9.6): gates
green + pinned operations exist + pinned roles hold their permissions. Results
land in .builder/evals/ as JSON; compare two runs to judge a harness change.

Mode A has NO isolation — the model gets shell access, once per fixture.`;

/**
 * Fixture discovery: every `apps/builder/evals/<name>/` with an expect.json and
 * a starting point — either `concept.md` (start frozen) or `prompt.md` +
 * `answers.md` (start at the brief, so the interview is measured).
 *
 * A directory carrying both, or neither, is an error rather than a skip:
 * silently ignoring a malformed fixture shrinks the sweep without saying so,
 * and a sweep that quietly runs fewer fixtures reads as a pass.
 */
async function loadFixtures(evalsDir: string, only?: readonly string[]): Promise<EvalFixture[]> {
	const entries = await readdir(evalsDir, { withFileTypes: true });
	const fixtures: EvalFixture[] = [];
	for (const e of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
		const dir = join(evalsDir, e.name);
		const has = (f: string) => existsSync(join(dir, f));
		if (!has('expect.json')) continue;
		const read = (f: string) => readFile(join(dir, f), 'utf8');
		const expectRaw: unknown = JSON.parse(await read('expect.json'));
		const fixture: EvalFixture = {
			name: e.name,
			...(has('concept.md') ? { concept: await read('concept.md') } : {}),
			...(has('prompt.md') ? { prompt: await read('prompt.md') } : {}),
			...(has('answers.md') ? { answers: await read('answers.md') } : {}),
			expect: parseExpectations(expectRaw, `evals/${e.name}/expect.json`),
		};
		assertFixtureStart(fixture);
		fixtures.push(fixture);
	}
	const missing = only?.filter((n) => !fixtures.some((f) => f.name === n)) ?? [];
	if (missing.length) throw new Error(`no such fixture(s): ${missing.join(', ')}`);
	return only ? fixtures.filter((f) => only.includes(f.name)) : fixtures;
}

function resolveModelSpec(args: Args): { spec: string; source: string } {
	if (args.modelFlag) return { spec: args.modelFlag, source: '--model' };
	const fromEnv = process.env.SUBSTRAT_BUILDER_MODEL;
	if (fromEnv) return { spec: fromEnv, source: 'SUBSTRAT_BUILDER_MODEL' };
	return { spec: DEFAULT_MODEL, source: 'default' };
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}

	// The fixtures live beside this file's package, not under --root.
	const studioDir = join(import.meta.dirname, '..');
	const fixtures = await loadFixtures(join(studioDir, 'evals'), args.only);
	if (fixtures.length === 0) {
		process.stderr.write('no fixtures found under apps/builder/evals/\n');
		return 2;
	}
	if (args.list) {
		for (const f of fixtures) {
			const ops = f.expect.operations?.length ?? 0;
			const roles = Object.keys(f.expect.roles ?? {}).length;
			// Where a fixture STARTS is the first thing to know about it: the two
			// modes measure different things, and a sweep mixing them silently
			// reports one number over both.
			const start = startsAtPrompt(f) ? 'starts at the prompt' : 'frozen concept';
			process.stdout.write(
				`${f.name}  (${start}; ${ops} operation(s), ${roles} role(s) pinned)\n`,
			);
		}
		return 0;
	}

	const env = loadEnvFiles(args.root);
	const ws = new LocalWorkspace({ root: args.root });
	const chosen = resolveModelSpec(args);

	// Validate the spec once, up front — same contract as dev.ts.
	try {
		await resolveModel(resolveAutoSpec(chosen.spec, 'iterate'));
	} catch (err) {
		if (err instanceof ProviderError) {
			process.stderr.write(`${err.message}\n`);
			return 2;
		}
		throw err;
	}

	const skills = await loadSkills(ws.root);

	// Fresh generator per turn so the phase ladder binds the right skills —
	// byte-identical construction to server.ts makeGenerator.
	const makeGenerator = async (phase: BuildPhase): Promise<VerticalGenerator> => {
		const resolved = await resolveModel(resolveAutoSpec(chosen.spec, phase));
		return new AiSdkGenerator({
			model: resolved.model,
			label: resolved.label,
			maxSteps: args.maxSteps,
			skills: skillsForPhase(skills.byFile, phase),
			explainError: explainProviderError(chosen.spec.split(':')[0] ?? 'anthropic'),
			editTool: editToolFor(chosen.spec),
			// The phase ladder's teeth, which this construction claimed to share
			// with server.ts and did not. Without it an interview turn here could
			// write code instead of spec/concept.md — the ladder would never
			// advance, and the eval would measure a generator the studio refuses
			// to run.
			denyWrite: writeGuardFor(phase),
			...samplingFor(chosen.spec),
		});
	};

	process.stdout.write(
		`builder evals · ${fixtures.length} fixture(s) · model ${chosen.spec} (via ${chosen.source})\n` +
			`  root ${ws.root}\n` +
			`  env  ${env.loaded.length ? env.loaded.join(', ') : '(shell only)'}\n` +
			`  mode A — no isolation; the model has shell access here, once per fixture\n\n`,
	);

	const results: EvalResult[] = [];
	for (const fixture of fixtures) {
		const projectDir = `${EVAL_PROJECT_PREFIX}${fixture.name}`;
		process.stdout.write(`── ${fixture.name} → ${projectDir}\n`);
		await prepareProject(ws, projectDir, fixture);
		const projectWs = new LocalWorkspace({ root: join(ws.root, projectDir) });

		const onEvent = (e: BuildEvent): void => {
			if (args.quiet) return;
			if (e.type === 'assistant-text') return; // prose is noise in a sweep log
			process.stdout.write(`  ${formatEvent(e)}\n`);
		};

		const result = await runEval({
			ws,
			projectWs,
			projectDir,
			fixture,
			makeGenerator,
			gates: standaloneGates(projectDir),
			...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
			onEvent,
		});
		results.push(result);
		await projectWs.dispose();
		process.stdout.write(`${formatEvalResult(result)}\n\n`);
	}

	// The run artifact — compare two of these to judge a change (§9.6).
	// Priced against the CONCRETE spec: an auto pair resolves to its strong
	// member for every non-interview phase, and eval turns are never interview
	// turns (the concept is committed before turn 1), so one rate card fits.
	const pricingSpec = resolveAutoSpec(chosen.spec, 'iterate');
	const cost = (r: EvalResult) => costOfSteps(pricingSpec, r.usage.stepUsage)?.listUsd ?? null;
	const report = {
		ranAt: new Date().toISOString(),
		modelSpec: chosen.spec,
		pricedAs: pricingSpec,
		maxSteps: args.maxSteps,
		results: results.map((r) => ({ ...r, listCostUsd: cost(r) })),
	};
	const outDir = join(ws.root, '.builder', 'evals');
	await mkdir(outDir, { recursive: true });
	const stamp = report.ranAt.replace(/[:.]/g, '-');
	const outFile = join(outDir, `run-${stamp}.json`);
	await writeFile(outFile, `${JSON.stringify(report, null, '\t')}\n`);

	const passed = results.filter((r) => r.passed).length;
	process.stdout.write(`${'─'.repeat(60)}\n`);
	for (const r of results) {
		const c = cost(r);
		process.stdout.write(
			`${r.passed ? '✓' : '✗'} ${r.fixture.padEnd(24)} ${r.turns}t/${r.repairs}r/${r.questions}q  ` +
				`${r.usage.inputTokens + r.usage.outputTokens} tok${c ? `  $${c}` : ''}\n`,
		);
	}
	process.stdout.write(`${passed}/${results.length} passing · report ${outFile}\n`);
	await ws.dispose();
	return passed === results.length ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(err: unknown) => {
		process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(2);
	},
);
