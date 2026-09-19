/**
 * `model.json` for a studio project (#684).
 *
 * What carries the studio's Model tab is mostly ORDER and BLAST RADIUS rather
 * than JSON, so that is what the first two halves hold:
 *
 * - The artifact is re-emitted after the install (the emitter imports the
 *   project's TypeScript, so its deps have to be linked) and before the tree is
 *   read for the commit decision — so a turn whose only change IS the artifact
 *   still commits it. An uncommitted artifact never reaches the snapshot the tab
 *   reads, and dies with the container.
 * - A failed emit never fails the turn. `spec/model.ts` is code the gates already
 *   judge; refusing to commit over it would throw away the work that produced it.
 *
 * The third half runs the real emitter, because the first two script it.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { emitProjectModel } from '../src/model.js';
import { LocalWorkspace } from '../src/local.js';
import { ensureVerticalRepo, runTurn } from '../src/turn.js';
import type { ExecOptions, ExecResult } from '../src/workspace.js';

const PROJECT = 'proj';

/**
 * A workspace that answers git for real (so commits and `changedFiles` are the
 * genuine article) and scripts everything else — the emitter included, since
 * running the real `tools/model-diff.mts` would need a whole installed project.
 * Each non-git command is recorded, which is how the ordering claim is checked.
 */
class ScriptedWorkspace extends LocalWorkspace {
	readonly commands: string[] = [];
	emitExit = 0;
	/** Written by the scripted emitter, to stand in for what model-diff renders. */
	artifact: string | null = '{ "entities": {} }\n';

	override async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
		if (cmd.startsWith('git ')) return super.exec(cmd, opts);
		this.commands.push(cmd);
		if (cmd.includes('model-diff.mts')) {
			if (this.emitExit === 0 && this.artifact !== null) {
				await this.writeFile(`${PROJECT}/model.json`, this.artifact);
			}
			return { stdout: '', stderr: 'model-diff: boom', exitCode: this.emitExit };
		}
		return { stdout: '', stderr: '', exitCode: 0 };
	}
}

async function project(opts: { model?: boolean } = {}): Promise<ScriptedWorkspace> {
	const root = await mkdtemp(join(tmpdir(), 'builder-model-emit-'));
	await mkdir(join(root, PROJECT, 'spec'), { recursive: true });
	await writeFile(join(root, PROJECT, 'README.md'), '# project\n');
	if (opts.model !== false) {
		await writeFile(join(root, PROJECT, 'spec', 'model.ts'), 'export const model = {};\n');
	}
	return new ScriptedWorkspace({ root });
}

describe('emitProjectModel', () => {
	it('is a no-op with no spec/model.ts — the model phase has not run', async () => {
		const ws = await project({ model: false });
		expect(await emitProjectModel(ws, PROJECT)).toEqual({ status: 'absent', output: '' });
		expect(ws.commands).toEqual([]);
		await ws.dispose();
	});

	it('points the repo emitter at the one project, and reports what it wrote', async () => {
		const ws = await project();
		expect(await emitProjectModel(ws, PROJECT)).toEqual({ status: 'emitted', output: '' });
		expect(ws.commands).toEqual([`pnpm exec tsx tools/model-diff.mts --root "${PROJECT}"`]);
		expect(await ws.readFile(`${PROJECT}/model.json`)).toBe('{ "entities": {} }\n');
		await ws.dispose();
	});

	it('reports a refusal instead of throwing — the gates own that failure', async () => {
		const ws = await project();
		ws.emitExit = 2;
		const r = await emitProjectModel(ws, PROJECT);
		expect(r.status).toBe('failed');
		expect(r.output).toContain('model-diff: boom');
		await ws.dispose();
	});
});

describe('runTurn re-emits the artifact into the commit', () => {
	it('commits a turn whose only change is the artifact — otherwise it never reaches a snapshot', async () => {
		const ws = await project();
		await ensureVerticalRepo(ws, PROJECT);

		const turn = await runTurn(ws, { verticalDir: PROJECT, message: 'turn', gates: [] });

		expect(turn.model).toEqual({ status: 'emitted', output: '' });
		expect(turn.changedFiles).toContain('model.json');
		expect(turn.commit).not.toBeNull();
		await ws.dispose();
	});

	it('emits AFTER the install, so the scaffold turn that writes both gets an artifact', async () => {
		const ws = await project();
		// A vertical with a manifest and no node_modules — runTurn's own trigger for
		// the host-owned install. The emitter imports the project's TypeScript, so
		// running it first would meet unlinked workspace:* deps.
		await ws.writeFile(`${PROJECT}/package.json`, '{ "name": "proj" }\n');
		await ensureVerticalRepo(ws, PROJECT);

		await runTurn(ws, { verticalDir: PROJECT, message: 'turn', gates: [] });

		expect(ws.commands).toEqual([
			'pnpm install',
			`pnpm exec tsx tools/model-diff.mts --root "${PROJECT}"`,
		]);
		await ws.dispose();
	});

	it('still commits the turn when the emit fails — work is not lost over a projection', async () => {
		const ws = await project();
		ws.emitExit = 2;
		await ensureVerticalRepo(ws, PROJECT);
		// What the generator wrote this turn, which is what must survive.
		await ws.writeFile(`${PROJECT}/spec/model.ts`, 'export const model = { broken: true };\n');

		const turn = await runTurn(ws, { verticalDir: PROJECT, message: 'turn', gates: [] });

		expect(turn.model.status).toBe('failed');
		expect(turn.changedFiles).toContain('spec/model.ts');
		expect(turn.commit).not.toBeNull();
		await ws.dispose();
	});
});

// ---------------------------------------------------------------------------
// The emitter itself, over a project outside this workspace
// ---------------------------------------------------------------------------

/**
 * `emitProjectModel` runs a command, and the tests above script it — which proves
 * the ordering and the blast radius, and nothing about whether the command works.
 * This half closes that: the same `tools/model-diff.mts --root` the studio calls,
 * run for real against a project that is not a member of this workspace, the way
 * `gates-standalone.test.ts` does for the permission and api checkpoints.
 */
const run = promisify(execFile);
const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

async function tool(args: string[]): Promise<{ code: number; out: string }> {
	try {
		const { stdout, stderr } = await run('pnpm', ['exec', 'tsx', ...args], { cwd: REPO_ROOT });
		return { code: 0, out: stdout + stderr };
	} catch (e) {
		const err = e as { code?: number; stdout?: string; stderr?: string };
		return { code: err.code ?? -1, out: (err.stdout ?? '') + (err.stderr ?? '') };
	}
}

/**
 * A project shaped like a studio-generated vertical: `spec/model.ts` exporting an
 * emitted model. Nothing here imports contracts, because the tool reads the shape
 * structurally and never boots a host — the same reason its output is a pure
 * function of the declaration.
 */
async function fixtureProject(): Promise<string> {
	const dir = join(await mkdtemp(join(tmpdir(), 'model-diff-root-')), 'acme');
	await mkdir(join(dir, 'spec'), { recursive: true });
	await writeFile(
		join(dir, 'spec/model.ts'),
		'export const model = {\n' +
			'  entities: {\n' +
			'    item: { table: "acme_items", fields: { type: "object" }, parents: ["list"] },\n' +
			'    list: { table: "acme_lists", fields: { type: "object" } },\n' +
			'  },\n' +
			'  lifecycles: {\n' +
			'    item: { field: "state", initial: "open", states: { open: { on: { close: "done" } }, done: {} } },\n' +
			'  },\n' +
			'};\n',
	);
	return dir;
}

describe('model-diff --root — the emitter the studio calls', () => {
	it('renders one project, agrees with itself, then reports drift', async () => {
		const dir = await fixtureProject();

		// Nothing about the sweep runs here: the fixture has no demos/ and no
		// engines/ beside it, and holding it to theirs would refuse every project
		// this mode exists to serve.
		const first = await tool(['tools/model-diff.mts', '--root', dir]);
		expect(first.code).toBe(0);
		expect(first.out).toContain('1 lifecycle');

		const artifact = join(dir, 'model.json');
		const rendered = JSON.parse(await readFile(artifact, 'utf8')) as {
			entities: Record<string, { table: string }>;
		};
		expect(Object.keys(rendered.entities)).toEqual(['item', 'list']);
		expect(rendered.entities['item']?.table).toBe('acme_items');

		expect((await tool(['tools/model-diff.mts', '--root', dir, '--check'])).code).toBe(0);

		await writeFile(artifact, '{"entities":{}}\n');
		const drift = await tool(['tools/model-diff.mts', '--root', dir, '--check']);
		expect(drift.code).toBe(1);
		expect(drift.out).toContain('is stale');
	}, 60_000);

	it('a project declaring no entity model is exit 2, never a green light', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'model-diff-bare-'));
		const r = await tool(['tools/model-diff.mts', '--root', dir, '--check']);
		expect(r.code).toBe(2);
		expect(r.out).toContain('declares no entity model');
	}, 60_000);

	it('--root without a directory is exit 2', async () => {
		const r = await tool(['tools/model-diff.mts', '--root', '--check']);
		expect(r.code).toBe(2);
		expect(r.out).toContain('--root needs a directory');
	}, 60_000);
});
