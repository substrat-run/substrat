import type { Workspace } from '@substrat-run/builder-workspace/edge';
import { TSCONFIG, VITEST_CONFIG, packageJson } from 'create-substrat/project-files.js';

/**
 * The reference verticals every host hands the generator (`GeneratorInput.references`),
 * relative to the platform checkout. Both are compiled against the workspace on
 * every PR — the template by #878's template-check, todo as a workspace member —
 * so copying from them cannot teach an API that no longer exists: the failure
 * skill prose has, and the reason these are code and not a skill.
 *
 * - `template` — the create-substrat template: the harness (host, seed,
 *   provisioning, server, routes, personas), and the project files a scaffold computes.
 * - `todo` — the model-first reference vertical: concept → model → module, with
 *   per-list sharing (join, ctx.link to the owner, ctx.grant/ctx.revoke).
 * - `portal` — the app shell a generated `app/` starts from: elements, themes, user menu,
 *   hash routing and one entity table, copied whole with `copy_reference`.
 */
export const REFERENCE_DIRS = {
	template: 'packages/create-substrat/template',
	todo: 'demos/todo',
	portal: 'packages/portal-starter',
} as const;

/** What `npm create substrat` computes rather than copies, so the template directory lacks them. */
const PROJECT_FILES: Readonly<Record<string, string>> = {
	'package.json': packageJson('my-app'),
	'tsconfig.json': TSCONFIG,
	'vitest.config.ts': VITEST_CONFIG,
};

/**
 * The template as a scaffold receives it. Without these a build wrote its own package.json,
 * looking versions up or recalling them, and pinned nothing the platform had compiled against.
 */
function withProjectFiles(ws: Workspace): Workspace {
	const generated = (path: string): string | undefined => PROJECT_FILES[path.replace(/^\.\//, '')];
	return {
		id: ws.id,
		exec: (cmd, opts) => ws.exec(cmd, opts),
		readFile: async (path) => generated(path) ?? ws.readFile(path),
		writeFile: (path, content) => ws.writeFile(path, content),
		mkdir: (path, opts) => ws.mkdir(path, opts),
		listFiles: async (path) => {
			// `copy_reference` tells a file from a directory by whether listing it throws.
			if (generated(path) !== undefined) throw new Error(`${path} is a file`);
			const entries = await ws.listFiles(path);
			return path === '.' ? [...entries, ...Object.keys(PROJECT_FILES)] : entries;
		},
		exists: async (path) => generated(path) !== undefined || ws.exists(path),
		hasTool: (path) => ws.hasTool(path),
		exposePort: (port) => ws.exposePort(port),
		dispose: () => ws.dispose(),
	};
}

/** Every reference, each opened by the host on its own kind of workspace. */
export function openReferences(open: (dir: string, id: string) => Workspace): Record<string, Workspace> {
	return Object.fromEntries(
		Object.entries(REFERENCE_DIRS).map(([name, dir]) => {
			const ws = open(dir, `reference:${name}`);
			return [name, name === 'template' ? withProjectFiles(ws) : ws];
		}),
	);
}
