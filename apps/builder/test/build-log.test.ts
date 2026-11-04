/**
 * A hosted build keeps its own record (build-log.ts). The agent is a Durable Object over a
 * sandbox, so the recorder is driven directly here; its wiring into the agent and the
 * worker is pinned off the source, as build-queue.test.ts does for the queue.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SandboxLike } from '@substrat-run/builder-workspace/edge';
import { BuildLog, buildIdFrom, failureDetail, fitted, OUTPUT_TAIL, RECORD_MAX, RECORDS_KEPT, retained, ulid, type BuildRecord } from '../src/build-log.js';

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
		expect(worker).toMatch(/catch \(error\) \{[\s\S]*?source\.build\.interrupted[\s\S]*?refuse\(502, `platform build failed: the build service stopped before it answered \(build \$\{buildId\}\)/);
	});
});
