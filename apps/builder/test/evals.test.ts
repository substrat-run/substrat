/**
 * The eval HARNESS under test — with a scripted generator, an injected probe,
 * and zero gates, so no tokens, no API key, no pnpm install. What a real model
 * does against the fixtures is what `pnpm builder evals` answers; this file
 * pins the referee itself: the driver's turn/repair/question policy, the
 * expectation grading, and the usage accounting (§9.6 — the metric is token
 * usage per PASSING build, so the accounting is load-bearing).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import type { BuildEvent, GeneratorInput, VerticalGenerator } from '@substrat-run/builder-generator';
import {
	ANSWER_MESSAGE,
	APPROVE_MESSAGE,
	assertFixtureStart,
	BUILD_MESSAGE,
	checkExpectations,
	CONTINUE_MESSAGE,
	EVAL_PROJECT_PREFIX,
	forkScore,
	formatEvalResult,
	formatForkScore,
	INTERVIEW_TURNS,
	parseExpectations,
	prepareProject,
	runEval,
	startsAtPrompt,
	type EvalFixture,
	type EvalResult,
} from '../src/evals/harness.js';
import type { ProbeFn, ProbeResult } from '../src/evals/probe.js';

const roots: string[] = [];

async function scratchRoot(): Promise<LocalWorkspace> {
	const root = await mkdtemp(join(tmpdir(), 'builder-evals-'));
	roots.push(root);
	const ws = new LocalWorkspace({ root });
	await ws.exec('git init -q');
	return ws;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const FIXTURE: EvalFixture = {
	name: 'fx',
	concept: '# Fx\n\nBuild the thing.\n',
	expect: {
		operations: ['fx/create-thing'],
		roles: { office: ['thing:manage'] },
		files: ['src/module.ts'],
	},
};

const GOOD_PROBE: ProbeResult = {
	modules: [{ id: '@app/fx', operations: ['fx/create-thing'], permissions: ['thing:manage'] }],
	roles: [{ key: 'office', permissions: ['thing:manage', 'thing:read'] }],
};

const probeOf =
	(result: ProbeResult): ProbeFn =>
	async () =>
		result;

/**
 * A generator whose turns are a script: each entry sees the incoming message
 * and acts through the workspace like a model would. Usage events included so
 * the accounting is exercised.
 */
function scripted(
	turns: ((input: GeneratorInput) => Promise<BuildEvent[]>)[],
): VerticalGenerator & { received: string[] } {
	const received: string[] = [];
	let call = 0;
	return {
		id: 'scripted',
		received,
		async *run(input: GeneratorInput): AsyncIterable<BuildEvent> {
			received.push(input.message);
			const script = turns[Math.min(call, turns.length - 1)];
			call += 1;
			if (!script) return;
			for (const e of await script(input)) yield e;
		},
	};
}

const usage = (input: number, output: number): BuildEvent => ({
	type: 'usage',
	inputTokens: input,
	outputTokens: output,
	steps: 1,
	cachedInputTokens: Math.floor(input / 2),
	stepUsage: [{ inputTokens: input, outputTokens: output, cachedInputTokens: Math.floor(input / 2) }],
});

async function writeModule(input: GeneratorInput): Promise<void> {
	await input.workspace.mkdir('src', { recursive: true });
	await input.workspace.writeFile('src/module.ts', 'export const M = 1;\n');
}

describe('prepareProject', () => {
	it('creates a fresh project repo holding exactly the frozen concept', async () => {
		const ws = await scratchRoot();
		const dir = `${EVAL_PROJECT_PREFIX}fx`;
		await prepareProject(ws, dir, FIXTURE);
		expect(await ws.exists(`${dir}/.git`)).toBe(true);
		expect(await ws.readFile(`${dir}/spec/concept.md`)).toBe(FIXTURE.concept);
		// Committed, so detectPhase lands on scaffold and turn 1 is a build turn.
		const { stdout } = await ws.exec('git log --oneline', { cwd: dir });
		expect(stdout).toContain('freeze concept');
	});

	it('refuses to wipe outside the eval namespace', async () => {
		const ws = await scratchRoot();
		await expect(prepareProject(ws, '.builder/projects/real-app', FIXTURE)).rejects.toThrow(
			/refusing/,
		);
	});
});

describe('runEval', () => {
	async function setup(fixture: EvalFixture = FIXTURE) {
		const ws = await scratchRoot();
		const dir = `${EVAL_PROJECT_PREFIX}${fixture.name}`;
		await prepareProject(ws, dir, fixture);
		const projectWs = new LocalWorkspace({ root: join((ws as LocalWorkspace).root, dir) });
		return { ws, dir, projectWs };
	}

	it('passes in one turn when the build lands and expectations hold', async () => {
		const { ws, dir, projectWs } = await setup();
		const gen = scripted([
			async (input) => {
				await writeModule(input);
				return [{ type: 'assistant-text', text: 'built it' }, usage(1000, 200)];
			},
		]);
		const result = await runEval({
			ws,
			projectWs,
			projectDir: dir,
			fixture: FIXTURE,
			makeGenerator: async () => gen,
			gates: [],
			probe: probeOf(GOOD_PROBE),
		});
		expect(result.passed).toBe(true);
		expect(result.turns).toBe(1);
		expect(result.repairs).toBe(0);
		expect(result.questions).toBe(0);
		expect(gen.received).toEqual([BUILD_MESSAGE]);
		expect(result.usage).toMatchObject({
			inputTokens: 1000,
			outputTokens: 200,
			cachedInputTokens: 500,
			steps: 1,
		});
		expect(result.usage.stepUsage).toHaveLength(1);
		expect(result.generatorId).toBe('scripted');
	});

	it('answers questions with the frozen answer message and counts them', async () => {
		const { ws, dir, projectWs } = await setup();
		const gen = scripted([
			async () => [
				{ type: 'question', question: 'UI too?', options: ['yes', 'no'] },
				usage(500, 50),
			],
			async (input) => {
				await writeModule(input);
				return [usage(800, 100)];
			},
		]);
		const result = await runEval({
			ws,
			projectWs,
			projectDir: dir,
			fixture: FIXTURE,
			makeGenerator: async () => gen,
			gates: [],
			probe: probeOf(GOOD_PROBE),
		});
		expect(result.passed).toBe(true);
		expect(result.turns).toBe(2);
		expect(result.questions).toBe(1);
		// A frozen-concept fixture never enters the interview phase, so its
		// interview count is 0 however much it asks — which is what keeps the
		// paired metric from reading a build question as an assumption bought.
		expect(result.interviewQuestions).toBe(0);
		expect(gen.received).toEqual([BUILD_MESSAGE, ANSWER_MESSAGE]);
		expect(result.usage.inputTokens).toBe(1300);
	});

	it('continues with the frozen continue message and fails at the turn ceiling', async () => {
		const { ws, dir, projectWs } = await setup();
		// Never writes the module: expectations can never be met.
		const gen = scripted([async () => [usage(100, 10)]]);
		const result = await runEval({
			ws,
			projectWs,
			projectDir: dir,
			fixture: FIXTURE,
			makeGenerator: async () => gen,
			gates: [],
			probe: probeOf(GOOD_PROBE),
			maxTurns: 2,
		});
		expect(result.passed).toBe(false);
		expect(result.turns).toBe(2);
		expect(gen.received).toEqual([BUILD_MESSAGE, CONTINUE_MESSAGE]);
		const fileOutcome = result.expectations.find((o) => o.kind === 'file');
		expect(fileOutcome?.ok).toBe(false);
	});

	it('reports a fatal generator error and does not claim a pass', async () => {
		const { ws, dir, projectWs } = await setup();
		const gen = scripted([
			async () => [{ type: 'error', message: 'provider 401', fatal: true }],
		]);
		const result = await runEval({
			ws,
			projectWs,
			projectDir: dir,
			fixture: FIXTURE,
			makeGenerator: async () => gen,
			gates: [],
			probe: probeOf(GOOD_PROBE),
		});
		expect(result.passed).toBe(false);
		expect(result.error).toBe('provider 401');
		expect(result.turns).toBe(1);
	});
});

describe('checkExpectations', () => {
	it('grades operations, roles (superset ok), and files', async () => {
		const ws = await scratchRoot();
		await ws.mkdir('p/src', { recursive: true });
		await ws.writeFile('p/src/module.ts', 'x');
		const outcomes = await checkExpectations(
			ws,
			'p',
			{
				operations: ['fx/create-thing', 'fx/missing-op'],
				roles: { office: ['thing:manage'], ghost: ['x:y'] },
				files: ['src/module.ts', 'test'],
			},
			probeOf(GOOD_PROBE),
		);
		const by = (kind: string, target: string) =>
			outcomes.find((o) => o.kind === kind && o.target === target);
		expect(by('file', 'src/module.ts')?.ok).toBe(true);
		expect(by('file', 'test')?.ok).toBe(false);
		expect(by('operation', 'fx/create-thing')?.ok).toBe(true);
		expect(by('operation', 'fx/missing-op')?.ok).toBe(false);
		expect(by('operation', 'fx/missing-op')?.detail).toContain('fx/create-thing');
		// Superset: office also holds thing:read, still ok.
		expect(by('role', 'office')?.ok).toBe(true);
		expect(by('role', 'ghost')?.ok).toBe(false);
		expect(by('role', 'ghost')?.detail).toContain('office');
	});

	it('flags a role missing a pinned permission', async () => {
		const ws = await scratchRoot();
		const outcomes = await checkExpectations(
			ws,
			'p',
			{ roles: { office: ['thing:manage', 'thing:price'] } },
			probeOf(GOOD_PROBE),
		);
		const office = outcomes.find((o) => o.kind === 'role' && o.target === 'office');
		expect(office?.ok).toBe(false);
		expect(office?.detail).toBe('missing: thing:price');
	});

	it('surfaces missing MODULES/ROLES exports as probe failures', async () => {
		const ws = await scratchRoot();
		const outcomes = await checkExpectations(
			ws,
			'p',
			{ operations: ['fx/create-thing'], roles: { office: ['thing:manage'] } },
			probeOf({ modules: null, roles: null, error: 'no seed/provision entry found' }),
		);
		expect(outcomes).toHaveLength(2);
		expect(outcomes.every((o) => o.kind === 'probe' && !o.ok)).toBe(true);
	});

	it('surfaces a crashed probe without throwing', async () => {
		const ws = await scratchRoot();
		const outcomes = await checkExpectations(ws, 'p', { operations: ['a/b'] }, async () => {
			throw new Error('tsx exploded');
		});
		expect(outcomes).toEqual([
			{ kind: 'probe', target: 'structural probe', ok: false, detail: 'tsx exploded' },
		]);
	});

	it('skips the probe entirely when nothing structural is pinned', async () => {
		const ws = await scratchRoot();
		let called = false;
		const outcomes = await checkExpectations(ws, 'p', { files: [] }, async () => {
			called = true;
			return GOOD_PROBE;
		});
		expect(outcomes).toEqual([]);
		expect(called).toBe(false);
	});
});

describe('parseExpectations', () => {
	it('accepts the full shape and rejects unknown fields', () => {
		expect(
			parseExpectations(
				{ operations: ['a/b'], roles: { r: ['p:q'] }, files: ['src'], maxTurns: 2 },
				't',
			),
		).toEqual({ operations: ['a/b'], roles: { r: ['p:q'] }, files: ['src'], maxTurns: 2 });
		expect(() => parseExpectations({ operatons: ['typo'] }, 't')).toThrow(/unknown field/);
		expect(() => parseExpectations({ roles: { r: 'p:q' } }, 't')).toThrow(/roles\.r/);
		expect(() => parseExpectations({ maxTurns: 0 }, 't')).toThrow(/maxTurns/);
		expect(() => parseExpectations([], 't')).toThrow(/object/);
	});
});

// ── starting at the prompt (#740) ────────────────────────────────────────────

const PROMPT_FIXTURE: EvalFixture = {
	name: 'fx-prompt',
	prompt: 'I want to create a thing tracker.',
	answers: '- **Who uses it:** just me.\n- **Screens:** a web UI.\n',
	expect: { files: ['src/module.ts'] },
};

describe('a fixture that starts at the prompt', () => {
	it('leaves the project with NO concept, which is what puts turn 1 in the interview', async () => {
		// The whole mode rests on this: `detectPhase` returns 'interview' exactly
		// when spec/concept.md is absent, so writing one here would skip the very
		// link the fixture exists to measure.
		const ws = await scratchRoot();
		const dir = `${EVAL_PROJECT_PREFIX}${PROMPT_FIXTURE.name}`;
		await prepareProject(ws, dir, PROMPT_FIXTURE);
		expect(await ws.exists(`${dir}/spec/concept.md`)).toBe(false);
		expect(startsAtPrompt(PROMPT_FIXTURE)).toBe(true);
	});

	it('replays brief → answers → approval, then converges on the build message', async () => {
		const ws = await scratchRoot();
		const dir = `${EVAL_PROJECT_PREFIX}${PROMPT_FIXTURE.name}`;
		await prepareProject(ws, dir, PROMPT_FIXTURE);
		const projectWs = new LocalWorkspace({ root: join((ws as LocalWorkspace).root, dir) });

		const gen = scripted([
			// 1 — the brief lands; the interview asks its round.
			async () => [{ type: 'question', question: 'who uses it?', options: ['a', 'b'] }, usage(400, 40)],
			// 2 — answers delivered whole; the concept is PROPOSED, not written.
			async () => [{ type: 'assistant-text', text: 'here is the concept…' }, usage(500, 90)],
			// 3 — approval: the concept is written, which moves the ladder.
			async (input) => {
				await input.workspace.mkdir('spec', { recursive: true });
				await input.workspace.writeFile('spec/concept.md', '# Thing tracker\n');
				return [{ type: 'assistant-text', text: 'written' }, usage(600, 120)];
			},
			// 4 — now a build turn, exactly as a concept fixture gets on ITS turn 1.
			async (input) => {
				await writeModule(input);
				return [{ type: 'assistant-text', text: 'built' }, usage(1000, 200)];
			},
		]);

		const result = await runEval({
			ws,
			projectWs,
			projectDir: dir,
			fixture: PROMPT_FIXTURE,
			makeGenerator: async () => gen,
			gates: [],
			probe: probeOf(GOOD_PROBE),
		});

		// The sequence is the deliverable: the brief verbatim, the answers as ONE
		// block, the harness's approval, and only then the same BUILD_MESSAGE a
		// frozen-concept fixture starts with. That last convergence is what makes
		// the two modes' build halves comparable.
		expect(gen.received).toEqual([
			PROMPT_FIXTURE.prompt,
			PROMPT_FIXTURE.answers,
			APPROVE_MESSAGE,
			BUILD_MESSAGE,
		]);
		expect(result.passed).toBe(true);
		// The question the interview asked is still counted — stop-discipline is
		// measured across the interview too, and #740 wants forks-per-question.
		expect(result.questions).toBe(1);
	});

	it('does not approve a concept that was never proposed when a second round is asked', async () => {
		// The replay is keyed on PHASE, not on turn number. A model that asks
		// again after the answers must get the approval message (which also says
		// "take the conventional option"), never a build instruction — interview
		// turns cannot write code, so a build message there is a wasted turn.
		const ws = await scratchRoot();
		const dir = `${EVAL_PROJECT_PREFIX}${PROMPT_FIXTURE.name}`;
		await prepareProject(ws, dir, PROMPT_FIXTURE);
		const projectWs = new LocalWorkspace({ root: join((ws as LocalWorkspace).root, dir) });

		const gen = scripted([
			async () => [{ type: 'question', question: 'round 1?', options: ['a'] }, usage(400, 40)],
			async () => [{ type: 'question', question: 'round 2?', options: ['a'] }, usage(400, 40)],
			async () => [{ type: 'question', question: 'round 3?', options: ['a'] }, usage(400, 40)],
		]);

		await runEval({
			ws,
			projectWs,
			projectDir: dir,
			fixture: { ...PROMPT_FIXTURE, expect: { ...PROMPT_FIXTURE.expect, maxTurns: 4 } },
			makeGenerator: async () => gen,
			gates: [],
			probe: probeOf(GOOD_PROBE),
		});

		expect(gen.received).toEqual([
			PROMPT_FIXTURE.prompt,
			PROMPT_FIXTURE.answers,
			APPROVE_MESSAGE,
			APPROVE_MESSAGE,
		]);
	});

	it('gets the interview turns ON TOP of the build ceiling', async () => {
		// Otherwise starting at the prompt would look worse purely for having
		// further to walk, and the metric would punish the mode rather than the
		// model.
		const ws = await scratchRoot();
		const dir = `${EVAL_PROJECT_PREFIX}${PROMPT_FIXTURE.name}`;
		await prepareProject(ws, dir, PROMPT_FIXTURE);
		const projectWs = new LocalWorkspace({ root: join((ws as LocalWorkspace).root, dir) });
		const gen = scripted([async () => [usage(10, 1)]]);
		const result = await runEval({
			ws,
			projectWs,
			projectDir: dir,
			fixture: PROMPT_FIXTURE,
			makeGenerator: async () => gen,
			gates: [],
			probe: probeOf(GOOD_PROBE),
			maxTurns: 2,
		});
		expect(result.turns).toBe(2 + INTERVIEW_TURNS);
	});

	it('counts the INTERVIEW questions apart from the build ones', async () => {
		// The trap #740 names: a model that interrogates has fewer assumptions and
		// lands the same forks, so forks alone reward asking. Separating the
		// interview half of `questions` is what makes the pairing possible — a
		// question asked after the ladder moved is a build question, not an
		// assumption bought, however early in the run it lands.
		const ws = await scratchRoot();
		const dir = `${EVAL_PROJECT_PREFIX}${PROMPT_FIXTURE.name}`;
		await prepareProject(ws, dir, PROMPT_FIXTURE);
		const projectWs = new LocalWorkspace({ root: join((ws as LocalWorkspace).root, dir) });

		const gen = scripted([
			// 1 — interview: two questions in one round.
			async () => [
				{ type: 'question', question: 'who uses it?', options: ['a', 'b'] },
				{ type: 'question', question: 'screens?', options: ['a', 'b'] },
				usage(400, 40),
			],
			// 2 — answers land; still the interview phase, still asking.
			async () => [{ type: 'question', question: 'one more?', options: ['a'] }, usage(400, 40)],
			// 3 — approval: the concept is written, the ladder moves.
			async (input) => {
				await input.workspace.mkdir('spec', { recursive: true });
				await input.workspace.writeFile('spec/concept.md', '# Thing tracker\n');
				return [usage(600, 120)];
			},
			// 4 — a BUILD turn that also asks. Not an interview question.
			async (input) => {
				await writeModule(input);
				return [{ type: 'question', question: 'sqlite ok?', options: ['a'] }, usage(1000, 200)];
			},
		]);

		const result = await runEval({
			ws,
			projectWs,
			projectDir: dir,
			fixture: PROMPT_FIXTURE,
			makeGenerator: async () => gen,
			gates: [],
			probe: probeOf(GOOD_PROBE),
		});

		expect(result.questions).toBe(4);
		expect(result.interviewQuestions).toBe(3);
		expect(forkScore(result)).toEqual({ met: 1, total: 1, questions: 3, unresolved: false });
	});
});

describe('forkScore — forks correct AT a question count (#740)', () => {
	const resultWith = (
		expectations: EvalResult['expectations'],
		interviewQuestions: number,
	): EvalResult => ({
		fixture: 'fx',
		generatorId: 'scripted',
		passed: expectations.every((o) => o.ok),
		turns: 1,
		repairs: 0,
		questions: interviewQuestions,
		interviewQuestions,
		usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, steps: 0, stepUsage: [] },
		gates: null,
		expectations,
		durationMs: 0,
		projectDir: '.builder/projects/eval-fx',
	});

	it('pairs the forks landed with the interview questions spent', () => {
		const score = forkScore(
			resultWith(
				[
					{ kind: 'operation', target: 'todo/share-list', ok: true },
					{ kind: 'role', target: 'member', ok: false, detail: 'missing: list:share' },
					{ kind: 'file', target: 'app', ok: true },
				],
				2,
			),
		);
		expect(score).toEqual({ met: 2, total: 3, questions: 2, unresolved: false });
		expect(formatEvalResult(resultWith([{ kind: 'file', target: 'app', ok: true }], 5))).toContain(
			'1/1 fork(s) at 5 interview question(s)',
		);
	});

	it('two runs landing the same forks are separated only by the question count', () => {
		// The whole point. Without the pairing these two read as one result, and
		// the one that asked more would win on assumptions recorded.
		const forks: EvalResult['expectations'] = [
			{ kind: 'operation', target: 'todo/share-list', ok: true },
			{ kind: 'file', target: 'app', ok: true },
		];
		const assumed = forkScore(resultWith(forks, 1));
		const interrogated = forkScore(resultWith(forks, 7));
		expect(assumed.met).toBe(interrogated.met);
		expect(assumed.total).toBe(interrogated.total);
		expect(assumed.questions).toBeLessThan(interrogated.questions);
	});

	it('marks a run whose probe could not answer rather than flattering its ratio', () => {
		// A crashed probe replaces every pinned operation and role with ONE probe
		// outcome, so counting it as a miss would be wrong and dropping it
		// silently would make the ratio look better than a run that simply got
		// the forks wrong.
		const score = forkScore(
			resultWith(
				[
					{ kind: 'file', target: 'app', ok: true },
					{ kind: 'probe', target: 'MODULES export', ok: false, detail: 'no MODULES export' },
				],
				0,
			),
		);
		expect(score).toEqual({ met: 1, total: 1, questions: 0, unresolved: true });
		expect(formatForkScore(score)).toContain('1/1? fork(s)');
	});

	it('still prints the line when a crashed probe leaves NOTHING judgeable', () => {
		// A fixture pinning only operations and roles loses every fork to one
		// probe outcome, so the score is 0/0 — which on its own reads as a clean
		// sheet. Staying silent there is the reading `unresolved` exists to stop.
		const result = resultWith(
			[{ kind: 'probe', target: 'MODULES export', ok: false, detail: 'no MODULES export' }],
			4,
		);
		expect(forkScore(result)).toEqual({ met: 0, total: 0, questions: 4, unresolved: true });
		expect(formatEvalResult(result)).toContain(
			'0/0? fork(s) at 4 interview question(s) · probe unresolved',
		);
	});

	it('reports nothing to pair when the fixture pins no forks', () => {
		expect(formatEvalResult(resultWith([], 3))).not.toContain('fork(s)');
	});
});

describe('assertFixtureStart', () => {
	it('refuses a fixture that starts in two places, or in none', () => {
		expect(() => assertFixtureStart({ name: 'both', concept: 'c', prompt: 'p', answers: 'a', expect: {} })).toThrow(
			/both were supplied/,
		);
		expect(() => assertFixtureStart({ name: 'neither', expect: {} })).toThrow(/neither was supplied/);
	});

	it('refuses a prompt with nothing to answer', () => {
		// An interview replay with no answers stalls at the first round and burns
		// the whole ceiling asking.
		expect(() => assertFixtureStart({ name: 'p', prompt: 'brief', expect: {} })).toThrow(/needs answers\.md/);
	});

	it('accepts either honest shape', () => {
		expect(() => assertFixtureStart(FIXTURE)).not.toThrow();
		expect(() => assertFixtureStart(PROMPT_FIXTURE)).not.toThrow();
	});
});
