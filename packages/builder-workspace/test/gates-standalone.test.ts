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
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkModel, runGate, runGates, standaloneGates, type GateName, type GateSpec } from '../src/gates.js';
import { LocalWorkspace } from '../src/local.js';
import type { ExecOptions, ExecResult, Workspace } from '../src/workspace.js';

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
		// Exactly the bare tool call: ContainerWorkspace re-points a command at the
		// toolchain only when it STARTS with `pnpm exec tsx tools/…`, so any prefix
		// would run it from the project, where tools/ does not exist.
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
	it('skips permissions with a note until src/module.ts exists', async () => {
		const w = await fixtureWorkspace();
		await w.mkdir(PROJECT, { recursive: true });
		await w.writeFile(`${PROJECT}/package.json`, JSON.stringify({ name: 'acme' }));

		const r = await runGate(w, gate('permissions'), PROJECT);
		expect(r.status).toBe('skipped');
		expect(r.note).toMatch(/no src\/module.ts yet/);
		// The point of a skip: the tool was NOT run, so nothing can report green.
		expect(w.ran).toEqual([]);
		await w.dispose();
	});

	it('refuses a project with a module and no substrat.permissions, saying what to add', async () => {
		const w = await fixtureWorkspace();
		await w.mkdir(`${PROJECT}/src`, { recursive: true });
		await w.writeFile(`${PROJECT}/package.json`, JSON.stringify({ name: 'acme' }));
		await w.writeFile(`${PROJECT}/src/module.ts`, 'export {};\n');

		const r = await runGate(w, gate('permissions'), PROJECT);
		expect(r.status).toBe('failed');
		expect(r.output).toContain('"permissions": "src/provision.ts"');
		expect(r.output).toContain('permissions = definePermissions({ modules: MODULES, roles: ROLES');
		// Refused before the tool: nothing ran that could report green.
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

	it('builds app/ once it has a package.json, by directory so a missing member cannot pass', async () => {
		const w = await fixtureWorkspace();
		expect((await runGate(w, gate('app-build'), PROJECT)).status).toBe('skipped');
		await w.mkdir(`${PROJECT}/app`, { recursive: true });
		await w.writeFile(`${PROJECT}/app/package.json`, '{}');
		expect(gate('app-build').cmd).toBe(`pnpm --dir ${PROJECT}/app build`);
		expect((await runGate(w, gate('app-build'), PROJECT)).status).toBe('passed');
		await w.dispose();
	});

	it.each([
		['app-components', 'app/src/screens.ts', 'html`<wa-dialog></wa-dialog>`', 'html`<wa-button></wa-button>`', '<wa-dialog>'],
		['app-ports', 'src/server.ts', 'process.env.PORT ?? 8878', 'process.env.PORT ?? 8891', 'cannot reach'],
		['app-starter', 'app/src/screens.ts', "invoke('acme/add-item')", "invoke('lists/add-item')", 'still the starter'],
		['sign-in', 'src/server.ts', "c.req.header('x-principal')", 'devLogin({})', 'x-principal'],
		['dev-scripts', 'package.json', '{"scripts":{"issuer":"substrat-dev-issuer --personas src/personas.ts"}}', '{"scripts":{"dev":"tsx watch src/server.ts"}}', 'src/personas.ts (the "issuer" script)'],
		['sends-email', 'package.json', '{}', '{"substrat":{"sendsEmail":true}}', 'sendsEmail'],
		['sends-email', 'package.json', '{ not json', '{"substrat":{"sendsEmail":true}}', 'sendsEmail'],
		['invite-email', 'src/module.ts', "'todo/invite': async (ctx) => {}", 'requestEmail(ctx, message);', 'reaches nobody'],
		['app-events', 'app/src/screens.ts', 'html`<sub-entity-table .rows=${r} @row-click=${(e) => open(e)}></sub-entity-table>`', 'html`<sub-entity-table row-click @sub-row-click=${(e) => open(e)}></sub-entity-table>`', 'sub-row-click'],
		['app-events', 'app/src/screens.ts', 'html`<sub-entity-table @sub-row-click=${(e) => open(e)}></sub-entity-table>`', 'html`<sub-entity-table row-click @sub-row-click=${(e) => open(e)}></sub-entity-table>`', 'without the row-click'],
		['hosted-assets', 'package.json', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts"}}}', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts","assets":{"directory":"app/dist"}}}}', 'would not serve'],
		['hosted-assets', 'package.json', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts","assets":"app/dist"}}}', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts","assets":{"directory":"app/dist"}}}}', 'not what push reads'],
		['hosted-entry', 'package.json', '{"substrat":{"runtimeNeeds":{"entry":"src/gone.ts"}}}', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts"}},"devDependencies":{"wrangler":"^4"}}', 'src/gone.ts'],
		['hosted-entry', 'package.json', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts"}}}', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts"}},"devDependencies":{"wrangler":"^4"}}', 'no wrangler'],
		['hosted-entry', 'package.json', '{"devDependencies":{"wrangler":"^4"}}', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts"}},"devDependencies":{"wrangler":"^4"}}', 'nothing to build'],
		['hosted-entry', 'package.json', '{"substrat":{"runtimeNeeds":{"entry":""}},"devDependencies":{"wrangler":"^4"}}', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts"}},"devDependencies":{"wrangler":"^4"}}', 'names no entry'],
		['hosted-entry', 'package.json', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts","build":{"command":"pnpm --dir app build"}}},"devDependencies":{"wrangler":"^4"}}', '{"substrat":{"runtimeNeeds":{"entry":"src/server.ts","build":"pnpm --dir app build"}},"devDependencies":{"wrangler":"^4"}}', 'runtimeNeeds.build: '],
		['dev-join', 'src/server.ts', 'devLogin({}); process.env.PORT ?? 8891', "devLogin({}); process.env.PORT ?? 8891; await stub.invoke('todo/join', { displayName })", 'never runs it'],
		['migrations-registered', 'src/module.ts', 'export const appModule = { migrations: [] };', "import { migrations } from './migrations.generated.js'; export const appModule = { migrations };", 'Nothing in src/ registers'],
		['hosted-join', 'src/worker.ts', 'workerDoor({ hostFor }) // join: todo/join', "workerDoor({ join: (s, w) => s.invoke('todo/join', { displayName: w.display }) })", 'todo/join'],
	] as const)('%s refuses what passed every other gate', async (name, file, bad, good, says) => {
		const w = await fixtureWorkspace();
		await w.writeFile(`${PROJECT}/app/package.json`, '{}');
		await w.writeFile(`${PROJECT}/app/index.html`, '<div id="app"></div>');
		await w.writeFile(`${PROJECT}/src/migrations.generated.ts`, 'export const migrations = [];');
		await w.writeFile(`${PROJECT}/app/vite.config.ts`, 'process.env.PORT ?? 8891');
		await w.writeFile(`${PROJECT}/src/server.ts`, 'devLogin({}); process.env.PORT ?? 8891');
		await w.writeFile(`${PROJECT}/src/module.ts`, 'requestEmail(ctx, message);');
		await w.writeFile(`${PROJECT}/spec/model.ts`, "defineOperations({ 'todo/join': { input } })");
		await w.writeFile(`${PROJECT}/spec/concept.md`, 'People are invited to a list by email.');
		await w.writeFile(`${PROJECT}/app/node_modules/@substrat-run/elements/dist/controls.js`, "import 'x/components/button/button.js';");

		await w.writeFile(`${PROJECT}/${file}`, bad);
		const refused = await runGate(w, gate(name), PROJECT);
		expect(refused.status).toBe('failed');
		expect(refused.output).toContain(says);

		await w.writeFile(`${PROJECT}/${file}`, good);
		expect((await runGate(w, gate(name), PROJECT)).status).toBe('passed');
		await w.dispose();
	});

	it('app-writes refuses a write no screen offers, and passes once the app, the host or an api-only mark names it', async () => {
		const w = await fixtureWorkspace();
		await w.writeFile(`${PROJECT}/app/package.json`, '{}');
		await w.writeFile(
			`${PROJECT}/spec/model.ts`,
			"defineOperations({\n  'todo/join': { emits: {} },\n  'todo/delete-list': { emits: {} },\n  'todo/my-lists': { derive: 'list' },\n})",
		);
		await w.writeFile(`${PROJECT}/src/server.ts`, "await stub.invoke('todo/join', { displayName });");
		await w.writeFile(`${PROJECT}/app/src/screens.ts`, 'html``');
		const refused = await runGate(w, gate('app-writes'), PROJECT);
		expect(refused.status).toBe('failed');
		expect(refused.output).toContain('can never do them: todo/delete-list.');

		for (const offered of [
			"invoke(`${NS}/delete-list`, { id: row.id })",
			'// api-only: todo/delete-list — a nightly script clears old lists',
		]) {
			await w.writeFile(`${PROJECT}/app/src/screens.ts`, offered);
			expect((await runGate(w, gate('app-writes'), PROJECT)).status).toBe('passed');
		}
		await w.dispose();
	});

	it('passes hosted-entry on a hand-authored wrangler.jsonc, which substrat push falls back to', async () => {
		const w = await fixtureWorkspace();
		await w.writeFile(`${PROJECT}/package.json`, '{"devDependencies":{"wrangler":"^4"}}');
		await w.writeFile(`${PROJECT}/wrangler.jsonc`, '{ "main": "src/worker.ts" }');
		expect((await runGate(w, gate('hosted-entry'), PROJECT)).status).toBe('passed');
		await w.dispose();
	});

	it('fails a gate whose check cannot finish, and keeps the result of every other gate', async () => {
		const root = await mkdtemp(join(tmpdir(), 'builder-unreadable-'));
		const w = new LocalWorkspace({ root });
		const project = '.builder/projects/todo';
		await w.writeFile(`${project}/package.json`, '{"substrat":{"sendsEmail":true}}');
		await w.writeFile(`${project}/src/server.ts`, 'devLogin({});');
		await symlink(join(root, 'nowhere.ts'), join(root, project, 'src/broken.ts'));
		const gates = standaloneGates(project).filter((g) => g.name === 'sign-in' || g.name === 'sends-email');

		const run = await runGates(w, project, gates);

		expect(run.results.map((r) => [r.name, r.status])).toEqual([['sign-in', 'failed'], ['sends-email', 'failed']]);
		expect(run.results[0]!.output).toContain('could not finish');
		await w.dispose();
	});

	it('refuses an app that calls /api/invoke until the server really mounts it', async () => {
		// A real shell: the gate is its command, which the scripted workspace would answer for it.
		const w = new LocalWorkspace({ root: await mkdtemp(join(tmpdir(), 'builder-app-api-')) });
		// A space in the path: split, the first grep fails and `!` would pass the gate.
		const project = '.builder/projects/my project';
		const appApi = standaloneGates(project).find((g) => g.name === 'app-api')!;
		await w.writeFile(`${project}/app/package.json`, '{}');
		await w.writeFile(`${project}/app/src/api.ts`, "fetch('/api/invoke');");
		for (const server of ['export {};', "// the app calls /api/invoke, see routes", "// app.post('/api/invoke', handler);"]) {
			await w.writeFile(`${project}/src/routes.ts`, server);
			const refused = await runGate(w, appApi, project);
			expect(refused.status).toBe('failed');
			expect(refused.output).toContain('src/routes.ts');
		}

		await w.writeFile(`${project}/src/routes.ts`, "  app.post('/api/invoke', handler);");
		expect((await runGate(w, appApi, project)).status).toBe('passed');
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

describe('checkModel — a checker that cannot run is not a declaration error', () => {
	it('answers CANNOT CHECK, not NOT OK, when only the loader is missing', async () => {
		// A compile that passes and a toolchain without the emitter: calling again
		// changes nothing, so the verdict must not read as "fix it and retry".
		const ws = {
			exists: async () => true,
			hasTool: async () => false,
			exec: async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
		} as unknown as Workspace;
		expect(await checkModel(ws, 'proj')).toMatch(/^CANNOT CHECK — .*\(unavailable\)/);
	});
});

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

		// The same directory, named with a `.` hop and a trailing slash — a genuinely
		// different ARGUMENT (`join` would normalise it away, so it is built by hand).
		// A header keyed off the raw argument would report drift here although no
		// permission changed.
		const again = await tool(['tools/permission-diff.mts', '--root', `${dir}/./`, '--check']);
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

		// `null` parses fine and is not a package object. Reading `.substrat` off it
		// throws a TypeError, which exits 1 — "the artifact is out of date", the same
		// lie in a different costume.
		await writeFile(join(dir, 'package.json'), 'null');
		const nul = await tool(['tools/permission-diff.mts', '--root', dir, '--check']);
		expect(nul.code).toBe(2);
		expect(nul.out).toContain('not an object');

		// Declared but not a path: `join(dir, {})` throws, which would exit 1 the same way.
		await writeFile(
			join(dir, 'package.json'),
			JSON.stringify({ name: 'broken', substrat: { permissions: {} } }),
		);
		const shape = await tool(['tools/permission-diff.mts', '--root', dir, '--check']);
		expect(shape.code).toBe(2);
		expect(shape.out).toContain('not a path');
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

/**
 * #1705: both ends of a cross-vertical edge, as two modules of one project declare them.
 * `exports` is the flow out, `consumes` with `from` the flow in.
 */
/** A model.json carrying the given exported types' payload schemas (#1705 PR 3, D-22). */
function modelWithExports(types: { type: string; schemaVersion: number }[]): string {
	const exports = Object.fromEntries(
		types.map((t) => [t.type, { schemaVersion: t.schemaVersion, readPermission: 'acme:read', payload: { type: 'object', properties: {} } }]),
	);
	return JSON.stringify({ entities: {}, exports }, null, 2);
}

async function edgeProject(exportKey = 'acme:read', model: string | null = modelWithExports([{ type: 'acme.thing-made', schemaVersion: 2 }])): Promise<string> {
	const dir = join(await mkdtemp(join(tmpdir(), 'permission-diff-edge-')), 'acme');
	await mkdir(join(dir, 'src'), { recursive: true });
	await writeFile(
		join(dir, 'package.json'),
		JSON.stringify({ name: 'acme-vertical', substrat: { permissions: 'src/provision.mjs' } }),
	);
	await writeFile(
		join(dir, 'src/provision.mjs'),
		'export const permissions = {\n' +
			'  modules: [{ manifest: { id: "acme", permissions: [{ key: "acme:read", description: "Read" }],\n' +
			'    events: {\n' +
			'      consumes: [{ from: "acme/crm", type: "crm.customer-created", schemaVersion: 1 }, { type: "acme.local", schemaVersion: 1 }],\n' +
			`      exports: [{ type: "acme.thing-made", schemaVersion: 2, readPermission: "${exportKey}" }],\n` +
			'    } } }],\n' +
			'  roles: [{ key: "staff", permissions: ["acme:read"], source: "acme" }],\n' +
			'};\n',
	);
	if (model !== null) await writeFile(join(dir, 'model.json'), model);
	return dir;
}

describe('permission-diff — the cross-vertical edge (#1705)', () => {
	it('shows what leaves and what enters, and an edge change is drift a reviewer reads', async () => {
		const dir = await edgeProject();
		expect((await tool(['tools/permission-diff.mts', '--root', dir])).code).toBe(0);
		const artifact = join(dir, 'PERMISSIONS.md');
		const rendered = await readFile(artifact, 'utf8');
		expect(rendered).toContain('Exported events — what leaves this vertical');
		expect(rendered).toContain('| `acme.thing-made` | 2 | `acme:read` | `acme` |');
		expect(rendered).toContain('Imported events — what this vertical receives from others');
		expect(rendered).toContain('| `acme/crm` | `crm.customer-created` | 1 | `acme` |');
		// A LOCAL consume is not an edge, and must not be rendered as one.
		expect(rendered).not.toContain('acme.local');

		// Widen what leaves: the committed artifact no longer matches, so the change cannot
		// merge without the new row appearing in the PR diff.
		const src = join(dir, 'src/provision.mjs');
		const code = await readFile(src, 'utf8');
		await writeFile(src, code.replace('exports: [', 'exports: [{ type: "acme.secret-kept", schemaVersion: 1, readPermission: "acme:read" }, '));
		await writeFile(
			join(dir, 'model.json'),
			modelWithExports([
				{ type: 'acme.thing-made', schemaVersion: 2 },
				{ type: 'acme.secret-kept', schemaVersion: 1 },
			]),
		);
		const drift = await tool(['tools/permission-diff.mts', '--root', dir, '--check']);
		expect(drift.code).toBe(1);
	}, 60_000);

	it('an export whose payload schema the model does not carry is exit 2: D-22 would have nothing to judge (#1705 PR 3)', async () => {
		// No model.json at all.
		const bare = await edgeProject('acme:read', null);
		const r = await tool(['tools/permission-diff.mts', '--root', bare]);
		expect(r.code).toBe(2);
		expect(r.out).toContain('whose payload schema its model.json does not carry');
		expect(r.out).toContain('acme.thing-made v2');
		// A model that carries the type at another version is no better.
		const stale = await edgeProject('acme:read', modelWithExports([{ type: 'acme.thing-made', schemaVersion: 1 }]));
		expect((await tool(['tools/permission-diff.mts', '--root', stale])).code).toBe(2);
		// The twin: carried at the exported version, it renders.
		const carried = await edgeProject();
		expect((await tool(['tools/permission-diff.mts', '--root', carried])).code).toBe(0);
	}, 60_000);

	it('an export gated on a key nobody declares is exit 2: that edge could never be granted', async () => {
		const dir = await edgeProject('acme:nowhere');
		const r = await tool(['tools/permission-diff.mts', '--root', dir, '--check']);
		expect(r.code).toBe(2);
		expect(r.out).toContain('export `acme.thing-made` → `acme:nowhere`');
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
