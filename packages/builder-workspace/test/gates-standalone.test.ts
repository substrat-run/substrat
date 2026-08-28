/**
 * The standalone permission + api gates (#628).
 *
 * Both were DECLARED and skipped — `appliesWhen: async () => false` with a
 * "standalone form not built yet" note — because `permission-diff` and `api-diff`
 * swept `demos/` + `apps/` and a studio-generated vertical lives under
 * `.builder/projects/*`, which neither sweep sees. A skipped gate is a visible
 * gap, which is better than an invisible one, but it is still no checkpoint: a
 * generated vertical could widen a role and reach a push with nobody reading a
 * permission diff.
 *
 * Two halves are tested here, because a green gate that runs the wrong command is
 * exactly the failure a stub was honest about:
 *
 *   1. The SPEC — the gate declares a real `--root` command, applies only when the
 *      project has opted in, and speaks the 0/1/2 convention (so a tool that could
 *      not do its job reports `blocked`, not `failed`).
 *   2. The TOOL — `permission-diff --root <dir>` and `api-diff --root <dir>`
 *      actually render, actually detect drift, and actually exit 0/1/2, over a
 *      fixture project that is not a member of this workspace.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runGate, standaloneGates, type GateName, type GateSpec } from '../src/gates.js';
import { LocalWorkspace } from '../src/local.js';
import type { ExecOptions, ExecResult } from '../src/workspace.js';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const PROJECT = '.builder/projects/acme';

const gate = (name: GateName): GateSpec => {
	const spec = standaloneGates(PROJECT).find((g) => g.name === name);
	if (!spec) throw new Error(`no standalone gate named ${name}`);
	return spec;
};

// ---------------------------------------------------------------------------
// 1. The gate spec
// ---------------------------------------------------------------------------

describe('standaloneGates — permissions and api are real gates, not stubs', () => {
	it('runs the per-project form of each tool', () => {
		expect(gate('permissions').cmd).toBe(
			`pnpm exec tsx tools/permission-diff.mts --root ${PROJECT} --check`,
		);
		expect(gate('api').cmd).toBe(`pnpm exec tsx tools/api-diff.mts --root ${PROJECT} --check`);
	});

	it('speaks the substrat 0/1/2 convention, so exit 2 is blocked rather than failed', () => {
		expect(gate('permissions').exitConvention).toBe('substrat');
		expect(gate('api').exitConvention).toBe('substrat');
	});
});

/** LocalWorkspace whose exec is scripted — the gate cmd must never really run here. */
class ScriptedWorkspace extends LocalWorkspace {
	ran: string[] = [];
	exit = 0;
	override async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
		if (cmd.startsWith('git ')) return super.exec(cmd, opts);
		this.ran.push(cmd);
		return { stdout: '', stderr: '', exitCode: this.exit };
	}
}

async function fixtureWorkspace(): Promise<ScriptedWorkspace> {
	const root = await mkdtemp(join(tmpdir(), 'builder-standalone-'));
	return new ScriptedWorkspace({ root });
}

describe('standaloneGates — when each gate applies', () => {
	it('skips permissions with a note until the project declares substrat.permissions', async () => {
		const w = await fixtureWorkspace();
		await w.mkdir(PROJECT, { recursive: true });
		await w.writeFile(`${PROJECT}/package.json`, JSON.stringify({ name: 'acme' }));

		const r = await runGate(w, gate('permissions'), PROJECT);
		expect(r.status).toBe('skipped');
		expect(r.note).toMatch(/no substrat.permissions entry/);
		// The point of a skip: the tool was NOT run, so nothing can report green.
		expect(w.ran).toEqual([]);
		await w.dispose();
	});

	it('runs permissions once the entry is declared', async () => {
		const w = await fixtureWorkspace();
		await w.mkdir(PROJECT, { recursive: true });
		await w.writeFile(
			`${PROJECT}/package.json`,
			JSON.stringify({ name: 'acme', substrat: { permissions: 'src/provision.ts' } }),
		);

		expect((await runGate(w, gate('permissions'), PROJECT)).status).toBe('passed');
		expect(w.ran).toEqual([gate('permissions').cmd]);
		await w.dispose();
	});

	it('a missing or malformed package.json skips rather than blocks — install owns that failure', async () => {
		const w = await fixtureWorkspace();
		expect((await runGate(w, gate('permissions'), PROJECT)).status).toBe('skipped');

		await w.mkdir(PROJECT, { recursive: true });
		await w.writeFile(`${PROJECT}/package.json`, '{ not json');
		expect((await runGate(w, gate('permissions'), PROJECT)).status).toBe('skipped');
		expect(w.ran).toEqual([]);
		await w.dispose();
	});

	it('api stays opt-in on src/api.ts, as it is in the monorepo gates', async () => {
		const w = await fixtureWorkspace();
		await w.mkdir(`${PROJECT}/src`, { recursive: true });

		const skipped = await runGate(w, gate('api'), PROJECT);
		expect(skipped.status).toBe('skipped');
		expect(skipped.note).toMatch(/no src\/api\.ts/);

		await w.writeFile(`${PROJECT}/src/api.ts`, 'export const API_DOCUMENT = {};');
		expect((await runGate(w, gate('api'), PROJECT)).status).toBe('passed');
		await w.dispose();
	});
});

// ---------------------------------------------------------------------------
// 2. The tool, over a project outside this workspace
// ---------------------------------------------------------------------------

const run = promisify(execFile);

/** Runs a tool from the repo root and answers its exit code and output. */
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
 * A project shaped like a studio-generated vertical: its own package.json naming
 * a `substrat.permissions` entry, and a plain-data surface. Nothing here imports
 * the kernel, because the tool reads four structural fields and never boots a
 * host — which is also why the artifact is a pure function of code.
 */
async function fixtureProject(): Promise<string> {
	const dir = join(await mkdtemp(join(tmpdir(), 'permission-diff-root-')), 'acme');
	await mkdir(join(dir, 'src'), { recursive: true });
	await writeFile(
		join(dir, 'package.json'),
		JSON.stringify({ name: 'acme-vertical', substrat: { permissions: 'src/provision.mjs' } }),
	);
	await writeFile(
		join(dir, 'src/provision.mjs'),
		'export const permissions = {\n' +
			'  modules: [{ manifest: { id: "acme", permissions: [{ key: "acme:read", description: "Read" }] } }],\n' +
			'  roles: [{ key: "staff", permissions: ["acme:read"], source: "acme" }],\n' +
			'};\n',
	);
	return dir;
}

describe('permission-diff --root — the standalone permission checkpoint', () => {
	it('renders, then agrees with itself, then reports drift', async () => {
		const dir = await fixtureProject();

		expect((await tool(['tools/permission-diff.mts', '--root', dir])).code).toBe(0);
		const artifact = join(dir, 'PERMISSIONS.md');
		const rendered = await readFile(artifact, 'utf8');
		expect(rendered).toContain('# Permission snapshot — acme-vertical');
		expect(rendered).toContain('`acme:read`');
		// Its header names a command that actually regenerates THIS file — the sweep
		// (`pnpm lint:permissions`) never reaches a project outside demos/ and apps/.
		expect(rendered).toContain('Regenerate: pnpm exec tsx tools/permission-diff.mts --root');

		expect((await tool(['tools/permission-diff.mts', '--root', dir, '--check'])).code).toBe(0);

		await writeFile(artifact, rendered.replace('Read', 'Read everything'));
		const drift = await tool(['tools/permission-diff.mts', '--root', dir, '--check']);
		expect(drift.code).toBe(1);
		expect(drift.out).toContain('out of date');
	}, 60_000);

	it('the header does not depend on how the path was spelled', async () => {
		const dir = await fixtureProject();
		expect((await tool(['tools/permission-diff.mts', '--root', dir])).code).toBe(0);
		const first = await readFile(join(dir, 'PERMISSIONS.md'), 'utf8');

		// The same directory, named with a trailing slash and a `.` hop. A header keyed
		// off the raw argument would report drift here although no permission changed.
		const spelled = join(dir, '.', '');
		const again = await tool(['tools/permission-diff.mts', '--root', spelled, '--check']);
		expect(again.code).toBe(0);
		expect(await readFile(join(dir, 'PERMISSIONS.md'), 'utf8')).toBe(first);
	}, 60_000);

	it('an unparseable package.json is exit 2, not the exit-1 that means "regenerate"', async () => {
		const dir = join(await mkdtemp(join(tmpdir(), 'permission-diff-bad-json-')), 'broken');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'package.json'), '{ "name": "broken",,, }');

		const r = await tool(['tools/permission-diff.mts', '--root', dir, '--check']);
		expect(r.code).toBe(2);
		expect(r.out).toContain('is not valid JSON');
	}, 60_000);

	it('a project declaring no permission surface is exit 2, never a green light', async () => {
		const dir = join(await mkdtemp(join(tmpdir(), 'permission-diff-bare-')), 'bare');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'bare' }));

		const r = await tool(['tools/permission-diff.mts', '--root', dir, '--check']);
		expect(r.code).toBe(2);
		expect(r.out).toContain('declares no `substrat.permissions`');
	}, 60_000);

	it('--root without a directory is exit 2', async () => {
		const r = await tool(['tools/permission-diff.mts', '--root', '--check']);
		expect(r.code).toBe(2);
		expect(r.out).toContain('--root needs a directory');
	}, 60_000);
});

describe('api-diff --root — the standalone API checkpoint', () => {
	it('renders openapi.json for one project, then reports drift', async () => {
		const dir = join(await mkdtemp(join(tmpdir(), 'api-diff-root-')), 'acme');
		await mkdir(join(dir, 'src'), { recursive: true });
		await writeFile(
			join(dir, 'src/api.ts'),
			'export const API_DOCUMENT = {\n' +
				'  openapi: "3.1.0",\n' +
				'  info: { title: "acme", version: "0.0.0" },\n' +
				'  paths: { "/things": { get: { responses: { "200": { description: "ok" } } } } },\n' +
				'};\n',
		);

		expect((await tool(['tools/api-diff.mts', '--root', dir])).code).toBe(0);
		const artifact = join(dir, 'openapi.json');
		expect(JSON.parse(await readFile(artifact, 'utf8')).paths).toHaveProperty('/things');

		expect((await tool(['tools/api-diff.mts', '--root', dir, '--check'])).code).toBe(0);

		await writeFile(artifact, '{}\n');
		const drift = await tool(['tools/api-diff.mts', '--root', dir, '--check']);
		expect(drift.code).toBe(1);
		expect(drift.out).toContain('API surface drift');
	}, 60_000);

	it('a project with no src/api.ts is exit 2 — the gate should have skipped it', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'api-diff-bare-'));
		const r = await tool(['tools/api-diff.mts', '--root', dir, '--check']);
		expect(r.code).toBe(2);
		expect(r.out).toContain('has no src/api.ts');
	}, 60_000);
});
