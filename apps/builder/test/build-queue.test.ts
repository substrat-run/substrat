/**
 * Builds queue per vertical instead of being refused (#2795).
 *
 * The queue is driven directly; the agent's use of it is pinned off the source, for the
 * reason file-write-containment.test.ts gives: the hosted agent is a Durable Object
 * needing a sandbox, and the failure worth guarding is the refusal drifting back in.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILD_WAIT_MS, BuildQueue, BuildWaitExpired } from '../src/build-queue.js';

const fast = () => new BuildQueue({ waitMs: 200, pollMs: 5 });

/** A build that runs until `finish()` is called. */
function held(): { fn: () => Promise<string>; started: Promise<void>; finish: (v: string) => void } {
	let finish!: (v: string) => void;
	let started!: () => void;
	const startedP = new Promise<void>((r) => { started = r; });
	const done = new Promise<string>((r) => { finish = r; });
	return { fn: () => { started(); return done; }, started: startedP, finish };
}

describe('the build queue', () => {
	it('a second build of the same vertical waits for the first and then runs', async () => {
		const q = fast();
		const first = held();
		const a = q.run('acme/crm', () => false, first.fn);
		await first.started;
		let secondRan = false;
		const b = q.run('acme/crm', () => false, async () => { secondRan = true; return 'b'; });
		await new Promise((r) => setTimeout(r, 20));
		expect(secondRan).toBe(false);
		expect(q.building('acme/crm')).toBe(true);
		first.finish('a');
		await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
		expect(q.building('acme/crm')).toBe(false);
	});

	it('builds of different verticals run side by side', async () => {
		const q = fast();
		const crm = held();
		const a = q.run('acme/crm', () => false, crm.fn);
		await crm.started;
		await expect(q.run('acme/drive', () => false, async () => 'drive')).resolves.toBe('drive');
		crm.finish('crm');
		await expect(a).resolves.toBe('crm');
	});

	it('a build waits while a studio operation holds its project, then runs', async () => {
		const q = fast();
		let studio = true;
		setTimeout(() => { studio = false; }, 30);
		await expect(q.run('acme/crm', () => studio, async () => 'built')).resolves.toBe('built');
		expect(studio).toBe(false);
	});

	it('the wait is bounded, and giving up never releases the build it waited on', async () => {
		expect(BUILD_WAIT_MS).toBe(2 * 60_000);
		const q = fast();
		const first = held();
		const a = q.run('acme/crm', () => false, first.fn);
		await first.started;
		await expect(q.run('acme/crm', () => false, async () => 'never')).rejects.toThrow(BuildWaitExpired);
		await expect(q.run('acme/crm', () => true, async () => 'never')).rejects.toThrow('project operation already in progress');
		// A third build, queued after one that gave up, still waits for the first.
		let thirdRan = false;
		const c = q.run('acme/crm', () => false, async () => { thirdRan = true; return 'c'; });
		await new Promise((r) => setTimeout(r, 20));
		expect(thirdRan).toBe(false);
		first.finish('a');
		await expect(Promise.all([a, c])).resolves.toEqual(['a', 'c']);
	});
});

describe('the hosted agent uses it', () => {
	const agent = readFileSync(fileURLToPath(new URL('../src/agent.ts', import.meta.url)), 'utf8');
	const between = (from: string, to: string) => agent.slice(agent.indexOf(from), agent.indexOf(to, agent.indexOf(from)));

	it('a build is queued, never refused on the studio flag', () => {
		const build = between('async #build(', 'async #cachedSnapshot(');
		expect(build).toMatch(/this\.#builds\.run\(/);
		expect(build).not.toMatch(/#busy\s*=/);
		expect(build).not.toMatch(/if \(this\.#busy\) return refuse/);
	});

	it('a waiting build has already let go of the submitted snapshot', () => {
		// Tens of MB per monorepo: held across the wait, every queued build would keep one in
		// this DO's memory. It goes to the build's sandbox, and out of `request`, first.
		const build = between('async #build(', 'async #cachedSnapshot(');
		const queued = build.indexOf('this.#builds.run(');
		const dropped = build.indexOf('request = { ...request, snapshot: undefined }');
		expect(dropped).toBeGreaterThan(build.indexOf("writeSandboxFile(sb, '/build/snapshot.json'"));
		expect(dropped).toBeGreaterThan(-1);
		expect(dropped).toBeLessThan(queued);
		expect(build.slice(queued)).not.toMatch(/request\.snapshot/);
	});

	it('no studio path saves a registry it read before a long await', () => {
		// The turn read the registry at its start and saved that copy at its end, which
		// would drop a project a build created meanwhile. Entries go through #putEntry.
		expect(between('async #turn(', 'override async fetch(')).not.toMatch(/#save\(reg\)/);
	});
});
