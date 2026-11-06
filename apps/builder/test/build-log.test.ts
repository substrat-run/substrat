/**
 * A hosted build keeps its own record (build-log.ts). The agent is a Durable Object over a
 * sandbox, so the recorder is driven directly here; its wiring into the agent and the
 * worker is pinned off the source, as build-queue.test.ts does for the queue.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SandboxLike } from '@substrat-run/builder-workspace/edge';
import { CommandFailedError, interruptedResponse, SourceBuildError } from '../src/problem.js';
import { BuildLog, buildIdFrom, errorDetail, failureDetail, INTERRUPTION_MAX, interruptedRecord, interruptionOf, invalidFields, isBuildId, fitted, OUTPUT_TAIL, RECORD_MAX, RECORDS_KEPT, retained, ulid, type BuildRecord } from '../src/build-log.js';

const ID = '01M6M2KNCVEV3AFPHTAMYRMC1X';

function fakeSandbox(answers: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>): SandboxLike {
	return {
		exec: async (cmd) => ({ stdout: '', stderr: '', exitCode: 0, ...answers[cmd] }),
		readFile: async () => '',
		writeFile: async () => undefined,
		mkdir: async () => undefined,
		listFiles: async () => [],
		exposePort: async () => ({ url: '' }),
	};
}

function recorded(): { log: BuildLog; saved: BuildRecord[] } {
	const saved: BuildRecord[] = [];
	return { log: new BuildLog(ID, 'acme/crm', async (r) => { saved.push(r); }), saved };
}

describe('the build record', () => {
	it('stores each step as it starts, and keeps output only for a step that asks', async () => {
		const { log, saved } = recorded();
		const sb = log.sandbox(fakeSandbox({
			'git fetch': { stderr: 'fatal: Authorization: Bearer secret', exitCode: 128 },
			'pnpm install': { stdout: 'Done in 3s' },
		}));
		await log.begin('check out the repository');
		await sb.exec('git fetch');
		// Stored before anything in the step ran, so a reset mid-step still shows where it was.
		expect(saved.at(-1)!.steps.at(-1)).toMatchObject({ step: 'check out the repository', commands: [] });
		await log.begin('install and build', { keepOutput: true });
		await sb.exec('pnpm install');

		const [checkout, build] = log.record.steps;
		expect(checkout!.commands).toEqual([{ command: 'git fetch', exitCode: 128, ms: expect.any(Number) }]);
		expect(JSON.stringify(log.record)).not.toContain('secret');
		expect(build!.commands[0]!.output).toBe('Done in 3s');
		expect(log.step).toBe('install and build');
	});

	it('a failure names the build and its step, with the last output when the error carries none', async () => {
		const { log, saved } = recorded();
		const sb = log.sandbox(fakeSandbox({ build: { stdout: 'line 1\nline 2' } }));
		await log.begin('install and build', { keepOutput: true });
		await sb.exec('build');

		expect(failureDetail(log, 'stopped', { withOutput: true }))
			.toBe(`stopped (build ${ID}, step "install and build")\n--- last build output ---\nline 1\nline 2`);
		expect(failureDetail(log, 'command failed: x', { withOutput: false })).toBe(`command failed: x (build ${ID}, step "install and build")`);

		await log.finish('failed', 'stopped');
		expect(saved.at(-1)).toMatchObject({ outcome: 'failed', detail: 'stopped' });
	});

	it('a later failure keeps the retained tail; a command failure, which carries its own output, does not', async () => {
		const { log } = recorded();
		const sb = log.sandbox(fakeSandbox({ build: { stdout: 'compiled ok' } }));
		await log.begin('install and build', { keepOutput: true });
		await sb.exec('build');
		await log.begin('collect the release');

		expect(errorDetail(log, 'release output exceeds the limit', new SourceBuildError('x'))).toContain('--- last build output ---\ncompiled ok');
		expect(errorDetail(log, 'command failed: boom', new CommandFailedError('x'))).not.toContain('last build output');
	});

	it('a request naming an extra field is reported by that field, not by its container', () => {
		expect(invalidFields([
			{ code: 'unrecognized_keys', path: [], keys: ['extra'] },
			{ code: 'unrecognized_keys', path: ['origin'], keys: ['a', 'b'] },
			{ code: 'invalid_type', path: ['name'] },
			{ code: 'custom', path: [] },
		])).toEqual(['extra', 'origin.a', 'origin.b', 'name', '(root)']);
	});

	it('output is cut to its tail, and a record over the limit drops the oldest output first', () => {
		const big = 'x'.repeat(OUTPUT_TAIL);
		const commands = Array.from({ length: 20 }, (_, i) => ({ command: `c${i}`, exitCode: 0, ms: 1, output: big }));
		const cut = fitted({ buildId: ID, slug: 's', outcome: 'building', steps: [{ step: 'install and build', startedAt: '', commands }] });
		expect(JSON.stringify(cut).length).toBeLessThanOrEqual(RECORD_MAX);
		const kept = cut.steps[0]!.commands;
		expect(kept.at(-1)!.output).toBe(big);
		expect(kept[0]!.output).toBeUndefined();
		expect(kept.map((c) => c.command)).toEqual(commands.map((c) => c.command));
	});

	it('keeps the newest records and names the ones that fall out', () => {
		const ids = Array.from({ length: RECORDS_KEPT }, (_, i) => `id${String(i).padStart(2, '0')}`);
		expect(retained(ids.slice(0, 3), 'new')).toEqual({ index: ['id00', 'id01', 'id02', 'new'], dropped: [] });
		const full = retained(ids, 'new');
		expect(full.dropped).toEqual(['id00']);
		expect(full.index).toHaveLength(RECORDS_KEPT);
		expect(full.index.at(-1)).toBe('new');
	});

	it('takes the worker\'s build id, and makes one when the header is absent or malformed', () => {
		expect(buildIdFrom(ID)).toBe(ID);
		for (const header of [null, 'not-an-id', `${ID}x`]) expect(buildIdFrom(header)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(ulid()).not.toBe(ulid());
	});
});

describe('a build the agent never answered for (#2931)', () => {
	it('keeps what the stub threw as one line, with the flags that tell a reset from a refusal', () => {
		const reset = Object.assign(new Error('Network connection lost.'), { retryable: true, overloaded: true });
		expect(interruptionOf(reset)).toBe('Error: Network connection lost. [retryable, overloaded]');
		expect(interruptionOf(new TypeError('Illegal invocation'))).toBe('TypeError: Illegal invocation');
		expect(interruptionOf('dropped')).toBe('dropped');
		expect(interruptionOf(new Error('x'.repeat(INTERRUPTION_MAX * 2))).length).toBe(INTERRUPTION_MAX);
	});

	it('marks a running record, writes one for a build that never did, and leaves a finished one', () => {
		const steps = [{ step: 'install and build', startedAt: 't', commands: [] }];
		const running: BuildRecord = { buildId: ID, slug: 'acme/crm', outcome: 'building', steps };
		expect(interruptedRecord(running, ID, 'why')).toEqual({ ...running, outcome: 'interrupted', interruption: 'why' });
		expect(interruptedRecord(undefined, ID, 'why')).toEqual({ buildId: ID, slug: null, steps: [], outcome: 'interrupted', interruption: 'why' });
		expect(interruptedRecord({ ...running, outcome: 'built' }, ID, 'why')).toBeNull();
		expect(interruptedRecord({ ...running, outcome: 'failed' }, ID, 'why')).toBeNull();
	});

	it('answers the sentence with the runtime text beside it, never in it', async () => {
		const response = interruptedResponse('the build service stopped', 'Error: Network connection lost.');
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ detail: 'the build service stopped', diagnostic: 'Error: Network connection lost.' });
	});

	it('reads a build id out of a path only when it is shaped like one', () => {
		expect(isBuildId(ID)).toBe(true);
		expect(isBuildId('../source-registry')).toBe(false);
	});
});

describe('the hosted build uses it', () => {
	const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');

	it('the agent records through the log\'s sandbox and finishes the record either way', () => {
		const agent = read('agent.ts');
		const build = agent.slice(agent.indexOf('async #build('), agent.indexOf('async #keepBuildRecord('));
		expect(build).toContain('const sb = log.sandbox(sandboxLike(raw');
		expect(build).toContain("await log.begin('install and build', { keepOutput: true });");
		expect(build).toContain("await log.finish('built');");
		expect(build).toContain("await log.finish('failed', detail)");
	});

	it('the worker names the build and answers a sentence when the agent never does', () => {
		const worker = read('worker.ts');
		expect(worker).toContain('request.headers.set(BUILD_ID_HEADER, buildId);');
		expect(worker).toMatch(/catch \(error\) \{[\s\S]*?source\.build\.interrupted[\s\S]*?interruptedResponse\(`platform build failed: the build service stopped before it answered \(build \$\{buildId\}\)[^`]*`, interruption\)/);
	});

	it('the worker marks the record on a new stub, and keeps that route to itself', () => {
		const worker = read('worker.ts');
		const caught = worker.slice(worker.indexOf('const interruption = interruptionOf(error);'));
		expect(caught).toContain('c.env.BUILDER_AGENT.get(c.env.BUILDER_AGENT.idFromName(tenant))');
		expect(caught).toContain("'https://builder/internal/build-interrupted'");
		expect(worker).toContain("if (path !== '/internal/build' && path !== '/internal/projects' && !buildRead) return refuse(404, 'not found');");
		expect(worker).toContain("if (buildRead && !isBuildId(buildRead[1]!)) return refuse(400, 'invalid build id');");
	});
});
