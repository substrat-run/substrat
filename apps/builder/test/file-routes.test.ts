/**
 * The file-READ routes are contained too (#1225).
 *
 * The write route was fixed and the two read routes beside it were not: both
 * `GET /api/files` and `GET /api/file` handed a caller-supplied path straight to
 * the REPO-rooted workspace, whose jail only refuses a path that leaves the
 * checkout. So `GET /api/file?path=.dev.vars` served the repo's secrets, and a
 * `..` climb served anything else on the way past — the file-inclusion half of the
 * report, at the second site it named.
 *
 * Three layers, because the failure that actually happened was a helper with full
 * unit coverage and one of two call sites using it:
 *   1. `underProject` itself, including the project directory the read rule must
 *      allow and the write rule must not;
 *   2. the composition the routes perform — containment check, then the
 *      PROJECT-rooted workspace — driven over a real temp tree, including the
 *      symlink only the second jail can judge;
 *   3. a source-shaped guard on all four route bodies, local and hosted, so the
 *      fix cannot drift back out of one entry point. (Neither server stands up in
 *      a unit test: one is a `node:http` handler over module-level state, the
 *      other a Durable Object needing a sandbox — the same reason
 *      `file-write-containment.test.ts` reads its routes off the source.)
 */
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContainerWorkspace, LocalWorkspace } from '@substrat-run/builder-workspace';
import { beforeAll, describe, expect, it } from 'vitest';
import { underProject, withinProject } from '../src/project-path.js';

const DIR = '.builder/projects/x';

describe('underProject', () => {
	it('returns the project-relative path for a file in the project', () => {
		expect(underProject(`${DIR}/spec/model.ts`, DIR)).toBe('spec/model.ts');
	});

	it('allows the project directory itself, which a read may name and a write may not', () => {
		// `GET /api/files` with no `path` defaults to exactly this.
		expect(underProject(DIR, DIR)).toBe('');
		expect(underProject(`${DIR}/`, DIR)).toBe('');
		expect(withinProject(DIR, DIR)).toBeNull();
	});

	it('refuses an absolute path', () => {
		expect(underProject('/etc/passwd', DIR)).toBeNull();
		expect(underProject(`/${DIR}/spec/model.ts`, DIR)).toBeNull();
	});

	it('refuses a `..` that climbs out after the project prefix', () => {
		expect(underProject(`${DIR}/../../../.dev.vars`, DIR)).toBeNull();
		expect(underProject(`${DIR}/spec/../../y/model.ts`, DIR)).toBeNull();
		expect(underProject('.dev.vars', DIR)).toBeNull();
	});

	it('refuses a sibling that only shares the prefix', () => {
		expect(underProject('.builder/projects/x-2/spec/model.ts', DIR)).toBeNull();
	});
});

describe('the read a route performs: containment, then the project-rooted workspace', () => {
	let repo: string;
	let projectWs: LocalWorkspace;

	/** What the routes do with a path, minus the HTTP. `null` is the 403. */
	const read = async (path: string): Promise<string | null> => {
		const rel = underProject(path, DIR);
		if (rel === null) return null;
		return await projectWs.readFile(rel);
	};

	beforeAll(async () => {
		repo = await mkdtemp(join(tmpdir(), 'builder-read-'));
		await mkdir(join(repo, DIR, 'spec'), { recursive: true });
		await writeFile(join(repo, '.dev.vars'), 'ANTHROPIC_API_KEY=sk-secret\n');
		await writeFile(join(repo, DIR, 'spec', 'model.ts'), 'export const model = {}\n');
		// A link inside the project pointing at a repo file OUTSIDE it: the
		// containment check cannot see it, so it is the workspace jail's to refuse.
		await symlink(join(repo, '.dev.vars'), join(repo, DIR, 'leak.txt'));
		projectWs = new LocalWorkspace({ root: join(repo, DIR) });
	});

	it('serves a file inside the project', async () => {
		await expect(read(`${DIR}/spec/model.ts`)).resolves.toBe('export const model = {}\n');
	});

	it('refuses the repo secret the old route served, by any spelling', async () => {
		expect(await read('.dev.vars')).toBeNull();
		expect(await read(`${DIR}/../../../.dev.vars`)).toBeNull();
		expect(await read(`${repo}/.dev.vars`)).toBeNull();
	});

	it('lists the project directory itself, and nothing above it', async () => {
		const rel = underProject(DIR, DIR);
		expect(rel).toBe('');
		expect(await projectWs.listFiles(rel as string)).toContain('spec/');
		expect(underProject('.builder/projects', DIR)).toBeNull();
	});

	it('refuses a symlink out of the project — the jail the second layer is for', async () => {
		// Passes containment (it names a file in the project) and still must not be
		// served: the project-rooted workspace resolves it and refuses.
		expect(underProject(`${DIR}/leak.txt`, DIR)).toBe('leak.txt');
		await expect(read(`${DIR}/leak.txt`)).rejects.toThrow(/escapes the workspace root/);
	});
});

describe('the hosted read: containment, then the container workspace', () => {
	// The hosted half composes the same check with `ContainerWorkspace`, whose own
	// guard is PURELY LEXICAL — the files are in a container, so it cannot realpath
	// the way `LocalWorkspace` does. The containment check is therefore the whole
	// of the symlink story there, which is worth pinning rather than assuming: the
	// sandbox here is the real filesystem behind the same structural interface the
	// agent bridges the SDK stub onto.
	let repo: string;
	let projectWs: ContainerWorkspace;

	const read = async (path: string): Promise<string | null> => {
		const rel = underProject(path, DIR);
		if (rel === null) return null;
		return await projectWs.readFile(rel);
	};

	beforeAll(async () => {
		repo = await mkdtemp(join(tmpdir(), 'builder-hosted-'));
		await mkdir(join(repo, DIR, 'spec'), { recursive: true });
		await writeFile(join(repo, '.dev.vars'), 'ANTHROPIC_API_KEY=sk-secret\n');
		await writeFile(join(repo, DIR, 'spec', 'model.ts'), 'export const model = {}\n');
		projectWs = new ContainerWorkspace({
			root: `${repo}/${DIR}`,
			sandbox: {
				exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
				readFile: async (p: string) => await readFile(p, 'utf8'),
				writeFile: async (p: string, c: string) => await writeFile(p, c),
				mkdir: async (p: string) => await mkdir(p, { recursive: true }),
				listFiles: async (p: string) => (await readdir(p)).sort(),
				exposePort: async () => ({ url: '' }),
			},
		});
	});

	it('serves a file inside the project', async () => {
		await expect(read(`${DIR}/spec/model.ts`)).resolves.toBe('export const model = {}\n');
	});

	it('refuses the repo secret the old hosted route served', async () => {
		expect(await read('.dev.vars')).toBeNull();
		expect(await read(`${DIR}/../../../.dev.vars`)).toBeNull();
		expect(await read(`${repo}/.dev.vars`)).toBeNull();
	});

	it('lists the project directory itself', async () => {
		expect(await projectWs.listFiles('')).toContain('spec');
	});

	it('refuses a climb the check let through, at the workspace too', async () => {
		// Belt and braces: even handed a relative `..` directly, the container guard
		// refuses rather than resolving out of the project root.
		await expect(projectWs.readFile('../../../.dev.vars')).rejects.toThrow(
			/escapes the workspace root/,
		);
	});
});

describe('both read routes apply the containment, in both entry points', () => {
	const src = (name: string): string =>
		readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');

	/** The body of one route, from its marker to the next one. */
	const body = (text: string, from: string, to: string): string => {
		const start = text.indexOf(from);
		expect(start).toBeGreaterThan(-1);
		const rest = text.slice(start);
		const end = rest.indexOf(to, from.length);
		return end === -1 ? rest : rest.slice(0, end);
	};

	const ROUTES = [
		{
			what: 'the local studio server lists files',
			text: () => body(src('server.ts'), 'async function handleFiles(', 'async function '),
		},
		{
			what: 'the local studio server reads a file',
			text: () => body(src('server.ts'), 'async function handleFileRead(', 'async function '),
		},
		{
			what: 'the hosted BuilderAgent lists files',
			text: () => body(src('agent.ts'), "case 'GET /api/files'", "case '"),
		},
		{
			what: 'the hosted BuilderAgent reads a file',
			text: () => body(src('agent.ts'), "case 'GET /api/file'", "case '"),
		},
	];

	for (const { what, text: route } of ROUTES) {
		it(`${what} through underProject`, () => {
			expect(route()).toMatch(/underProject\(/);
		});

		it(`${what} through the project-rooted workspace, not the repo root`, () => {
			const text = route();
			expect(text).toMatch(/projectWs/);
			// `\bws\.` cannot match inside `projectWs.` — the boundary is the point.
			expect(text).not.toMatch(/\bws\.(readFile|listFiles)\(/);
			expect(text).not.toMatch(/rootWs/);
		});
	}

	it('the rule comes from the one module that owns it, in both files', () => {
		for (const file of ['server.ts', 'agent.ts']) {
			expect(src(file)).toMatch(/from '\.\/project-path\.js'/);
		}
	});
});
