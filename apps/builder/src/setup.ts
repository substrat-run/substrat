/**
 * The project a build starts from, laid down by the host before the first scaffold pass.
 *
 * Every build made the same copies, which cost it about 30 tool calls and steps it then
 * re-read on every later step. None of it needs judgement, so none of it is the model's.
 */
import { standalonePackageJson } from '@substrat-run/builder-generator';
import type { Workspace } from '@substrat-run/builder-workspace/edge';

const PROJECT_FILES = ['package.json', 'tsconfig.json', 'vitest.config.ts', 'test/setup.ts'];

/** The root and the app install as one, and the template's build policy still holds. */
const WORKSPACE_MEMBERS = 'packages:\n  - "."\n  - app\n';

const copyTree = async (source: Workspace, dir: string, ws: Workspace, dest: string): Promise<void> => {
	for (const entry of await source.listFiles(dir)) {
		const name = entry.replace(/\/$/, '');
		if (name === 'node_modules' || name === 'dist' || name === 'CHANGELOG.md') continue;
		const from = dir === '.' ? name : `${dir}/${name}`;
		if (entry.endsWith('/')) await copyTree(source, from, ws, `${dest}/${name}`);
		else {
			const text = await source.readFile(from);
			await ws.writeFile(`${dest}/${name}`, name === 'package.json' ? standalonePackageJson(text) : text);
		}
	}
};

/** Lays the project down once, and installs it. A project that has a package.json is left alone. */
export async function layProject(
	ws: Workspace,
	references: Readonly<Record<string, Workspace>>,
	/** Extra `pnpm-workspace.yaml` lines: an eval's overrides, to build against unreleased packages. */
	workspaceExtra = '',
): Promise<boolean> {
	const { template, portal } = references;
	if (!template || !portal || (await ws.exists('package.json'))) return false;
	for (const file of PROJECT_FILES) await ws.writeFile(file, await template.readFile(file));
	await ws.writeFile('pnpm-workspace.yaml', `${WORKSPACE_MEMBERS}${await template.readFile('pnpm-workspace.yaml')}${workspaceExtra}`);
	await copyTree(portal, '.', ws, 'app');
	const install = await ws.exec('pnpm install --no-frozen-lockfile');
	if (install.exitCode !== 0) throw new Error(`the project did not install: ${install.stderr || install.stdout}`);
	return true;
}
