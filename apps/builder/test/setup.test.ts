/**
 * The project a build starts from (setup.ts), laid down by the host. A hosted build and an eval
 * have to start from the same files, or the scaffold skill says something false on one of them:
 * told to copy them when they were laid, a build copied every file again. The agent is a Durable
 * Object over a sandbox, so its wiring is pinned off the source, as build-queue.test.ts does.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '@substrat-run/builder-workspace/edge';
import { layProject } from '../src/setup.js';

/** A workspace in memory: `listFiles` answers one level, with a trailing `/` on a directory. */
function memory(files: Record<string, string>) {
	const store = new Map(Object.entries(files));
	const ran: string[] = [];
	const ws = {
		exists: async (path: string) => store.has(path),
		readFile: async (path: string) => {
			const text = store.get(path);
			if (text === undefined) throw new Error(`no ${path}`);
			return text;
		},
		writeFile: async (path: string, text: string) => {
			store.set(path, text);
		},
		listFiles: async (dir: string) => {
			const prefix = dir === '.' ? '' : `${dir}/`;
			const names = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
			return [...new Set(names.map((n) => (n.includes('/') ? `${n.split('/')[0]}/` : n)))];
		},
		exec: async (command: string) => {
			ran.push(command);
			return { exitCode: 0, stdout: '', stderr: '' };
		},
	};
	return { ws: ws as unknown as Workspace, store, ran };
}

const template = () =>
	memory({
		'package.json': '{ "name": "template" }',
		'tsconfig.json': '{}',
		'tsconfig.worker.json': '{}',
		'vitest.config.ts': 'export default {};',
		'test/setup.ts': '',
		'src/worker.ts': "import { MODULES } from './provision.js';",
		'pnpm-workspace.yaml': 'allowBuilds:\n  esbuild: false\n',
	}).ws;
const portal = () => memory({ 'package.json': '{}', 'src/screens.ts': 'screens' }).ws;

describe('layProject', () => {
	it('lays the deployed worker beside the project files and the app shell, and installs once', async () => {
		const project = memory({});
		expect(await layProject(project.ws, { template: template(), portal: portal() })).toBe(true);
		expect([...project.store.keys()].sort()).toEqual([
			'app/package.json',
			'app/src/screens.ts',
			'package.json',
			'pnpm-workspace.yaml',
			'src/worker.ts',
			'test/setup.ts',
			'tsconfig.json',
			'tsconfig.worker.json',
			'vitest.config.ts',
		]);
		expect(project.ran).toEqual(['pnpm install --no-frozen-lockfile']);
	});

	it('leaves a project that already has a package.json alone', async () => {
		const project = memory({ 'package.json': '{ "name": "mine" }' });
		expect(await layProject(project.ws, { template: template(), portal: portal() })).toBe(false);
		expect([...project.store.keys()]).toEqual(['package.json']);
		expect(project.ran).toEqual([]);
	});

	it('is laid on the hosted path too, before a scaffold pass, for a fresh studio project', () => {
		const agent = readFileSync(fileURLToPath(new URL('../src/agent.ts', import.meta.url)), 'utf8');
		expect(agent).toMatch(/if \(phase === 'scaffold' && entry\.directory === '\.'\) \{[\s\S]{0,400}?await layProject\(projectWs, references\)/);
	});
});
