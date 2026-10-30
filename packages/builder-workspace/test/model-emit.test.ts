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
 * - A failed emit makes the gates red while preserving the turn's work.
 *
 * The third half runs the real emitter, because the first two script it.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { emitProjectModel, modelEmitWarning } from '../src/model.js';
import { LocalWorkspace } from '../src/local.js';
import { ensureVerticalRepo, runTurn } from '../src/turn.js';
import { repairNeeded, runGates, standaloneGates } from '../src/gates.js';
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
	emitStderr = 'model-diff: boom';
	/** Written by the scripted emitter, to stand in for what model-diff renders. */
	artifact: string | null = '{ "entities": {} }\n';

	override async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
		if (cmd.startsWith('git ')) return super.exec(cmd, opts);
		this.commands.push(cmd);
		if (cmd.includes('model-diff.mts')) {
			if (this.emitExit === 0 && this.artifact !== null) {
				await this.writeFile(`${PROJECT}/model.json`, this.artifact);
			}
			return { stdout: '', stderr: this.emitStderr, exitCode: this.emitExit };
		}
		return { stdout: '', stderr: '', exitCode: 0 };
	}
}

async function project(opts: { model?: boolean; emitter?: boolean } = {}): Promise<ScriptedWorkspace> {
	const root = await mkdtemp(join(tmpdir(), 'builder-model-emit-'));
	await mkdir(join(root, PROJECT, 'spec'), { recursive: true });
	// The emitter is scripted, but its presence at the root is what the probe reads.
	if (opts.emitter !== false) {
		await mkdir(join(root, 'tools'));
		await writeFile(join(root, 'tools', 'model-diff.mts'), '');
	}
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

	it('never throws, including out of the probe that decides whether to run at all', async () => {
		const ws = await project();
		// A workspace that went away mid-turn. "Never throws" has to hold for the
		// whole function, not for the part after the first await.
		ws.exists = async () => {
			throw new Error('container gone');
		};
		const r = await emitProjectModel(ws, PROJECT);
		// The workspace's failure, not the declaration's: blocked, which no repair answers.
		expect(r).toEqual({ status: 'blocked', output: 'container gone' });
		await ws.dispose();
	});
});

describe('runGates over an emission the model cannot fix', () => {
	it.each([
		['a workspace that cannot run the emitter', { exists: true }, 'blocked', false],
		[
			'a stale artifact on a recheck, which does not write',
			{ emitExit: 1, emitStderr: 'model-diff: proj/model.json is stale — re-run `x` and commit the diff' },
			'passed',
			true,
		],
		// node's own exit 1 for an uncaught throw: not drift, and never a pass.
		['an emitter that crashed with exit 1', { emitExit: 1, emitStderr: 'Error: EISDIR' }, 'blocked', false],
		['a root without the emitter', { emitter: false }, 'skipped', true],
	] as const)('%s asks for no repair', async (_, setup, status, ok) => {
		const ws = await project({ emitter: !('emitter' in setup) });
		if ('emitExit' in setup) {
			ws.emitExit = setup.emitExit;
			ws.emitStderr = setup.emitStderr;
		}
		if ('exists' in setup) {
			ws.exists = async () => {
				throw new Error('container gone');
			};
		}
		const run = await runGates(ws, PROJECT, []);
		expect(run.results).toEqual([expect.objectContaining({ name: 'model-emit', status })]);
		expect(run.ok).toBe(ok);
		expect(repairNeeded(run)).toBe(false);
		if ('emitter' in setup) expect(ws.commands).toEqual([]);
		if (status === 'passed') expect(run.results[0]?.note).toContain('next model turn');
		await ws.dispose();
	});
});

describe('modelEmitWarning', () => {
	it('says the tab is showing the PREVIOUS model, which is what a builder cannot otherwise see', () => {
		const warning = modelEmitWarning({ status: 'failed', output: 'TS2345 somewhere' });
		expect(warning).toContain('model.json');
		expect(warning).toContain('before this turn');
		expect(warning).toContain('TS2345 somewhere');
	});

	it('is silent when there is nothing to warn about', () => {
		expect(modelEmitWarning({ status: 'emitted', output: '' })).toBeNull();
		expect(modelEmitWarning({ status: 'absent', output: '' })).toBeNull();
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
		expect(turn.gates.ok).toBe(false);
		expect(turn.gates.results).toContainEqual(
			expect.objectContaining({ name: 'model-emit', status: 'failed' }),
		);
		expect(turn.changedFiles).toContain('spec/model.ts');
		expect(turn.commit).not.toBeNull();
		expect((await ws.exec('git log -1 --format=%B', { cwd: PROJECT })).stdout).toContain('gates: red');
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
async function fixtureProject(base = tmpdir()): Promise<string> {
	const dir = join(await mkdtemp(join(base, 'model-diff-root-')), 'acme');
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

describe('the model gate compiles under the project tsconfig once one exists (#2727)', () => {
	// A file `noUnusedLocals` refuses and the explicit defaults accept: only the
	// project's own config can tell the two forms apart.
	const compile = async (tsconfig: boolean) => {
		await mkdir(join(REPO_ROOT, '.builder'), { recursive: true });
		const dir = await mkdtemp(join(REPO_ROOT, '.builder/model-gate-'));
		try {
			await mkdir(join(dir, 'spec'));
			await writeFile(join(dir, 'spec/model.ts'), 'const unused = 1;\nexport const model = {};\n');
			if (tsconfig) {
				await writeFile(
					join(dir, 'tsconfig.json'),
					JSON.stringify({ compilerOptions: { strict: true, target: 'ES2023', module: 'NodeNext', noUnusedLocals: true } }),
				);
			}
			const spec = standaloneGates(relative(REPO_ROOT, dir)).find((g) => g.name === 'model')!;
			const ws = new LocalWorkspace({ root: REPO_ROOT });
			const result = await ws.exec(spec.cmd);
			const leftover = await ws.exists(relative(REPO_ROOT, join(dir, 'tsconfig.model-gate.json')));
			await ws.dispose();
			return { result, leftover };
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	};

	it('compiles under explicit defaults while the project has no tsconfig', async () => {
		expect((await compile(false)).result).toMatchObject({ exitCode: 0 });
	}, 60_000);

	it('applies the project tsconfig once it exists, and leaves nothing behind', async () => {
		const { result, leftover } = await compile(true);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout + result.stderr).toContain('TS6133');
		expect(leftover).toBe(false);
	}, 60_000);
});

describe('model-diff --root — the emitter the studio calls', () => {
	it('a direct gate recheck refuses a model that typechecks but throws on import', async () => {
		// Real compiler/emitter subprocesses need a few seconds of CI headroom.
		await mkdir(join(REPO_ROOT, '.builder'), { recursive: true });
		const dir = await fixtureProject(join(REPO_ROOT, '.builder'));
		try {
			const ws = new LocalWorkspace({ root: REPO_ROOT });
			const projectDir = relative(REPO_ROOT, dir);
			expect(await emitProjectModel(ws, projectDir)).toMatchObject({ status: 'emitted' });
			const previous = await readFile(join(dir, 'model.json'), 'utf8');
			const source = join(dir, 'spec/model.ts');
			await writeFile(source, await readFile(source, 'utf8') + '\nthrow new Error("runtime import failure");\n');
			const checks = standaloneGates(projectDir).filter((g) => g.name === 'model');
			const run = await runGates(ws, projectDir, checks);
			expect(run.ok).toBe(false);
			expect(run.results).toContainEqual(expect.objectContaining({ name: 'model', status: 'passed' }));
			expect(run.results).toContainEqual(expect.objectContaining({
				name: 'model-emit', status: 'failed', output: expect.stringContaining('runtime import failure'),
			}));
			expect(await readFile(join(dir, 'model.json'), 'utf8')).toBe(previous);
			await ws.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it('checks and emits a contracts model before the project has a package.json', async () => {
		// Under the repo like a builder project, but not a workspace member: the
		// old pnpm filter silently ran no compiler at all in this phase.
		// Real compiler and emitter subprocesses take a few seconds; allow CI headroom.
		await mkdir(join(REPO_ROOT, '.builder'), { recursive: true });
		const dir = await mkdtemp(join(REPO_ROOT, '.builder/model-phase-'));
		try {
			await mkdir(join(dir, 'spec'));
			const source = join(dir, 'spec/model.ts');
			const valid =
				'import { defineEntities, emitModel, z } from "@substrat-run/contracts";\n' +
				'export const model = emitModel(defineEntities({ item: { table: "acme_items", fields: z.object({ id: z.string() }) } }));\n';
			await writeFile(source, valid);
			const spec = standaloneGates(relative(REPO_ROOT, dir)).find((g) => g.name === 'model')!;
			const ws = new LocalWorkspace({ root: REPO_ROOT });
			expect(await ws.exec(spec.cmd)).toMatchObject({ exitCode: 0 });
			expect(await tool(['tools/model-diff.mts', '--root', dir])).toMatchObject({ code: 0 });
			expect(JSON.parse(await readFile(join(dir, 'model.json'), 'utf8')).entities.item.table).toBe('acme_items');
			await writeFile(source, valid + '\nconst bad: string = 42;\n');
			const invalid = await ws.exec(spec.cmd);
			expect(invalid.exitCode).not.toBe(0);
			expect(invalid.stdout + invalid.stderr).toContain('TS2322');
			await ws.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

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
		// The line the studio's gate tells drift from a crash by (src/model.ts).
		expect(drift.out).toMatch(/^model-diff: .+ is stale — re-run /m);
	}, 60_000);

	it('a project declaring no entity model is exit 2, never a green light', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'model-diff-bare-'));
		const r = await tool(['tools/model-diff.mts', '--root', dir, '--check']);
		expect(r.code).toBe(2);
		expect(r.out).toContain('declares no entity model');
	}, 60_000);

	it('a spec/model.ts that will not load is exit 2, not the exit 1 that means "regenerate"', async () => {
		// The distinction is the whole 0/1/2 contract: exit 1 tells a reader the
		// artifact is stale and to re-run the emitter, which cannot fix a module that
		// does not load. Unguarded, the rejected dynamic import reached the top level
		// and node exited 1 with a raw stack — and `--root` runs over a GENERATED
		// spec/model.ts, where a broken one is ordinary rather than exotic.
		const dir = join(await mkdtemp(join(tmpdir(), 'model-diff-broken-')), 'acme');
		await mkdir(join(dir, 'spec'), { recursive: true });
		await writeFile(join(dir, 'spec/model.ts'), 'throw new Error("boom");\n');

		const r = await tool(['tools/model-diff.mts', '--root', dir, '--check']);
		expect(r.code).toBe(2);
		expect(r.out).toContain('could not be imported');
		expect(r.out).toContain('boom');
	}, 60_000);

	it('--root without a directory is exit 2', async () => {
		const r = await tool(['tools/model-diff.mts', '--root', '--check']);
		expect(r.code).toBe(2);
		expect(r.out).toContain('--root needs a directory');
	}, 60_000);
});
