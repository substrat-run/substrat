/**
 * The turn summaries (src/turns.ts) a closed record leaves behind, over the REAL
 * studio scope — what the console filters on, and the one turn it opens. Only
 * the Cloudflare adapter class is shimmed (studio-shim.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateRun } from '@substrat-run/builder-workspace';
import { startStudio, stopStudio } from './studio-shim.js';

type RecordModule = typeof import('../src/record.js');

vi.mock('@substrat-run/adapter-cloudflare', () => import('./studio-shim.js'));

const env = { SCOPE: {} } as unknown as import('../src/studio.js').StudioEnv;

const turn = (threadId: string | null, turnId: string, over: { tenantId?: string; projectId?: string } = {}) => ({
	threadId,
	title: 'Our Lists',
	projectId: over.projectId ?? 'P1',
	tenantId: over.tenantId ?? 'TEAM1',
	turnId,
	message: 'Build it',
	actor: 'auth0|anna',
	model: 'anthropic:claude-opus-5',
});

const redModelEmit: GateRun = {
	ok: false,
	durationMs: 10,
	results: [
		{ name: 'model', status: 'passed', exitCode: 0, durationMs: 1, output: '' },
		{
			name: 'model-emit',
			status: 'failed',
			exitCode: 1,
			durationMs: 1,
			output: "\nmodel-diff: spec/model.ts could not be imported — model: 'lists/list' returns a bare array\n  Remedy: …",
		},
	],
};

describe('turn summaries', () => {
	let rec: RecordModule;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		startStudio();
		vi.resetModules();
		rec = await import('../src/record.js');
	});

	afterEach(() => {
		stopStudio();
		vi.useRealTimers();
	});

	it("summarises a turn's last gate run, repairs, commit and tokens, and reads back only that turn's events", async () => {
		const first = (await rec.TurnRecord.open(env, turn(null, 'T1')))!;
		first.event({ type: 'phase', phase: 'interview' });
		await first.finish({ kind: 'done' });

		const second = (await rec.TurnRecord.open(env, turn(first.threadId, 'T2')))!;
		second.event({ type: 'phase', phase: 'model' });
		second.event({ type: 'gates', run: { ok: true, durationMs: 1, results: [] } });
		second.note('repair-prompt', 'The gates are red');
		second.event({ type: 'usage', inputTokens: 100, outputTokens: 10, steps: 1 });
		second.event({ type: 'usage', inputTokens: 50, outputTokens: 5, steps: 1 });
		second.event({ type: 'gates', run: redModelEmit });
		second.event({ type: 'commit', sha: 'cfe7cd60abc', summary: '1 files' });
		second.event({ type: 'phase', phase: 'scenario' });
		await second.finish({ kind: 'done' });

		const read = (await rec.readTurn(env, 'T2'))!;
		expect(read.turn).toMatchObject({
			tenantId: 'TEAM1',
			projectName: 'Our Lists',
			outcome: 'done',
			phaseStart: 'model',
			phaseEnd: 'scenario',
			gatesOk: false,
			redGates: [
				{ name: 'model-emit', status: 'failed', line: expect.stringMatching(/^model-diff: .* returns a bare array$/) },
			],
			repairs: 1,
			commitSha: 'cfe7cd60abc',
			inputTokens: 150,
			outputTokens: 15,
		});
		expect(read.events[0]).toMatchObject({ t: 'user-message' });
		expect(read.events.at(-1)).toMatchObject({ t: 'turn-finish' });
		expect(read.events.filter((e) => e.t === 'user-message')).toHaveLength(1);
		expect(read.cut).toBe(false);
		expect(await rec.readTurn(env, 'T9')).toBeNull();
	});

	it('lists turns most recent first, filtered by team, red gate and trouble, and pages', async () => {
		const ok = (await rec.TurnRecord.open(env, turn(null, 'A')))!;
		await ok.finish({ kind: 'done' });
		const red = (await rec.TurnRecord.open(env, turn(ok.threadId, 'B')))!;
		red.event({ type: 'gates', run: redModelEmit });
		await red.finish({ kind: 'done' });
		const other = (await rec.TurnRecord.open(env, turn(null, 'C', { tenantId: 'TEAM2', projectId: 'P2' })))!;
		other.event({ type: 'error', message: 'provider down', fatal: true });
		await other.finish({ kind: 'error' });

		const ids = async (query: Record<string, unknown>) => (await rec.listTurns(env, query)).entries.map((t) => t.turnId);
		expect(await ids({})).toEqual(['C', 'B', 'A']);
		expect(await ids({ tenantId: 'TEAM1' })).toEqual(['B', 'A']);
		expect(await ids({ redGate: 'model-emit' })).toEqual(['B']);
		expect(await ids({ troubled: true })).toEqual(['C', 'B']);
		expect(await ids({ outcome: 'error' })).toEqual(['C']);

		const page = await rec.listTurns(env, { limit: 2 });
		expect(page.entries.map((t) => t.turnId)).toEqual(['C', 'B']);
		expect(await ids({ limit: 2, cursor: page.nextCursor })).toEqual(['A']);
	});

	it('summarises a turn that died as interrupted when the next turn closes it, and opens its events', async () => {
		const died = (await rec.TurnRecord.open(env, turn(null, 'T1')))!;
		died.event({ type: 'assistant-text', text: 'Starting.' });
		await died.flush();
		const next = (await rec.TurnRecord.open(env, {
			...turn(died.threadId, 'T2'),
			unfinishedTurnId: 'T1',
			unfinishedFirstSeq: died.firstSeq,
		}))!;
		await next.finish({ kind: 'done' });

		const lost = (await rec.readTurn(env, 'T1'))!;
		expect(lost.turn).toMatchObject({ outcome: 'interrupted', startedAt: null });
		expect(lost.events[0]).toMatchObject({ t: 'user-message' });
		expect(lost.events.at(-1)).toMatchObject({ t: 'turn-error', code: 'interrupted' });
		expect(lost.events.filter((e) => e.t === 'user-message')).toHaveLength(1);
		expect((await rec.listTurns(env, { outcome: 'interrupted' })).entries.map((t) => t.turnId)).toEqual(['T1']);
	});
});
