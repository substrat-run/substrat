/**
 * `pnpm builder dev` — the studio's turn loop, in a terminal.
 *
 * This is builder-studio.md §7's chat pane with a terminal renderer instead of a
 * React one: same `Workspace`, same generator, same `BuildEvent` stream, same
 * commit-per-turn. When the Worker and chat UI land they subscribe to the same
 * events, which is the point of the union being ours (§5.2).
 *
 * Mode A (§3.1): no container runtime of any kind.
 */
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	AiSdkGenerator,
	formatEvent,
	type BuildEvent,
	type GeneratorTurn,
} from '@substrat-run/builder-generator';
import {
	defaultGates,
	ensureVerticalRepo,
	foreignChanges,
	formatGateRun,
	gateRepairPrompt,
	gateReport,
	isGitRepo,
	LocalWorkspace,
	MAX_GATE_REPAIRS,
	repairNeeded,
	runTurn,
	standaloneGates,
	type TurnResult,
} from '@substrat-run/builder-workspace';
import { loadEnvFiles } from './env.js';
import { editToolFor } from './model-pairs.js';
import { detectPhase, skillsForPhase } from './phase.js';
import { loadSkills } from './skills.js';
import {
	DEFAULT_MODEL,
	explainProviderError,
	ProviderError,
	resolveModel,
} from './providers.js';

interface Args {
	readonly root: string;
	readonly vertical: string;
	readonly conceptPath?: string;
	/**
	 * From `--model` only. The env fallback is resolved AFTER the .env files load
	 * (see main) — reading it here would silently ignore a value set in
	 * apps/builder/.env, which is the first place anyone would put it.
	 */
	readonly modelFlag?: string;
	readonly maxSteps: number;
	readonly help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i === -1 ? undefined : argv[i + 1];
	};
	return {
		// INIT_CWD comes from pnpm itself, not from a .env, so it is safe to read here:
		// `pnpm --filter` runs with cwd set to apps/builder.
		root: get('--root') ?? process.env.INIT_CWD ?? process.cwd(),
		vertical: get('--vertical') ?? '.builder/projects/spike',
		conceptPath: get('--concept'),
		modelFlag: get('--model'),
		maxSteps: Number(get('--max-steps') ?? 40),
		help: argv.includes('--help') || argv.includes('-h'),
	};
}

/**
 * Precedence: `--model` (this run) → SUBSTRAT_BUILDER_MODEL (this machine) →
 * DEFAULT_MODEL (the committed team default). Credentials are environment;
 * the model is a *setting* — see .env.example.
 */
function resolveModelSpec(args: Args): { spec: string; source: string } {
	if (args.modelFlag) return { spec: args.modelFlag, source: '--model' };
	const fromEnv = process.env.SUBSTRAT_BUILDER_MODEL;
	if (fromEnv) return { spec: fromEnv, source: 'SUBSTRAT_BUILDER_MODEL' };
	return { spec: DEFAULT_MODEL, source: 'default' };
}

const USAGE = `pnpm builder dev [options]

  --vertical <dir>    vertical under construction (default demos/spike)
  --concept <file>    approved concept document (spec/concept.md)
  --model <spec>      provider:model (default ${DEFAULT_MODEL})
                      also: SUBSTRAT_BUILDER_MODEL
  --root <path>       workspace root (default cwd)
  --max-steps <n>     tool-loop ceiling per turn (default 40)
  --help

Type a message to run a turn. /gates runs the gates alone, /quit exits.

Mode A has NO isolation (builder-studio.md §10): the model gets shell access to
this machine. Point --root at a scratch clone, not a checkout holding secrets.`;

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}

	// Before resolving a provider, so a key in apps/builder/.env is found.
	// A real environment variable still wins — process.loadEnvFile does not clobber.
	const env = loadEnvFiles(args.root);

	const ws = new LocalWorkspace({ root: args.root });
	// Project mode (§4.6): the vertical is its own repo, initialised on first use.
	const ensured = await ensureVerticalRepo(ws, args.vertical);
	const gateSet =
		ensured.mode === 'project' ? standaloneGates(args.vertical) : defaultGates(args.vertical);
	if (ensured.mode === 'scoped' && !(await isGitRepo(ws))) {
		process.stderr.write(`not a git repo: ${ws.root}\n  the repo is the only durable tier (§2)\n`);
		return 2;
	}

	// Resolved only now, so a value in apps/builder/.env is honoured.
	const chosen = resolveModelSpec(args);

	let model;
	try {
		model = await resolveModel(chosen.spec);
	} catch (err) {
		if (err instanceof ProviderError) {
			process.stderr.write(`${err.message}\n`);
			return 2;
		}
		throw err;
	}

	// The generator's workspace is the PROJECT, not the studio checkout (§5.3):
	// its file and shell surface cannot reach the monorepo or any .env.
	const projectWs = new LocalWorkspace({ root: join(ws.root, args.vertical) });
	const skills = await loadSkills(ws.root);

	const generator = new AiSdkGenerator({
		model: model.model,
		label: model.label,
		maxSteps: args.maxSteps,
		skills: skillsForPhase(skills.byFile, await detectPhase(projectWs)),
		explainError: explainProviderError(chosen.spec.split(':')[0] ?? 'anthropic'),
		// Format-per-model (H1): frontier providers get search/replace edits.
		editTool: editToolFor(chosen.spec),
	});

	/** The concept follows the project: flag file wins, else the project's spec. */
	async function currentConcept(): Promise<string> {
		if (args.conceptPath) return await readFile(args.conceptPath, 'utf8');
		if (await projectWs.exists('spec/concept.md')) return await projectWs.readFile('spec/concept.md');
		return '(no concept document yet — interview the builder before writing code)';
	}

	process.stdout.write(
		`builder studio · ${generator.id}  (via ${chosen.source})\n` +
			`  root     ${ws.root}\n` +
			`  vertical ${args.vertical}  (${ensured.mode} repo${ensured.initialized ? ', initialised' : ''})\n` +
			`  concept  ${args.conceptPath ?? '(none)'}\n` +
			(model.endpoint
				? `  endpoint ${model.endpoint}  (${model.endpointSource})\n`
				: '') +
			`  env      ${env.loaded.length ? env.loaded.join(', ') : '(shell only)'}\n` +
			`  mode A — no isolation; the model has shell access here\n`,
	);

	const foreign = await foreignChanges(ws, args.vertical);
	if (foreign.length) {
		process.stdout.write(
			`  note: ${foreign.length} uncommitted file(s) outside ${args.vertical} — ` +
				`left alone; commits are scoped to the vertical\n`,
		);
	}
	process.stdout.write(`\nWhat would you like to build today?\n\n`);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const history: GeneratorTurn[] = [];
	let turnNo = 0;
	/** Red-gate report carried to the next turn's context (H5) — unset while green. */
	let lastGateReport: string | undefined;

	for (;;) {
		const message = (await rl.question('› ')).trim();
		if (!message) continue;
		if (message === '/quit' || message === '/exit') break;

		if (message === '/gates') {
			const turn = await runTurn(ws, {
				verticalDir: args.vertical,
				message: 'manual gate run',
				gates: gateSet,
			});
			process.stdout.write(`${formatGateRun(turn.gates)}\n\n`);
			continue;
		}

		turnNo += 1;

		// Same shape as the server's handleTurn: pass → checks → capped repair
		// loop, with repair prompts recorded verbatim in history (H5; the policy
		// constants live in gates.ts so the two hosts cannot drift).
		const transcript: GeneratorTurn[] = [];

		const runPass = async (text: string, carriedReport?: string): Promise<void> => {
			let assistant = '';
			let sawText = false;
			for await (const event of generator.run({
				workspace: projectWs,
				verticalDir: '.',
				concept: await currentConcept(),
				message: text,
				...(carriedReport ? { gateReport: carriedReport } : {}),
				history: [...history, ...transcript],
			})) {
				render(event);
				if (event.type === 'assistant-text') {
					assistant += event.text;
					sawText = true;
				}
			}
			if (sawText) process.stdout.write('\n');
			transcript.push({ role: 'user', text });
			if (assistant) transcript.push({ role: 'assistant', text: assistant });
		};

		// Commit-per-turn lives above the seam (§3), so it happens here — not in
		// the generator and not in the workspace.
		const runChecks = async (label: string): Promise<TurnResult> => {
			const turn = await runTurn(ws, {
				verticalDir: args.vertical,
				message: label,
				gates: gateSet,
			});
			process.stdout.write(`${formatGateRun(turn.gates)}\n`);
			if (turn.commit) {
				process.stdout.write(`  committed ${turn.commit.slice(0, 8)} (${turn.changedFiles.length} files)\n`);
			} else {
				process.stdout.write('  nothing to commit\n');
			}
			if (!turn.gates.ok) {
				for (const r of turn.gates.results) {
					if (r.status === 'failed' || r.status === 'blocked') {
						process.stdout.write(`\n--- ${r.name} (exit ${r.exitCode}) ---\n${r.output.slice(-2000)}\n`);
					}
				}
			}
			return turn;
		};

		await runPass(message, lastGateReport);
		let turn = await runChecks(`studio turn ${turnNo}: ${message.slice(0, 60)}`);
		for (
			let attempt = 1;
			attempt <= MAX_GATE_REPAIRS && repairNeeded(turn.gates) && turn.changedFiles.length > 0;
			attempt++
		) {
			process.stdout.write(`\n  gates red — repair attempt ${attempt}/${MAX_GATE_REPAIRS}\n\n`);
			await runPass(gateRepairPrompt(turn.gates, attempt, MAX_GATE_REPAIRS));
			turn = await runChecks(`studio turn ${turnNo} · gate repair ${attempt}/${MAX_GATE_REPAIRS}`);
		}
		lastGateReport = gateReport(turn.gates) ?? undefined;
		process.stdout.write('\n');

		history.push(...transcript);
	}

	rl.close();
	await ws.dispose();
	return 0;
}

function render(e: BuildEvent): void {
	if (e.type === 'assistant-text') {
		process.stdout.write(e.text);
		return;
	}
	process.stdout.write(`${formatEvent(e)}\n`);
}

main().then(
	(code) => process.exit(code),
	(err: unknown) => {
		process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(2);
	},
);
