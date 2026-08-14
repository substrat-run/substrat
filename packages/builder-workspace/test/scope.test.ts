/**
 * The studio must never commit work it did not do — nor pollute a surrounding
 * repo's history. Regression tests for a real incident (`git add -A` at the
 * monorepo root swept unrelated in-progress work into "studio turn 1: hi"), now
 * covering both git modes:
 *
 * - project mode (§4.6): the vertical is its OWN repo; the parent repo never
 *   sees a commit at all.
 * - legacy scoped mode: the vertical lives inside a larger repo; commits are
 *   path-scoped.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalWorkspace } from '../src/local.js';
import { changedFiles, ensureVerticalRepo, foreignChanges, runTurn } from '../src/turn.js';

const NO_GATES: [] = [];
const PROJECT = '.builder/projects/x';

async function repo(): Promise<LocalWorkspace> {
	const root = await mkdtemp(join(tmpdir(), 'builder-scope-'));
	const ws = new LocalWorkspace({ root });
	await ws.exec('git init -q');
	await ws.writeFile('README.md', 'seed\n');
	await ws.exec('git add -A');
	await ws.exec("git -c user.name=t -c user.email=t@t commit -q -m seed");
	return ws;
}

describe('project mode — the vertical is its own repo (§4.6)', () => {
	let ws: LocalWorkspace;

	beforeEach(async () => {
		ws = await repo();
		await ws.writeFile('unrelated.ts', 'export const MINE = 1;\n');
	});

	it('initialises a nested repo with an initial commit and .gitignore', async () => {
		const ensured = await ensureVerticalRepo(ws, PROJECT);
		expect(ensured).toEqual({ mode: 'project', initialized: true });
		expect(await ws.exists(`${PROJECT}/.git`)).toBe(true);
		expect(await ws.readFile(`${PROJECT}/.gitignore`)).toContain('node_modules/');

		// Idempotent on the second call.
		expect(await ensureVerticalRepo(ws, PROJECT)).toEqual({
			mode: 'project',
			initialized: false,
		});
	});

	it("commits land in the project repo; the parent repo's history never moves", async () => {
		await ensureVerticalRepo(ws, PROJECT);
		const parentBefore = await ws.exec('git rev-parse HEAD');

		await ws.writeFile(`${PROJECT}/src/module.ts`, 'export const M = 1;\n');
		const turn = await runTurn(ws, { verticalDir: PROJECT, message: 'turn 1', gates: NO_GATES });

		expect(turn.commit).not.toBeNull();
		const projectLog = await ws.exec('git log --oneline', { cwd: PROJECT });
		expect(projectLog.stdout).toContain('turn 1');

		const parentAfter = await ws.exec('git rev-parse HEAD');
		expect(parentAfter.stdout).toBe(parentBefore.stdout);
		// The unrelated file is still uncommitted in the parent, untouched.
		expect(await changedFiles(ws)).toContain('unrelated.ts');
	});

	it('reports no foreign changes — the repo boundary makes them impossible', async () => {
		await ensureVerticalRepo(ws, PROJECT);
		expect(await foreignChanges(ws, PROJECT)).toEqual([]);
	});

	it('refuses to nest a repo inside a parent-tracked directory', async () => {
		await ws.writeFile('demos/x/existing.ts', 'export const A = 1;\n');
		await ws.exec('git add -A && git -c user.name=t -c user.email=t@t commit -q -m demos');

		const ensured = await ensureVerticalRepo(ws, 'demos/x');
		expect(ensured.mode).toBe('scoped');
		expect(await ws.exists('demos/x/.git')).toBe(false);
	});
});

describe('legacy scoped mode — the vertical inside a larger repo', () => {
	let ws: LocalWorkspace;

	beforeEach(async () => {
		ws = await repo();
		await ws.writeFile('demos/x/marker.ts', 'export const A = 1;\n');
		await ws.exec('git add -A && git -c user.name=t -c user.email=t@t commit -q -m demos');
		await ws.writeFile('unrelated.ts', 'export const MINE = 1;\n');
	});

	it('leaves work outside the vertical uncommitted', async () => {
		await ws.writeFile('demos/x/src/module.ts', 'export const M = 1;\n');
		const turn = await runTurn(ws, { verticalDir: 'demos/x', message: 'turn 1', gates: NO_GATES });

		expect(turn.commit).not.toBeNull();
		const show = await ws.exec('git show --stat --format= HEAD');
		expect(show.stdout).toContain('demos/x/src/module.ts');
		expect(show.stdout).not.toContain('unrelated.ts');
		expect(await changedFiles(ws)).toContain('unrelated.ts');
	});

	it('commits nothing when the turn changed nothing, however dirty the tree', async () => {
		const before = await ws.exec('git rev-parse HEAD');
		const turn = await runTurn(ws, {
			verticalDir: 'demos/x',
			message: 'no-op turn',
			gates: NO_GATES,
		});
		expect(turn.commit).toBeNull();
		expect((await ws.exec('git rev-parse HEAD')).stdout).toBe(before.stdout);
	});

	it('reports foreign changes so the session can warn', async () => {
		await ws.writeFile('demos/x/src/module.ts', 'export const M = 1;\n');
		const foreign = await foreignChanges(ws, 'demos/x');
		expect(foreign).toContain('unrelated.ts');
		expect(foreign.some((f) => f.startsWith('demos/x'))).toBe(false);
	});
});
