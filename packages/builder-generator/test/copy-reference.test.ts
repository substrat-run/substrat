/** `copy_reference`: a reference's files land in the project in one call, through the write guard. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { workspaceTools } from '../src/index.js';

const scratch = async (): Promise<LocalWorkspace> =>
	new LocalWorkspace({ root: await mkdtemp(join(tmpdir(), 'builder-copy-')) });

async function fixture() {
	const portal = await scratch();
	await portal.mkdir('src/parts', { recursive: true });
	await portal.mkdir('node_modules/lit', { recursive: true });
	await portal.mkdir('dist', { recursive: true });
	await portal.writeFile('package.json', '{"dependencies":{"a":"workspace:*","b":"catalog:","c":"^1.0.0"}}');
	await portal.writeFile('src/main.ts', 'main');
	await portal.writeFile('src/parts/one.ts', 'one');
	await portal.writeFile('node_modules/lit/index.js', 'no');
	await portal.writeFile('dist/index.js', 'no');
	return { portal, project: await scratch() };
}

const copy = async (tools: ReturnType<typeof workspaceTools>, from: string, to: string): Promise<string> =>
	(await (tools as unknown as Record<string, { execute(i: unknown, o: unknown): Promise<string> }>).copy_reference!.execute(
		{ reference: 'portal', from, to },
		{ toolCallId: 't', messages: [] },
	));

describe('copy_reference', () => {
	it('copies a directory, leaves build output out, and makes its package.json installable here', async () => {
		const { portal, project } = await fixture();
		const tools = workspaceTools({ workspace: project, emit: () => {}, references: { portal } });

		expect(await copy(tools, '.', 'app')).toContain('copied 3 file(s)');
		expect(await project.readFile('app/src/parts/one.ts')).toBe('one');
		expect(await project.readFile('app/package.json')).toBe('{"dependencies":{"a":"latest","b":"latest","c":"^1.0.0"}}');
		expect(await project.exists('app/node_modules')).toBe(false);
		expect(await project.exists('app/dist')).toBe(false);
	});

	it('copies one file, and a guarded target is refused file by file', async () => {
		const { portal, project } = await fixture();
		const tools = workspaceTools({
			workspace: project,
			emit: () => {},
			references: { portal },
			denyWrite: (path) => (path.startsWith('spec/') ? 'the model is frozen' : null),
		});

		await copy(tools, 'src/main.ts', 'src/main.ts');
		expect(await project.readFile('src/main.ts')).toBe('main');
		expect(await copy(tools, 'src/main.ts', 'spec/main.ts')).toContain('REFUSED spec/main.ts: the model is frozen');
		expect(await project.exists('spec/main.ts')).toBe(false);
	});
});
