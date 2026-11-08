/**
 * The tier-1 gates — builder-studio.md §9.1.
 *
 * These are the checks the generator CANNOT author its own oracle for: the
 * expected output is derived from committed artifacts (PERMISSIONS.md, the API
 * document, the migration list) rather than asserted by whoever wrote the code.
 * That is the entire reason they are trusted and agent-written tests are not
 * (§9.4) — so this runner never reports a gate as passing on anything softer
 * than a zero exit code.
 *
 * Exit-code convention, owned by Substrat's OWN checkers (boundary-lint,
 * lint:permissions, lint:api):
 *   0 = fine · 1 = drift/violation · 2 = the tool could not do its job
 * A `2` is reported as `blocked`, not `failed`: it means we learned nothing, and
 * treating "the checker crashed" as "the code is bad" trains the agent to
 * "fix" the wrong thing.
 *
 * That convention is opt-in PER GATE (`exitConvention: 'substrat'`) because
 * external tools do not speak it: tsc exits 2 on ordinary type errors, so a
 * blanket "2 = blocked" silently disarmed the repair loop for exactly the gate
 * that fails most — the model was told "this is NOT a code problem" about its
 * own type errors. Default: every nonzero exit is a plain failure.
 */
import { runtimeNeeds } from '@substrat-run/contracts';
import type { Workspace } from './workspace.js';
import {
	emitProjectModel,
	MODEL_ARTIFACT_PATH,
	MODEL_EMITTER_PATH,
	MODEL_SOURCE_PATH,
	type ModelEmitResult,
	type ModelEmitStatus,
} from './model.js';
import { emitProjectMigrations } from './migrations.js';

export type GateName =
	| 'install'
	| 'model'
	| 'model-emit'
	| 'migrations-emit'
	| 'migrations-registered'
	| 'typecheck'
	| 'boundary-lint'
	| 'permissions'
	| 'api'
	| 'scenario'
	| 'app-build'
	| 'app-api'
	| 'app-components'
	| 'app-ports'
	| 'app-data'
	| 'app-starter'
	| 'sign-in'
	| 'dev-scripts'
	| 'sends-email'
	| 'invite-email'
	| 'app-events'
	| 'app-writes'
	| 'hosted-entry'
	| 'hosted-assets'
	| 'hosted-join'
	| 'dev-join'
	| 'migration-replay';

export type GateStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

export interface GateResult {
	readonly name: GateName;
	readonly status: GateStatus;
	readonly exitCode: number;
	readonly durationMs: number;
	/** Trimmed combined output — what the generator is shown on failure. */
	readonly output: string;
	/** Why a gate was skipped, or what a passed one could not do. */
	readonly note?: string;
}

/** The permission renderer, run by the gate (`--check`) and by the turn loop (emit). */
export const PERMISSION_EMITTER_PATH = 'tools/permission-diff.mts';

export interface GateSpec {
	readonly name: GateName;
	readonly cmd: string;
	/** When present and false at run time, the gate is skipped with `note`. */
	readonly appliesWhen?: (ws: Workspace, verticalDir: string) => Promise<boolean>;
	readonly note?: string;
	/**
	 * A precondition the gate refuses on BEFORE running `cmd`: a sentence when it
	 * fails (reported as `failed`, the sentence as output), null when `cmd` may run.
	 * In code rather than in `cmd` so the command stays the bare tool call a
	 * ContainerWorkspace re-points at the toolchain — a prefix breaks that match.
	 */
	readonly refuse?: (ws: Workspace, verticalDir: string) => Promise<string | null>;
	/**
	 * Exit-code dialect. `'substrat'` = the 0/1/2 convention above (2 → blocked);
	 * only our own checkers speak it. Absent = binary: any nonzero exit is
	 * `failed`. Misclassifying a crashed external checker as failed shows the
	 * model some noise; the reverse (tsc's exit-2 type errors as blocked) mutes
	 * the repair loop entirely — so binary is the default.
	 */
	readonly exitConvention?: 'substrat';
}

/**
 * The gates as they exist in this repo today. `migration-replay` is specified in
 * generated-verticals.md §6.2 but NOT yet built — it is declared here and
 * reported as `skipped` rather than quietly omitted, so the gap is visible in
 * every run instead of being rediscovered later.
 */
export function defaultGates(verticalDir: string): GateSpec[] {
	return [
		{ name: 'typecheck', cmd: 'pnpm -r typecheck' },
		{ name: 'boundary-lint', cmd: 'node tools/boundary-lint.mjs', exitConvention: 'substrat' },
		{ name: 'permissions', cmd: 'pnpm lint:permissions --check', exitConvention: 'substrat' },
		{
			name: 'api',
			cmd: 'pnpm lint:api --check',
			exitConvention: 'substrat',
			// api-diff is opt-in per vertical (api-surface.md §3): a vertical without
			// src/api.ts simply is not documented yet, which is not a failure.
			appliesWhen: async (ws) => await ws.exists(`${verticalDir}/src/api.ts`),
			note: 'no src/api.ts — vertical has not opted into the API catalog yet',
		},
		{
			name: 'scenario',
			cmd: `pnpm --filter ./${verticalDir} test`,
			appliesWhen: async (ws) => await ws.exists(`${verticalDir}/test`),
			note: 'no test/ directory in the vertical',
		},
		{
			name: 'migration-replay',
			cmd: '',
			appliesWhen: async () => false,
			note: 'not built — specified in generated-verticals.md §6.2',
		},
	];
}

/**
 * The gates for a STANDALONE project (§4.6) — a vertical in its own repo under
 * `.builder/projects/*`, shaped like `examples/external-vertical`, consuming the
 * kernel and engines as workspace deps rather than living in `demos/`.
 *
 * The monorepo sweeps (`pnpm -r typecheck`, repo-wide boundary-lint, the
 * permission-diff over `demos/`+`apps/`) do not see it, so each gate switches to
 * its per-project form. Where no standalone form exists yet the gate is declared
 * and skipped WITH A NOTE — an invisible gap becomes a visible one (same rule as
 * migration-replay).
 */
/**
 * Does this project declare a permission surface for `permission-diff` to render?
 *
 * The tool's own discovery rule (`substrat.permissions` in package.json), asked
 * here so the gate SKIPS with a note rather than reporting `blocked` on a project
 * that has not written a module yet — a scaffold mid-build is not a broken
 * checker. Once the entry exists, every way the render can fail is the tool's
 * exit 2, which the substrat convention reports as blocked.
 *
 * An unreadable or malformed package.json answers false: the `typecheck` and
 * `install` gates own that failure and say so far better than a permission gate
 * would.
 */
export async function declaresPermissions(ws: Workspace, projectDir: string): Promise<boolean> {
	return typeof (await substratBlock(ws, projectDir)).permissions === 'string';
}

/** package.json's `substrat` block, empty when the file is unreadable or malformed. */
async function substratBlock(ws: Workspace, projectDir: string): Promise<{ permissions?: string; sendsEmail?: boolean }> {
	try {
		const pkg = JSON.parse(await ws.readFile(`${projectDir}/package.json`)) as {
			substrat?: { permissions?: string; sendsEmail?: boolean };
		};
		return pkg.substrat ?? {};
	} catch {
		return {};
	}
}

/**
 * The `model` gate's compile. `tsc` ignores a tsconfig whenever files are named on
 * its command line, so the project's own config only applies through a throwaway
 * one that `extends` it and lists `spec/model.ts` alone (#2727). It sits inside
 * the project so `types` and `paths` resolve as they do for the project's own
 * typecheck, and is removed in the same command so no turn's commit picks it up.
 * With no project tsconfig yet (the model phase, before scaffold) the file is
 * compiled under explicit defaults instead.
 */
function modelCompileCmd(projectDir: string): string {
	const dir = `'${projectDir.replace(/'/g, "'\\''")}'`;
	const throwaway = `${dir}/tsconfig.model-gate.json`;
	const config = '{"extends":"./tsconfig.json","files":["spec/model.ts"],"include":[],"compilerOptions":{"noEmit":true}}';
	return (
		`if [ -f ${dir}/tsconfig.json ]; then ` +
		`printf '%s' '${config}' > ${throwaway}; pnpm exec tsc -p ${throwaway}; code=$?; rm -f ${throwaway}; exit $code; ` +
		`else pnpm exec tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2023 --module NodeNext ${dir}/spec/model.ts; fi`
	);
}

/** Every file under `dir`, as one string; nothing when it does not exist. */
async function readTree(ws: Workspace, dir: string): Promise<string> {
	const entries = await ws.listFiles(dir).catch(() => [] as string[]);
	const parts = await Promise.all(
		entries.map(async (entry) => {
			const path = `${dir}/${entry.replace(/\/$/, '')}`;
			return entry.endsWith('/') ? await readTree(ws, path) : await ws.readFile(path);
		}),
	);
	return parts.join('\n');
}

const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');

/** The API port a file falls back to. `ISSUER_PORT` and `WEB_PORT` are other ports. */
const apiPortIn = (source: string): string | undefined => /(?<![A-Z_])PORT\s*\?\?\s*['"]?(\d+)/.exec(source)?.[1];

/** A `<wa-*>` nobody registered renders its children inline, so a dialog sits open on the page. */
async function unregisteredComponents(ws: Workspace, projectDir: string): Promise<string | null> {
	const controls = await ws.readFile(`${projectDir}/app/node_modules/@substrat-run/elements/dist/controls.js`).catch(() => null);
	if (controls === null) return null;
	const app = await readTree(ws, `${projectDir}/app/src`);
	const registered = new Set([...`${controls}\n${app}`.matchAll(/components\/([a-z-]+)\//g)].map((m) => m[1]));
	const missing = [...new Set([...app.matchAll(/<wa-([a-z-]+)/g)].map((m) => m[1]!))].filter((tag) => !registered.has(tag));
	if (missing.length === 0) return null;
	const tags = missing.map((tag) => `<wa-${tag}>`).join(', ');
	return `app/src uses ${tags}, which @substrat-run/elements/controls does not register, so it renders as plain text. Use a registered control or a native element such as <dialog>.`;
}

/** The app's dev proxy and the server each fall back to a port, and they have to be the same one. */
async function portsDisagree(ws: Workspace, projectDir: string): Promise<string | null> {
	const read = (file: string) => ws.readFile(`${projectDir}/${file}`).catch(() => '');
	const server = apiPortIn(await read('src/server.ts'));
	const proxy = apiPortIn(await read('app/vite.config.ts'));
	if (!server || !proxy || server === proxy) return null;
	return `src/server.ts listens on ${server} by default and app/vite.config.ts proxies to ${proxy}, so the app cannot reach the server. Use ${proxy} in src/server.ts.`;
}

/**
 * What app/vite.config.ts must keep refusing to serve. `deny` replaces Vite's own list, so its
 * defaults are restated, and `.data/` is where the dev server keeps every scope's database: left
 * out, `/@fs/<project>/.data/<scope>.sqlite` answers 200 to anyone who can reach the dev server.
 * The portal starter carries all of it; `pnpm lint:vite-proxy` holds the starter to the same list.
 */
const DEV_FS_DENY = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.data/**'];

async function dataDirServed(ws: Workspace, projectDir: string): Promise<string | null> {
	// Raw text: the patterns themselves hold `/**` and `**/`, which a comment strip would eat.
	const config = await ws.readFile(`${projectDir}/app/vite.config.ts`).catch(() => '');
	if (config === '') return null;
	const missing = DEV_FS_DENY.filter((pattern) => !config.includes(`'${pattern}'`) && !config.includes(`"${pattern}"`));
	if (missing.length === 0 && !/\bstrict\s*:\s*false\b/.test(config)) return null;
	return `app/vite.config.ts lets the dev server serve files it must refuse (${missing.length ? missing.join(', ') : 'fs.strict: false'}), so /@fs/<project>/.data/<scope>.sqlite hands the whole database to anyone who can reach it. Keep server.fs.deny exactly as the portal starter writes it.`;
}

async function starterLeft(ws: Workspace, projectDir: string): Promise<string | null> {
	const screens = await ws.readFile(`${projectDir}/app/src/screens.ts`).catch(() => '');
	return screens.includes('acme/') ? 'app/src/screens.ts is still the starter: rewrite it, one screen per line of the Screens section.' : null;
}

/** Who is calling comes from the login, never from a header the client sets. */
async function noRealSignIn(ws: Workspace, projectDir: string): Promise<string | null> {
	const server = withoutComments(await readTree(ws, `${projectDir}/src`));
	const app = withoutComments(await readTree(ws, `${projectDir}/app/src`));
	if (/x-principal/i.test(`${server}\n${app}`)) return 'The code identifies the caller from an x-principal header, which anyone can set. Use devLogin, as the template\'s src/server.ts does.';
	return /devLogin|verticalAuth|oidcRp/.test(server) ? null : 'src/ has no sign-in. Use devLogin, as the template\'s src/server.ts does.';
}

/**
 * A script that runs a file the project does not have. The scaffold writes src/server.ts and
 * src/personas.ts, which the laid-down package.json's dev and issuer scripts run; 8 of 137 Haiku builds
 * never did, so `pnpm dev` could not start and nobody could sign in locally. The sign-in and dev-join
 * gates read src/server.ts only when it exists, so every gate passed.
 */
async function scriptsRunMissingFiles(ws: Workspace, projectDir: string): Promise<string | null> {
	let scripts: Record<string, unknown>;
	try {
		scripts = (JSON.parse(await ws.readFile(`${projectDir}/package.json`)) as { scripts?: Record<string, unknown> }).scripts ?? {};
	} catch {
		return null;
	}
	const missing = new Map<string, string>();
	for (const [name, command] of Object.entries(scripts)) {
		if (typeof command !== 'string') continue;
		for (const [file] of command.matchAll(/\bsrc\/[\w./-]+\.[cm]?[jt]s\b/g)) {
			if (!missing.has(file) && !(await ws.exists(`${projectDir}/${file}`))) missing.set(file, name);
		}
	}
	if (missing.size === 0) return null;
	const named = [...missing].map(([file, script]) => `${file} (the "${script}" script)`).join(', ');
	return `package.json runs files the project does not have, so pnpm dev cannot start and nobody can sign in locally: ${named}. Write each from the template's (copy_reference template <file>) and adapt it: src/server.ts is the local API with its dev sign-in, src/personas.ts the cast the dev issuer offers and the seed links to people.`;
}

/**
 * An invitation nobody receives: the concept invites people by email, and nothing in src/ sends one.
 * The score sees it and no other gate does, and the scenario suite passes, since a local host only queues.
 */
async function inviteSendsNoEmail(ws: Workspace, projectDir: string): Promise<string | null> {
	const concept = await ws.readFile(`${projectDir}/spec/concept.md`).catch(() => '');
	if (!/invit/i.test(concept) || !/e-?mail/i.test(concept)) return null;
	if (/\brequestEmail\(/.test(withoutComments(await readTree(ws, `${projectDir}/src`)))) return null;
	return 'spec/concept.md invites people by email, and nothing in src/ sends one, so an invitation reaches nobody. Queue the email in the operation that invites, with requestEmail(ctx, { to, subject, html, text }) from @substrat-run/kernel, as todo/invite does in the todo reference.';
}

/**
 * `<sub-entity-table>` answers a row click with `sub-row-click`, and only under the `row-click`
 * attribute, so a listener spelled any other way never fires and a row cannot be opened. A judge
 * reading the code passed one such build; clicking it found it.
 */
async function rowClickUnheard(ws: Workspace, projectDir: string): Promise<string | null> {
	const app = withoutComments(await readTree(ws, `${projectDir}/app/src`));
	for (const [tag] of app.matchAll(/<sub-entity-table\b(?:=>|[^>])*>/g)) {
		if (/@row-?click\s*=/i.test(tag)) {
			return 'app/src listens for @row-click on <sub-entity-table>, which sends sub-row-click, so clicking a row does nothing. Write row-click @sub-row-click=${…}: the attribute turns row clicks on, and the event carries { row }.';
		}
		if (/@sub-row-click\s*=/.test(tag) && !/\srow-click(?=[\s>=])/.test(tag)) {
			return 'app/src listens for @sub-row-click on a <sub-entity-table> without the row-click attribute, so the event never fires. Add row-click to the element.';
		}
	}
	return null;
}

/**
 * An operation that changes data and that no screen offers: the API has it, and a person using
 * the app never reaches it. Haiku builds left out delete-list, rename-list or edit-item in about one
 * in three, and every gate passed, since the scenario drives the module and never the screens.
 * The host's own calls (join, from server.ts or worker.ts) count as reached; an operation only
 * another program calls says so in an `api-only:` comment in app/src.
 */
async function writesUnoffered(ws: Workspace, projectDir: string): Promise<string | null> {
	const model = await ws.readFile(`${projectDir}/spec/model.ts`).catch(() => '');
	const parts = model.split(/\n\s*'([a-z0-9-]+\/[a-z0-9-]+)':\s*\{/);
	const writes: string[] = [];
	for (let i = 1; i < parts.length; i += 2) {
		if (/\bemits\s*:/.test(parts[i + 1] ?? '')) writes.push(parts[i]!);
	}
	if (writes.length === 0) return null;
	const appRaw = await readTree(ws, `${projectDir}/app/src`);
	const app = withoutComments(appRaw);
	const hostFiles = (await ws.listFiles(`${projectDir}/src`).catch(() => [] as string[])).filter(
		(f) => !f.endsWith('/') && f !== 'module.ts' && !f.includes('.generated.'),
	);
	const host = withoutComments(
		(await Promise.all(hostFiles.map((f) => ws.readFile(`${projectDir}/src/${f}`).catch(() => '')))).join('\n'),
	);
	const apiOnly = [...appRaw.matchAll(/api-only:([^\n]*)/g)].map((m) => m[1]!).join(' ');
	// The short name after a slash too: an app may build the name from its namespace (`${NS}/x`).
	const named = (source: string, op: string): boolean =>
		new RegExp(`/${op.split('/')[1]!.replace(/-/g, '\\-')}['"\`]`).test(source);
	const missing = writes.filter((op) => !named(app, op) && !named(host, op) && !apiOnly.includes(op));
	if (missing.length === 0) return null;
	return `spec/model.ts declares operations that change data and that nothing in app/src calls, so a person using the app can never do them: ${missing.join(', ')}. Section 4 of spec/concept.md says who may do each: give each a visible control on the screen it belongs to, as a row action or a button on the record's screen, and reload the tables it changes. An operation that only another program calls stays off the screens: name it in a comment in app/src, // api-only: <operation> — <why>.`;
}

/** A hosted send is refused unless the project asked to send, and no suite sees that: a local host only queues. */
async function undeclaredEmail(ws: Workspace, projectDir: string): Promise<string | null> {
	if (!/\brequestEmail\(/.test(withoutComments(await readTree(ws, `${projectDir}/src`)))) return null;
	if ((await substratBlock(ws, projectDir)).sendsEmail === true) return null;
	return 'src/ queues email with requestEmail, and a hosted send is refused unless the project asks for it. Set "sendsEmail": true under "substrat" in package.json.';
}

/**
 * A project with an app that nothing deployed would serve: `substrat push` refuses it, and pushed
 * anyway it answers the API and 404s on /. Every local gate passes, since the dev server serves the app.
 */
async function appUnserved(ws: Workspace, projectDir: string): Promise<string | null> {
	let needs: { assets?: unknown } | undefined;
	try {
		needs = (JSON.parse(await ws.readFile(`${projectDir}/package.json`)) as { substrat?: { runtimeNeeds?: { assets?: unknown } } })?.substrat?.runtimeNeeds;
	} catch {
		return null;
	}
	if (!needs) return null;
	const assets = needs.assets as { directory?: unknown } | undefined;
	if (assets !== undefined && (typeof assets !== 'object' || assets === null || typeof assets.directory !== 'string' || !assets.directory)) {
		return 'substrat.runtimeNeeds.assets in package.json is not what push reads, an object naming the built directory, so the push is refused. Write it back as "assets": { "directory": "app/dist", "notFoundHandling": "single-page-application", "runWorkerFirst": ["/api/*", "/internal/*"] }.';
	}
	if (assets) return null;
	if (!(await ws.exists(`${projectDir}/app/index.html`))) return null;
	return 'app/ has a UI that a push would not serve: substrat push refuses it, since the deployed vertical would answer the API and 404 on /. Declare it under substrat.runtimeNeeds in package.json: "build": "pnpm --dir app build", and "assets": { "directory": "app/dist", "notFoundHandling": "single-page-application", "runWorkerFirst": ["/api/*", "/internal/*"] }.';
}

/**
 * What `substrat push` needs: a deploy config, which is `substrat.runtimeNeeds` naming an entry that
 * exists or else a hand-authored wrangler.jsonc, and the project's own wrangler, which it builds the
 * worker with and never downloads. Without them every local gate passes and nothing can be pushed.
 * A malformed package.json is install's to refuse, as for the other gates.
 */
async function entryMissing(ws: Workspace, projectDir: string): Promise<string | null> {
	let pkg: { substrat?: { runtimeNeeds?: { entry?: unknown } }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	try {
		pkg = JSON.parse(await ws.readFile(`${projectDir}/package.json`)) ?? {};
	} catch {
		return null;
	}
	const needs = pkg.substrat?.runtimeNeeds;
	if (needs === undefined) {
		if (!(await ws.exists(`${projectDir}/wrangler.jsonc`))) {
			return 'package.json declares no substrat.runtimeNeeds and the project has no wrangler.jsonc, so substrat push has nothing to build. Put back the template\'s "runtimeNeeds" under "substrat", with "entry": "src/worker.ts".';
		}
	} else if (typeof needs.entry !== 'string' || needs.entry.trim() === '') {
		return 'substrat.runtimeNeeds in package.json names no entry, so substrat push has nothing to deploy. Set "entry": "src/worker.ts", the template\'s worker.';
	} else if (!(await ws.exists(`${projectDir}/${needs.entry}`))) {
		return `package.json names ${needs.entry} as the deployed entry (substrat.runtimeNeeds.entry), and it is not there, so the project cannot be pushed. Copy it back from the template (copy_reference template ${needs.entry}) and keep it: it imports only from src/provision.ts and src/routes.ts.`;
	}
	if (needs !== undefined) {
		// What push parses, by the schema push parses it with: a DeepSeek build declared
		// `build: { command, output }`, and every gate passed a project push would refuse.
		const parsed = runtimeNeeds.safeParse(needs);
		if (!parsed.success) {
			const issues = parsed.error.issues.map((i) => `${['runtimeNeeds', ...i.path].join('.')}: ${i.message}`).join('; ');
			return `substrat.runtimeNeeds in package.json is not what substrat push reads, so the push is refused (${issues}). Write it back in the template's shape: "build" is the command as one string, "pnpm --dir app build".`;
		}
	}
	if (pkg.devDependencies?.wrangler || pkg.dependencies?.wrangler) return null;
	return 'package.json has no wrangler, and substrat push builds the worker with the project\'s own. Put back the template\'s "wrangler" in devDependencies, with its version.';
}

/**
 * A hosted person is joined by the worker's door, and only when the worker names the join. Every
 * local gate passes without it, because the dev server joins on sign-in itself; hosted, the owner
 * signs in and cannot create anything.
 */
async function hostedJoinUnnamed(ws: Workspace, projectDir: string): Promise<string | null> {
	const worker = withoutComments(await ws.readFile(`${projectDir}/src/worker.ts`).catch(() => ''));
	const declared = withoutComments(`${await readTree(ws, `${projectDir}/spec`)}\n${await readTree(ws, `${projectDir}/src`)}`);
	const join = /['"]([a-z][a-z0-9-]*\/(?:join|sign-up))['"]\s*:/.exec(declared)?.[1];
	if (!join || (/\bjoin\s*:/.test(worker) && worker.includes(join))) return null;
	return `The model declares ${join}, and src/worker.ts does not name it in workerDoor, so a hosted person is never joined and cannot create anything. Add it to the workerDoor options: join: (scope, who) => scope.invoke('${join}', { displayName: who.display }), with the input your join takes.`;
}

/**
 * The dev server joins a person when they sign in, as the worker's door does hosted. A build that
 * never runs the join there passes every gate, and in the browser every create is refused with
 * "join first": the scenario suite drives the module and never signs in.
 */
async function devJoinMissing(ws: Workspace, projectDir: string): Promise<string | null> {
	const declared = withoutComments(`${await readTree(ws, `${projectDir}/spec`)}\n${await readTree(ws, `${projectDir}/src`)}`);
	const join = /['"]([a-z][a-z0-9-]*\/(?:join|sign-up))['"]\s*:/.exec(declared)?.[1];
	if (!join) return null;
	const dev = withoutComments(
		(await Promise.all(['server.ts', 'app.ts'].map((f) => ws.readFile(`${projectDir}/src/${f}`).catch(() => '')))).join('\n'),
	);
	if (dev.includes(join)) return null;
	return `The model declares ${join}, and the dev server (src/server.ts, src/app.ts) never runs it, so a person who signs in is not joined and every create is refused. Run it on sign-in in /api/me, with the address the issuer verified, as the todo reference's src/app.ts does.`;
}

/**
 * The generated migrations are what the module registers: a build that keeps its own DDL beside
 * them ships tables the journal never recorded, and the next model change cannot see them.
 */
async function migrationsUnregistered(ws: Workspace, projectDir: string): Promise<string | null> {
	if (!(await ws.exists(`${projectDir}/src/migrations.generated.ts`))) return null;
	if (await ws.exists(`${projectDir}/src/migrations.ts`)) {
		return 'src/migrations.ts writes DDL beside src/migrations.generated.ts, which is generated from spec/model.ts after every turn. Delete src/migrations.ts and register the generated migrations: import { migrations } from \'./migrations.generated.js\'. A table that should change is a change to the model.';
	}
	const src = withoutComments(await readTree(ws, `${projectDir}/src`));
	if (/from\s+['"]\.\/migrations\.generated(\.js)?['"]/.test(src)) return null;
	return 'Nothing in src/ registers src/migrations.generated.ts, which holds the tables spec/model.ts declares. Register it as the module\'s migrations: import { migrations } from \'./migrations.generated.js\'.';
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function standaloneGates(projectDir: string): GateSpec[] {
	const pkg = async (ws: Workspace): Promise<boolean> => await ws.exists(`${projectDir}/package.json`);
	const hasApp = async (ws: Workspace): Promise<boolean> => await ws.exists(`${projectDir}/app/package.json`);
	return [
		{
			// The model phase's gate (#680). Typechecking `spec/model.ts` IS the
			// check: `defineEntities` / `defineOperations` carry the reference
			// integrity in their types, so a parent that names no entity, an
			// `entityIdFrom` that names no output field, or a payload carrying an
			// erasable field are all compile errors here — before a line of the
			// module exists.
			name: 'model',
			// Before scaffold there is no package.json, so a pnpm filter matches
			// nothing and exits zero without running tsc. Run the root toolchain
			// against the file directly; contracts is a root tooling dependency so
			// both tsc and the emitter can resolve it before project deps exist.
			cmd: modelCompileCmd(projectDir),
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/spec/model.ts`),
			note: 'no spec/model.ts yet — the model phase has not run',
		},
		{
			name: 'typecheck',
			cmd: `pnpm --filter ./${projectDir} typecheck`,
			appliesWhen: pkg,
			note: 'no package.json yet — nothing to typecheck',
		},
		{
			// Standalone mode: boundary-lint --root <project> discovers the vertical's
			// own src plus the engines it consumes from node_modules. Exits 2 rather
			// than lying green when there is nothing lintable — reported as blocked.
			name: 'boundary-lint',
			cmd: `node packages/boundary-lint/dist/cli.js --root ${projectDir}`,
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/src`),
			note: 'no src/ yet',
			exitConvention: 'substrat',
		},
		{
			// Standalone mode (#628): `permission-diff --root <project>` renders the
			// project's OWN PERMISSIONS.md from the `substrat.permissions` entry its
			// package.json declares, instead of sweeping demos/+apps/. Same render, same
			// string-equality drift check, same 0/1/2 — only the discovery differs, so a
			// generated vertical's permission surface reaches the same human checkpoint
			// every demo's does.
			//
			// Once src/module.ts exists the surface is owed, so an undeclared one is
			// RED rather than skipped: skipping let a build pass with no permission
			// review at all, which the checkpoint exists to make impossible.
			name: 'permissions',
			cmd: `pnpm exec tsx ${PERMISSION_EMITTER_PATH} --root ${projectDir} --check`,
			appliesWhen: async (ws) =>
				(await declaresPermissions(ws, projectDir)) || (await ws.exists(`${projectDir}/src/module.ts`)),
			refuse: async (ws) =>
				(await declaresPermissions(ws, projectDir))
					? null
					: 'src/module.ts exists but package.json declares no substrat.permissions, so no permission ' +
						'review can render. Add "substrat": { "slug": "<slug>", "name": "<Name>", "permissions": ' +
						'"src/provision.ts" } — the file exporting MODULES, ROLES and ' +
						'`permissions = definePermissions({ modules: MODULES, roles: ROLES, … })` (from ' +
						'@substrat-run/contracts), which the gate reads. The studio renders ' +
						'PERMISSIONS.md from it after the turn.',
			note: 'no src/module.ts yet — no permission surface owed',
			exitConvention: 'substrat',
		},
		{
			// api-diff is opt-in per vertical (api-surface.md §3), exactly as in the
			// monorepo gates: a vertical without src/api.ts is not documented yet, which
			// is not a failure.
			name: 'api',
			cmd: `pnpm exec tsx tools/api-diff.mts --root ${projectDir} --check`,
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/src/api.ts`),
			note: 'no src/api.ts — vertical has not opted into the API catalog yet',
			exitConvention: 'substrat',
		},
		{
			name: 'scenario',
			cmd: `pnpm --filter ./${projectDir} test`,
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/test`),
			note: 'no test/ directory yet',
		},
		{
			// The scenario drives the module, never the screens, so without this an
			// app that does not compile passes every gate. `--dir`, not `--filter`:
			// a filter matching nothing exits zero, and that is the skip this replaces.
			name: 'app-build',
			cmd: `pnpm --dir ${projectDir}/app build`,
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/app/package.json`),
			note: 'no app/ yet',
		},
		{
			// Both halves compile alone, so an app whose every action 404s passes every other gate.
			// The route has to be registered: a comment naming the path mounts nothing. A path split
			// on a space would fail the first grep, which `!` reads as an app that never calls it.
			name: 'app-api',
			cmd: `! grep -rqF /api/invoke ${shellQuote(`${projectDir}/app/src`)} || grep -rhE '\\.post\\([[:punct:]]/api/invoke' ${shellQuote(`${projectDir}/src`)} | grep -qvE '^[[:space:]]*(//|\\*)' || { echo "app/src calls POST /api/invoke and src/ never mounts it: copy that route from the template's src/routes.ts"; exit 1; }`,
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/app/package.json`),
			note: 'no app/ yet',
		},
		// Each of these found real builds that passed every gate above. No command to run: the
		// refusal is the check, so a pass is a `true` that costs nothing.
		{
			name: 'app-components',
			cmd: 'true',
			appliesWhen: hasApp,
			note: 'no app/ yet',
			refuse: (ws) => unregisteredComponents(ws, projectDir),
		},
		{
			name: 'app-ports',
			cmd: 'true',
			appliesWhen: hasApp,
			note: 'no app/ yet',
			refuse: (ws) => portsDisagree(ws, projectDir),
		},
		{
			name: 'app-data',
			cmd: 'true',
			appliesWhen: hasApp,
			note: 'no app/ yet',
			refuse: (ws) => dataDirServed(ws, projectDir),
		},
		{
			name: 'app-starter',
			cmd: 'true',
			appliesWhen: hasApp,
			note: 'no app/ yet',
			refuse: (ws) => starterLeft(ws, projectDir),
		},
		{
			name: 'sign-in',
			cmd: 'true',
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/src/server.ts`),
			note: 'no src/server.ts yet',
			refuse: (ws) => noRealSignIn(ws, projectDir),
		},
		{
			name: 'dev-scripts',
			cmd: 'true',
			appliesWhen: pkg,
			note: 'no package.json yet',
			refuse: (ws) => scriptsRunMissingFiles(ws, projectDir),
		},
		{
			name: 'sends-email',
			cmd: 'true',
			appliesWhen: pkg,
			note: 'no package.json yet',
			refuse: (ws) => undeclaredEmail(ws, projectDir),
		},
		{
			name: 'invite-email',
			cmd: 'true',
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/src/module.ts`),
			note: 'no src/module.ts yet',
			refuse: (ws) => inviteSendsNoEmail(ws, projectDir),
		},
		{
			name: 'app-events',
			cmd: 'true',
			appliesWhen: hasApp,
			note: 'no app/ yet',
			refuse: (ws) => rowClickUnheard(ws, projectDir),
		},
		{
			name: 'app-writes',
			cmd: 'true',
			appliesWhen: hasApp,
			note: 'no app/ yet',
			refuse: (ws) => writesUnoffered(ws, projectDir),
		},
		{
			name: 'hosted-assets',
			cmd: 'true',
			appliesWhen: hasApp,
			note: 'no app/ yet',
			refuse: (ws) => appUnserved(ws, projectDir),
		},
		{
			name: 'hosted-entry',
			cmd: 'true',
			appliesWhen: pkg,
			note: 'no package.json yet',
			refuse: (ws) => entryMissing(ws, projectDir),
		},
		{
			name: 'migrations-registered',
			cmd: 'true',
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/src/module.ts`),
			note: 'no src/module.ts yet',
			refuse: (ws) => migrationsUnregistered(ws, projectDir),
		},
		{
			name: 'dev-join',
			cmd: 'true',
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/src/server.ts`),
			note: 'no src/server.ts yet',
			refuse: (ws) => devJoinMissing(ws, projectDir),
		},
		{
			name: 'hosted-join',
			cmd: 'true',
			appliesWhen: async (ws) => await ws.exists(`${projectDir}/src/worker.ts`),
			note: 'no src/worker.ts yet',
			refuse: (ws) => hostedJoinUnnamed(ws, projectDir),
		},
		{
			name: 'migration-replay',
			cmd: '',
			appliesWhen: async () => false,
			note: 'not built — specified in generated-verticals.md §6.2',
		},
	];
}

const MAX_OUTPUT = 16_000;

function trimOutput(stdout: string, stderr: string): string {
	const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
	if (combined.length <= MAX_OUTPUT) return combined;
	// Keep the tail: compilers and test runners put the useful part last.
	return `…[${combined.length - MAX_OUTPUT} chars trimmed]…\n${combined.slice(-MAX_OUTPUT)}`;
}

/**
 * What the model gate would say about `spec/model.ts` right now, as one answer the
 * generator's `check_model` tool hands the model mid-turn: the same compile the gate
 * runs and the same loader (`--check`, so nothing is written), every problem at once.
 * The gate still decides at the end of the turn; this only lets the model meet it
 * green instead of learning its rules from a repair turn.
 */
export async function checkModel(ws: Workspace, projectDir: string): Promise<string> {
	if (!(await ws.exists(`${projectDir}/spec/model.ts`))) {
		return 'NOT OK — spec/model.ts does not exist yet. Write it, then call check_model again.';
	}
	const problems: string[] = [];
	const compile = await ws.exec(modelCompileCmd(projectDir));
	if (compile.exitCode !== 0) {
		problems.push(`The compile (tsc over spec/model.ts) failed:\n${trimOutput(compile.stdout, compile.stderr)}`);
	}
	const load = await emitProjectModel(ws, projectDir, { check: true });
	if (load.status === 'failed') problems.push(`The model loader refused it:\n${load.output}`);
	const cannotLoad = load.status === 'blocked' || load.status === 'unavailable';
	if (problems.length === 0 && cannotLoad) {
		// Not the declaration's fault, and calling again will not change it: a third
		// verdict, so the model neither rewrites a correct file nor loops on the check.
		return `CANNOT CHECK — the loader could not run here (${load.status}); this is not a problem in your file. Stop calling check_model and say so; the gates judge the file at the end of your turn.${load.output ? `\n${load.output}` : ''}`;
	}
	if (cannotLoad) {
		problems.push(`The loader could not run here (${load.status}) — not a problem in your file:\n${load.output}`);
	}
	if (problems.length === 0) {
		return 'ok — spec/model.ts compiles and loads, so the model gate will pass this file.';
	}
	return `NOT OK — fix every problem below, then call check_model again:\n\n${problems.join('\n\n')}`;
}

export async function runGate(ws: Workspace, spec: GateSpec, verticalDir: string): Promise<GateResult> {
	if (spec.appliesWhen && !(await spec.appliesWhen(ws, verticalDir))) {
		return {
			name: spec.name,
			status: 'skipped',
			exitCode: 0,
			durationMs: 0,
			output: '',
			note: spec.note,
		};
	}

	const started = Date.now();
	// A check that cannot finish fails its gate: passing would vouch for what it never read, and a
	// rejection here would take every other gate's result with it.
	const refusal = await spec.refuse?.(ws, verticalDir).catch(
		(cause: unknown) => `This check could not finish: ${cause instanceof Error ? cause.message : String(cause)}`,
	);
	if (refusal) {
		return { name: spec.name, status: 'failed', exitCode: 1, durationMs: Date.now() - started, output: refusal };
	}
	const { stdout, stderr, exitCode } = await ws.exec(spec.cmd);
	const durationMs = Date.now() - started;
	const status: GateStatus =
		exitCode === 0
			? 'passed'
			: spec.exitConvention === 'substrat' && exitCode === 2
				? 'blocked'
				: 'failed';

	return { name: spec.name, status, exitCode, durationMs, output: trimOutput(stdout, stderr) };
}

/**
 * Dependency install is a HOST responsibility, not a model chore. A fresh
 * project under `.builder/projects/*` becomes a workspace member after the
 * image (or a local checkout) last ran `pnpm install`, so its `workspace:*`
 * deps resolve only after another install — and leaving that to the model by
 * prompt alone loses to the step ceiling, after which every gate fails with
 * phantom module-not-found errors. `runTurn` calls this when the turn touched
 * a package.json or the vertical has one with no node_modules. Reported as a
 * GateResult so a genuinely failed install (bad version spec, registry down)
 * reaches the model with pnpm's own output instead of as type errors.
 */
export async function runInstall(ws: Workspace, verticalDir = '.'): Promise<GateResult> {
	const started = Date.now();
	// A project with its own workspace file installs there: from an enclosing workspace pnpm
	// would judge the wrong lockfile, and report one the project's install left correct.
	const own = await ws.exists(`${verticalDir}/pnpm-workspace.yaml`);
	// The turn may have just edited package.json, so its lockfile is expected to move: refusing it
	// here costs a whole repair pass for a file the install itself writes.
	const { stdout, stderr, exitCode } = await (own
		? ws.exec('pnpm install --no-frozen-lockfile', { cwd: verticalDir })
		: ws.exec('pnpm install'));
	return {
		name: 'install',
		status: exitCode === 0 ? 'passed' : 'failed',
		exitCode,
		durationMs: Date.now() - started,
		output: trimOutput(stdout, stderr),
	};
}

export interface GateRun {
	readonly results: readonly GateResult[];
	readonly ok: boolean;
	readonly durationMs: number;
}

/**
 * What each emission means as a gate. Only the declaration's own refusal is `failed`,
 * the one status the repair loop answers: a workspace that could not run the emitter
 * is `blocked`, and a stale artifact or an absent emitter is nothing a model can fix.
 */
const MODEL_EMIT_GATE: Record<
	Exclude<ModelEmitStatus, 'absent'>,
	{ status: GateStatus; exitCode: number; note?: string }
> = {
	emitted: { status: 'passed', exitCode: 0 },
	failed: { status: 'failed', exitCode: 1 },
	blocked: { status: 'blocked', exitCode: 2 },
	stale: {
		status: 'passed',
		exitCode: 0,
		note: `${MODEL_ARTIFACT_PATH} is older than ${MODEL_SOURCE_PATH}; the next model turn re-emits it`,
	},
	unavailable: {
		status: 'skipped',
		exitCode: 0,
		note: `no ${MODEL_EMITTER_PATH} at this workspace root — the emitter is not here to run`,
	},
};

/**
 * Runs every gate. Deliberately does NOT stop at the first failure: the generator
 * fixes more per turn when it can see every complaint at once, and these are
 * cheap relative to a model call.
 */
export async function runGates(
	ws: Workspace,
	verticalDir: string,
	gates: readonly GateSpec[] = defaultGates(verticalDir),
	onResult?: (r: GateResult) => void,
	/** Reuse runTurn's emission; direct rechecks validate without writing the artifact. */
	emittedModel?: ModelEmitResult,
): Promise<GateRun> {
	const started = Date.now();
	const results: GateResult[] = [];
	const model = emittedModel ?? await emitProjectModel(ws, verticalDir, { check: true });
	if (model.status !== 'absent') {
		const result: GateResult = {
			name: 'model-emit',
			...MODEL_EMIT_GATE[model.status],
			durationMs: Date.now() - started,
			output: model.output,
		};
		results.push(result);
		onResult?.(result);
	}
	// The migrations come from the same model, so they are judged only when it loaded: a model
	// that will not emit is the model-emit gate's to report, once.
	const migrations = model.status === 'emitted' ? await emitProjectMigrations(ws, verticalDir, { check: true }) : null;
	if (migrations && migrations.status !== 'absent' && migrations.status !== 'unavailable') {
		const result: GateResult = {
			name: 'migrations-emit',
			...(migrations.status === 'stale' ? { status: 'passed' as const, exitCode: 0 } : MODEL_EMIT_GATE[migrations.status]),
			durationMs: 0,
			output: migrations.output,
		};
		results.push(result);
		onResult?.(result);
	}
	for (const spec of gates) {
		const result = await runGate(ws, spec, verticalDir);
		results.push(result);
		onResult?.(result);
	}
	return {
		results,
		ok: results.every((r) => r.status === 'passed' || r.status === 'skipped'),
		durationMs: Date.now() - started,
	};
}

// ── feeding the oracle back to the model (builder-harness.md H5) ─────────────
//
// The gates run at turn end, but their verdict must not die in the UI: the
// model is the only party who can act on a red typecheck, and the studio's
// audience (a non-technical builder) can do nothing with raw lint output. Two
// consumers share these helpers, and the POLICY lives here — above the seam —
// so the server and the dev CLI cannot drift:
//
//   1. `gateReport(run)` — the model-facing report of a red run, carried into
//      the NEXT turn's volatile context (rides with the workspace brief).
//   2. `gateRepairPrompt(run, n, max)` — the host-authored message that drives
//      an in-turn repair attempt. Recorded in the durable history verbatim, so
//      the transcript stays truthful about who said what.

/**
 * Ceiling on host-driven repair attempts per turn. Every attempt is a full
 * billable model run, so this cap is a billing control as much as a safety
 * one — after it, the red state is surfaced honestly instead of silently
 * burning the builder's budget (aider caps its edit reflections at 3 for the
 * same reason).
 */
export const MAX_GATE_REPAIRS = 2;

/**
 * True when a repair attempt could help: at least one gate FAILED. `blocked`
 * (exit 2) is deliberately excluded — it means the checker could not do its
 * job, and asking the model to "fix" that trains it to fix the wrong thing
 * (same reasoning as the status split above).
 */
export function repairNeeded(run: GateRun): boolean {
	return run.results.some((r) => r.status === 'failed');
}

/**
 * Ceiling on host-driven continuation passes per turn (builder-harness.md H6).
 * A pass that ends `truncated` was cut by the step ceiling mid-work — that is
 * "not done yet", not "done but broken", so the host continues it BEFORE the
 * gates run. Without this, a big scaffold spends the whole repair budget on
 * mere continuation (the gates go red on incompleteness, and the repair
 * prompt's "fix the failures" framing derails the model's own plan). Shared
 * with MAX_GATE_REPAIRS the same billing logic: every pass is a full model
 * run, so the cap is per TURN, not per pass.
 */
export const MAX_CONTINUATIONS = 2;

/**
 * The host-authored message driving one continuation pass. Kept here so all
 * run modes send byte-identical instructions (same reasoning as
 * `gateRepairPrompt`).
 */
export function continuationPrompt(attempt: number, maxAttempts: number): string {
	return [
		`[studio] Your last pass hit the step ceiling and was cut off mid-work (continuation ${attempt}/${maxAttempts}).`,
		'Pick up exactly where you left off and finish the remaining work. Do not start over, do not ' +
			're-plan, and do not re-read files you already wrote this turn. If everything you intended ' +
			'is in fact complete, say so briefly and stop.',
	].join('\n\n');
}

/** Per-failure output shown to the model. The tail is where compilers point. */
const REPORT_OUTPUT_CAP = 4_000;

/**
 * Gates whose failure is DRIFT of a committed golden file, not broken code.
 * The fix is regenerating the artifact — after which the diff is a
 * needs-review event for the human (builder-studio §9.1), never something to
 * hand-edit until the checker goes quiet.
 */
const DRIFT_HINTS: Partial<Record<GateName, string>> = {
	permissions:
		'this gate compares committed PERMISSIONS.md against MODULES + ROLES — regenerate it ' +
		'(pnpm lint:permissions, without --check) instead of hand-editing; the resulting diff ' +
		'goes to human review',
	api:
		'this gate compares the committed API document against the operation catalog — regenerate ' +
		'it (pnpm lint:api, without --check) instead of hand-editing; the resulting diff goes to ' +
		'human review',
};

/**
 * The model-facing report of a red gate run, or null when there is nothing a
 * model should act on (all green/skipped, or only blocked). Failed gates carry
 * their trimmed output; blocked gates are listed as facts with an explicit
 * do-not-fix note.
 */
export function gateReport(run: GateRun): string | null {
	const failed = run.results.filter((r) => r.status === 'failed');
	if (failed.length === 0) return null;
	const blocked = run.results.filter((r) => r.status === 'blocked');
	const sections = failed.map((r) => {
		const hint = DRIFT_HINTS[r.name];
		const output =
			r.output.length > REPORT_OUTPUT_CAP
				? `…[${r.output.length - REPORT_OUTPUT_CAP} chars trimmed]…\n${r.output.slice(-REPORT_OUTPUT_CAP)}`
				: r.output;
		return [
			`── ${r.name} FAILED (exit ${r.exitCode})${hint ? ` — ${hint}` : ''}`,
			output || '(no output)',
		].join('\n');
	});
	if (blocked.length) {
		sections.push(
			`── blocked (the checker could not run — this is NOT a code problem; do not try to fix it): ` +
				blocked.map((r) => r.name).join(', '),
		);
	}
	return sections.join('\n\n');
}

/**
 * The host-authored message driving one repair attempt. Kept in one place so
 * both run modes send byte-identical instructions.
 */
export function gateRepairPrompt(run: GateRun, attempt: number, maxAttempts: number): string {
	return [
		`[studio] The tier-1 gates ran after your changes and are RED (repair attempt ${attempt}/${maxAttempts}).`,
		gateReport(run) ?? '(no failing gates — nothing to repair)',
		'Fix the failures above now. The gates are the oracle, not your own judgement: change the ' +
			'code until they pass, do not argue with them and do not weaken or delete tests to get ' +
			'green. If a failure is golden-file drift, regenerate the artifact as its hint says.',
	].join('\n\n');
}

/** One-line-per-gate summary for a terminal or a chat pane. */
export function formatGateRun(run: GateRun): string {
	const glyph: Record<GateStatus, string> = {
		passed: '✓',
		failed: '✗',
		blocked: '!',
		skipped: '–',
	};
	const lines = run.results.map((r) => {
		const time = r.status === 'skipped' ? '' : ` (${(r.durationMs / 1000).toFixed(1)}s)`;
		const suffix = r.note ? `  ${r.note}` : '';
		return `  ${glyph[r.status]} ${r.name.padEnd(18)}${time}${suffix}`;
	});
	return `${lines.join('\n')}\n  ${run.ok ? 'all gates green' : 'GATES RED'} in ${(run.durationMs / 1000).toFixed(1)}s`;
}
