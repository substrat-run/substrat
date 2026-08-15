/**
 * The structural probe — how an eval reads "operations exist, roles hold
 * permissions" out of a generated project without trusting anything the model
 * wrote ABOUT the project.
 *
 * It imports the same exports `tools/permission-diff.mts` renders for the demo
 * verticals: `MODULES` (the registrations `buildHost` registers — operation
 * names and manifest permissions) and `ROLES` (the declarative role table the
 * seed defines). Reading the enforced objects rather than grepping source is
 * what makes the check structural: an operation that exists only in prose does
 * not exist.
 *
 * Mechanics: a small ESM script is written INTO the project and run with the
 * project's own tsx (`pnpm --filter ./<dir> exec tsx …`), so imports resolve
 * against the project's dependencies, then removed. Runs in mode A by
 * construction — a child process, nothing more.
 */
import type { Workspace } from '@substrat-run/builder-workspace';

export interface ProbeModule {
	readonly id: string;
	readonly operations: readonly string[];
	readonly permissions: readonly string[];
}

export interface ProbeRole {
	readonly key: string;
	readonly permissions: readonly string[];
}

export interface ProbeResult {
	/** null: the entry module had no MODULES export (or none was found). */
	readonly modules: readonly ProbeModule[] | null;
	/** null: no ROLES export — the scaffold convention the skill pins. */
	readonly roles: readonly ProbeRole[] | null;
	readonly error?: string;
}

export type ProbeFn = (ws: Workspace, projectDir: string) => Promise<ProbeResult>;

const PROBE_FILE = '.substrat-eval-probe.mts';

/**
 * Discovery order matches permission-diff: the package.json `substrat.permissions`
 * entry wins, then the demo convention (src/provision.ts), then src/seed.ts.
 */
const PROBE_SOURCE = `import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : {};
const candidates = [pkg?.substrat?.permissions, 'src/provision.ts', 'src/seed.ts'].filter(Boolean);
const entry = candidates.find((p) => existsSync(p));
if (!entry) {
	console.log(JSON.stringify({ modules: null, roles: null, error: 'no seed/provision entry found' }));
	process.exit(0);
}
try {
	const mod = await import(pathToFileURL(resolve(entry)).href);
	const modules = Array.isArray(mod.MODULES)
		? mod.MODULES.map((m) => ({
				id: String(m?.manifest?.id ?? '(unknown)'),
				operations: Object.keys(m?.operations ?? {}),
				permissions: (m?.manifest?.permissions ?? []).map((p) => String(p?.key)),
			}))
		: null;
	const roles = Array.isArray(mod.ROLES)
		? mod.ROLES.map((r) => ({
				key: String(r?.key ?? ''),
				permissions: (r?.permissions ?? []).map(String),
			}))
		: null;
	console.log(JSON.stringify({ modules, roles }));
} catch (err) {
	console.log(
		JSON.stringify({
			modules: null,
			roles: null,
			error: \`import of \${entry} failed: \${err instanceof Error ? err.message : String(err)}\`,
		}),
	);
}
`;

/** The real probe: tsx inside the project. Throws only when it could not run at all. */
export const runProbe: ProbeFn = async (ws, projectDir) => {
	const path = `${projectDir}/${PROBE_FILE}`;
	await ws.writeFile(path, PROBE_SOURCE);
	try {
		const { stdout, stderr, exitCode } = await ws.exec(
			`pnpm --filter ./${projectDir} exec tsx ${PROBE_FILE}`,
		);
		if (exitCode !== 0) {
			throw new Error(
				`probe exited ${exitCode}: ${(stderr || stdout).trim().slice(-2000) || '(no output)'}`,
			);
		}
		// The JSON is the last non-empty line — tsx and pnpm may chatter before it.
		const line = stdout
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
			.at(-1);
		if (!line) throw new Error('probe produced no output');
		return JSON.parse(line) as ProbeResult;
	} finally {
		await ws.exec(`rm -f ${JSON.stringify(path)}`);
	}
};
