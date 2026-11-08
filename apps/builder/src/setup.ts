/**
 * The project a build starts from, laid down by the host before the first scaffold pass.
 *
 * Every build made the same copies, which cost it about 30 tool calls and steps it then
 * re-read on every later step. None of it needs judgement, so none of it is the model's.
 */
import { standalonePackageJson } from '@substrat-run/builder-generator';
import type { Workspace } from '@substrat-run/builder-workspace/edge';

const PROJECT_FILES = ['package.json', 'tsconfig.json', 'tsconfig.worker.json', 'vitest.config.ts', 'test/setup.ts', 'src/worker.ts'];

/**
 * The routes every project mounts: each declared operation at its `http`, and `POST /api/invoke`,
 * which the app's `invoke` calls. Nothing in it is the vertical's, so no build should write it.
 */
const routes = (ops: string): string => `import type { Context, Hono } from 'hono';
import { externalInput, externalJson, mountOperations, problemResponse, type ResolveStub } from '@substrat-run/vertical-host';
import { ${ops === 'operations' ? ops : `${ops} as operations`} } from '../spec/model.js';

export type { ResolveStub };

/** The HTTP API, derived from the declared operations; both entrypoints mount it. */
export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  app.onError((err, c: Context) => problemResponse(c, err));
  // The route the app's \`invoke\` calls: a thin wrapper over one operation.
  app.post('/api/invoke', async (c) => {
    const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
    return externalJson(c, (await (await resolveStub(c)).invoke(op, externalInput(input))) ?? null);
  });
  return mountOperations(app, operations, resolveStub);
}
`;

const withoutComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * What the gates sent back to nearly every build's second turn, settled before its first: the
 * routes, the join a hosted first sign-in runs, and the email an invitation sends. Each is read
 * off what the earlier stages decided, `spec/model.ts` and the approved `spec/concept.md`.
 */
async function wire(ws: Workspace): Promise<void> {
	const model = withoutComments(await ws.readFile('spec/model.ts').catch(() => ''));
	const ops = /export\s+const\s+(\w+)\s*=\s*defineOperations\b/.exec(model)?.[1];
	if (ops && !(await ws.exists('src/routes.ts'))) await ws.writeFile('src/routes.ts', routes(ops));
	const join = /['"]([a-z][a-z0-9-]*\/(?:join|sign-up))['"]\s*:/.exec(model);
	// Only a join the platform's door can call: one that takes the person's display name, or nothing.
	const block = join ? model.slice(join.index, join.index + 800).split(/\n\s*['"][a-z][a-z0-9-]*\/[a-z0-9-]+['"]\s*:/)[0]! : '';
	const call = /\binput\s*:\s*z\.object\(\s*\{\s*\}\s*\)/.test(block)
		? `(scope) => scope.invoke('${join?.[1]}', {})`
		: /\bdisplayName\b/.test(block)
			? `(scope, who) => scope.invoke('${join?.[1]}', { displayName: who.display })`
			: null;
	const worker = await ws.readFile('src/worker.ts').catch(() => '');
	if (join && call && /workerDoor<Env>\(\{\n/.test(worker) && !/\bjoin\s*:/.test(withoutComments(worker))) {
		await ws.writeFile(
			'src/worker.ts',
			worker.replace(
				/workerDoor<Env>\(\{\n/,
				`workerDoor<Env>({\n  // A person's first sign-in joins them, as the dev server's /api/me does.\n  join: ${call},\n`,
			),
		);
	}
	const concept = await ws.readFile('spec/concept.md').catch(() => '');
	const sendsEmail = /invit/i.test(concept) && /e-?mail/i.test(concept);
	// The app is served from the edge, as push requires of a project with app/index.html: built by
	// the declared command, its own routes left to the worker, and a deep link answered by the app.
	const hasApp = await ws.exists('app/index.html');
	if (sendsEmail || hasApp) {
		const pkg = JSON.parse(await ws.readFile('package.json')) as { substrat?: { runtimeNeeds?: Record<string, unknown> } & Record<string, unknown> };
		const substrat = { ...pkg.substrat, ...(sendsEmail ? { sendsEmail: true } : {}) };
		if (hasApp && substrat.runtimeNeeds && !substrat.runtimeNeeds.assets) {
			substrat.runtimeNeeds = {
				...substrat.runtimeNeeds,
				build: 'pnpm --dir app build',
				assets: { directory: 'app/dist', notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*', '/internal/*'] },
			};
		}
		pkg.substrat = substrat;
		await ws.writeFile('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
	}
	if (hasApp) {
		const door = await ws.readFile('src/worker.ts').catch(() => '');
		const said = '// Unmatched /api/* fails as JSON; everything else gets a pointer, not a UI —\n// this starter ships no SPA (add one and inline it at build time when you do).';
		if (door.includes(said)) {
			await ws.writeFile(
				'src/worker.ts',
				door.replace(said, '// app/ is served from the edge (runtimeNeeds.assets), so this worker sees only the paths it\n// runs first: /api/*, /internal/* and the platform\'s. Anything else reaching it fails as JSON.'),
			);
		}
	}
}

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
	await wire(ws);
	const install = await ws.exec('pnpm install --no-frozen-lockfile');
	if (install.exitCode !== 0) throw new Error(`the project did not install: ${install.stderr || install.stdout}`);
	return true;
}
