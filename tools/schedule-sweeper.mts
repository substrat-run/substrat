/**
 * A deployable vertical that declares schedules has a sweeper to run them on a hosted deploy.
 *
 * #1902 changed what that asks of a vertical. The uploader now supplies the sweeper —
 * `SweeperDO` bound as `SWEEPER`, from the platform's generated module — to a vertical whose
 * entry exports none, and `mountPlatformSurface` hands it the vertical's host and keeps its
 * roster. So "no sweeper" is no longer the offence. What still is (`sweeperOffence` in
 * `@substrat-run/cli`): an own sweeper nothing binds, the platform's names bound to something
 * else (the upload would refuse), and a `@substrat-run/vertical-host` too old to register the
 * host — which in this workspace means an unbuilt one. The history below is why the gate
 * exists at all; its two halves now hold an OWN sweeper, and a vertical with none passes.
 *
 * #1646: the only platform timer is the control plane's 15-minute cron, and it iterates
 * `host.registeredSchedules()` on the CONTROL PLANE'S OWN host — which registers no
 * modules ("the module-less placeholder"). A pushed, control-plane-less vertical has to
 * bring its own timer, per `docs/architecture/scheduler.md` §3.3: a `SweeperDO` singleton
 * whose roster the platform fills via `/internal/provision` → `noteScope`. ticket0 and
 * meridian shipped `manifest.schedules` with no such wiring, and nothing ever raised an
 * error, because nothing ever tried — an "unfalsifiable zero" (#461) the same way an
 * unmounted `invocationLog()` is (`tools/invocation-log.mjs`): no scenario suite drives
 * the deployed worker entry, so only a source check can catch the gap before a hosted
 * scope silently never sweeps.
 *
 * ## Why this loads the module registrations rather than grepping declared schedules
 *
 * A vertical's OWN manifest is not the whole story: an engine composed into it can
 * declare schedules of its own, and the vertical's source never mentions them by name.
 * `demos/meridian` is the worked example — `grep schedules demos/meridian/src` finds
 * nothing, because the one schedule meridian ships (`absence/expire-stale`) is declared
 * on `engines/absence/src/index.ts`'s manifest and reaches meridian only by being in its
 * `MODULES` array (`src/provision.ts`). A text rule that reads only the vertical's own
 * files would call meridian clean. So this loads the SAME `MODULES` the running host
 * registers — the way `tools/permission-diff.mts` already does for the permission
 * checkpoint — and walks every module's `manifest.schedules`, composed or not.
 *
 * ## Scope
 *
 * The same deployable-vertical definition `tools/invocation-log.mjs` uses: a package
 * under `demos/`, `engines/` or `apps/` that declares `substrat.slug` in package.json AND
 * ships `src/worker.ts` (the entry the router dispatches to), plus the scaffold template
 * named directly (it is not a workspace member, so no package.json sweep finds it). A
 * local-only demo with a `server.ts` harness and no worker entry runs with no router in
 * front of it and is out of scope for the same reason invocation-log excludes it: no
 * request ever carries an asserted tenant there, so "does this wire a sweeper" is not yet
 * a meaningful question.
 *
 * ## What "wires a sweeper" means, mechanically — two halves, both required
 *
 * A `grep defineScopeSweeperDO` first cut passed an UNEXPORTED
 * `const SweeperDO = defineScopeSweeperDO(...)`: workerd resolves a Durable Object class
 * from the ENTRY MODULE'S EXPORTS, so a call sitting in a local const with no export
 * binds nothing — the schedules stay exactly as dead as with no call at all, and the
 * gate would have said otherwise (Copilot review on #1873, finding 4117108901).
 *
 * So this checks two things, both load-bearing:
 *
 *   1. `src/worker.ts` EXPORTS an identifier bound to `defineScopeSweeperDO(...)` — a
 *      direct `export const X = defineScopeSweeperDO(…)`, an `export class X extends
 *      defineScopeSweeperDO(…) {}`, or a plain `const X = defineScopeSweeperDO(…)`
 *      re-exported by name or alias (`export { X }` / `export { X as Y }` — the alias
 *      is what workerd actually sees, so it is the alias that has to match the binding).
 *      The reader is `@substrat-run/cli`'s (`exportedSweeperNamesOf`, Babel-parsed), shared
 *      with `substrat push`'s own refusal of the same shape for a vertical outside this repo
 *      (#1646) — so it also follows a relative re-export (`export { X } from './sweeper.js'`)
 *      rather than refusing a sweeper kept in a module of its own. Built output, like
 *      `tools/invocation-log.mjs`'s import of boundary-lint: run `pnpm build` first.
 *   2. The vertical's DEPLOY CONFIG binds a Durable Object class under one of those
 *      exported names — read from whichever vocabulary the vertical uses: a committed
 *      `wrangler.jsonc`'s `durable_objects.bindings[].class_name` (meridian, manyfold,
 *      auth-server), or `package.json`'s `substrat.runtimeNeeds.stores[].class` (ticket0,
 *      the template) — `substrat push` derives the deploy config from the latter, so
 *      there is no wrangler.jsonc to read for a `runtimeNeeds` vertical at all. An export
 *      with no binding in EITHER vocabulary compiles, deploys even, and never fires: the
 *      class exists in the bundle but Cloudflare never instantiates it. Where a class is
 *      exported but not bound is exactly as dead as where it is bound but not exported —
 *      this refuses both directions.
 *
 * This still does not check that the sweeper's ROSTER is ever populated
 * (`noteScope`/`forgetScope` from `onProvision`/delete-scope) — that half is runtime
 * wiring no static check can see, and is why the issue keeps a production check open
 * rather than asking this gate to close it.
 *
 * Exit codes follow permission-diff's: 0 = fine, 1 = a deployable vertical would ship
 * schedules its wiring leaves unrun, 2 = the tool could not do its job (never a silent
 * pass over nothing).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  exportedSweeperNames,
  exportedSweeperNamesOf,
  platformCanSupplySweeper,
  sweeperOffence,
  type ScheduleRef,
  type SweeperWiring,
} from '../packages/cli/dist/schedule-sweeper.js';
import { syncTemplate } from './template-sync.mjs';

// Structural shapes only — deliberately not imported from the kernel or contracts, the
// same call `tools/permission-diff.mts` makes: depending on the packages this tool
// inspects would be a cycle, and all it needs are a few fields.
interface ScheduleLike {
  operation: string;
}
interface ModuleLike {
  manifest: {
    id: string;
    schedules?: ScheduleLike[];
  };
}
interface PermissionsLike {
  modules?: ModuleLike[];
}
interface VerticalModule {
  permissions?: PermissionsLike;
}

/** Where verticals live. The template is not a workspace member, so it is named directly. */
const ROOTS = ['demos', 'engines', 'apps'];
const TEMPLATE = 'packages/create-substrat/template';
/**
 * The template has no committed package.json (`npm create substrat` writes one from a
 * string literal in `packages/create-substrat/index.js`), so its declared permissions
 * entry — and its declared store bindings — cannot be read off disk the way every other
 * vertical's can. Both literals live in that one file, so both are named directly here,
 * the same way invocation-log hardcodes the template's inclusion instead of deriving it
 * from a `substrat.slug` that does not exist yet either.
 *
 * The template is also not a workspace member (#797, deliberately: its job is to prove an
 * npm install with no workspace links), so `@substrat-run/*` does not resolve from its raw
 * directory. `tools/template-sync.mjs` materializes it into `packages/template-check`,
 * which owns those links (#878) — the same call every `pnpm -r typecheck`/`test` reach on
 * this file makes first. This tool makes the identical call before importing.
 */
const TEMPLATE_PERMISSIONS_ENTRY = 'src/provision.ts';
/** The `substrat.runtimeNeeds.stores` literal `packages/create-substrat/index.js` writes. */
const TEMPLATE_STORES = [
  { binding: 'SCOPE', class: 'ScopeDO' },
  { binding: 'CONFIG', class: 'ConfigDO' },
];

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`schedule-sweeper: ${message}\n`);
  process.exit(2);
}

export type { ScheduleRef, SweeperWiring };

/**
 * The predicate and the export reader live in `@substrat-run/cli` (`src/schedule-sweeper.ts`),
 * because `substrat push` makes the same check for a vertical outside this repo (#1646) and
 * the two gates must not disagree about what "wires a sweeper" means. Re-exported under the
 * names this tool's tests have always used.
 */
export const parseExportedSweeperNames = exportedSweeperNames;
export const offense = sweeperOffence;

/**
 * `class_name`s a committed `wrangler.jsonc` binds as a Durable Object — JSONC-tolerant
 * (block/line comments blanked, same string-aware scan `tools/wrangler-config-check.mjs`
 * uses, so a `//` inside a quoted value is never mistaken for a comment), trailing commas
 * stripped, then `JSON.parse`d. Returns `[]` for a config with no `durable_objects` block
 * rather than treating that as a parse failure — plenty of wrangler configs bind none.
 */
export function parseWranglerBindingClasses(text: string): string[] {
  return parseWranglerBindings(text)
    .map((b) => b.class_name)
    .filter((c): c is string => Boolean(c));
}

/** Every Durable Object binding a committed `wrangler.jsonc` declares, name and class. */
export function parseWranglerBindings(text: string): { name?: string; class_name?: string }[] {
  let stripped = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      stripped += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      stripped += ' '.repeat(stop - i);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      stripped += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      stripped += ch;
      i += 1;
    }
  }
  // Wrangler (and JSONC generally) tolerates a trailing comma before `}`/`]`; JSON.parse
  // does not. Repeated because stripping one can expose another one level up.
  let noTrailingCommas = stripped;
  let prev: string;
  do {
    prev = noTrailingCommas;
    noTrailingCommas = noTrailingCommas.replace(/,(\s*[}\]])/g, '$1');
  } while (noTrailingCommas !== prev);

  let parsed: { durable_objects?: { bindings?: { name?: string; class_name?: string }[] } };
  try {
    parsed = JSON.parse(noTrailingCommas);
  } catch (e) {
    throw new Error(`could not parse wrangler config as JSONC: ${(e as Error).message}`);
  }
  return parsed.durable_objects?.bindings ?? [];
}

interface Deployable {
  dir: string;
  permissionsEntry: string;
  /** `substrat.runtimeNeeds.stores`, or `[]` for a vertical using wrangler.jsonc. */
  stores: { binding?: string; class?: string }[];
}

/** Every directory that declares a vertical slug and ships a worker entry, plus the template. */
export function deployables(): Deployable[] {
  const found: Deployable[] = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      if (!statSync(dir).isDirectory()) continue;
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath) || !existsSync(join(dir, 'src', 'worker.ts'))) continue;
      let pkg: {
        substrat?: {
          slug?: string;
          permissions?: string;
          runtimeNeeds?: { stores?: { binding?: string; class?: string }[] };
        };
      };
      try {
        pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        continue;
      }
      if (!pkg.substrat?.slug) continue;
      const permissionsEntry = pkg.substrat.permissions;
      if (typeof permissionsEntry !== 'string' || permissionsEntry.trim() === '') {
        cannot(
          `${dir} is a deployable vertical (declares substrat.slug and ships src/worker.ts)\n` +
            `  but declares no \`substrat.permissions\` in package.json — without it this tool\n` +
            `  cannot load the module registrations that would tell it whether a schedule is\n` +
            `  declared, and skipping it would be a green light over a surface nobody checked.\n` +
            `  Remedy: add \`"substrat": { "permissions": "src/provision.ts" }\`. See demos/ticket0.`,
        );
      }
      found.push({ dir, permissionsEntry, stores: pkg.substrat.runtimeNeeds?.stores ?? [] });
    }
  }
  if (existsSync(join(TEMPLATE, 'src', 'worker.ts'))) {
    // Materialized here, not deferred to the loop below, so a template with no `src`
    // (syncTemplate's own failure mode) is exit 2 before any offense is collected —
    // the same "cannot do its job" distinction every other early exit in this file draws.
    const checkDir = syncTemplate();
    found.push({ dir: checkDir, permissionsEntry: TEMPLATE_PERMISSIONS_ENTRY, stores: TEMPLATE_STORES });
  }
  return found;
}

async function main() {
  // The predicate has to be able to tell its own cases apart, or a green run means
  // nothing. Same guard `invocation-log.mjs`'s SELF_TEST carries, for the same reason.
  const SELF_TEST: [ScheduleRef[], SweeperWiring, boolean][] = [
    [[{ moduleId: 'm', operation: 'm/op' }], { exportedNames: ['SweeperDO'], boundClassNames: ['SweeperDO'] }, false],
    // #1902: no export at all is the platform's to supply…
    [[{ moduleId: 'm', operation: 'm/op' }], { exportedNames: [], boundClassNames: [], platformCanSupply: true }, false],
    // …unless the vertical-host cannot hand it a host, or its names are taken.
    [[{ moduleId: 'm', operation: 'm/op' }], { exportedNames: [], boundClassNames: [], platformCanSupply: false }, true],
    [[{ moduleId: 'm', operation: 'm/op' }], { exportedNames: [], boundClassNames: ['SweeperDO'] }, true],
    [[{ moduleId: 'm', operation: 'm/op' }], { exportedNames: [], boundClassNames: ['X'], boundBindingNames: ['SWEEPER'] }, true],
    [[{ moduleId: 'm', operation: 'm/op' }], { exportedNames: ['SweeperDO'], boundClassNames: ['ScopeDO'] }, true], // exported, unbound
    [[], { exportedNames: [], boundClassNames: [] }, false], // no schedules, nothing owed
  ];
  const drift = SELF_TEST.filter(([schedules, wiring, shouldOffend]) => Boolean(offense(schedules, wiring)) !== shouldOffend);
  if (drift.length > 0) {
    console.error('schedule-sweeper: the predicate no longer tells its own cases apart:');
    for (const [schedules, wiring] of drift) console.error(`  ${JSON.stringify({ schedules, wiring })} -> ${offense(schedules, wiring)}`);
    process.exit(2);
  }
  // The parser has an identical self-check obligation: it decides EXPORTED, which is the
  // whole fix, so its own drift would silently undo the fix it exists to make.
  const PARSE_SELF_TEST: [string, string[]][] = [
    ["import { defineScopeSweeperDO } from 'x';\nexport const SweeperDO = defineScopeSweeperDO<Env>({});\n", ['SweeperDO']],
    ["import { defineScopeSweeperDO } from 'x';\nconst SweeperDO = defineScopeSweeperDO({});\n", []], // unexported
    [
      "import { defineScopeSweeperDO } from 'x';\nconst Foo = defineScopeSweeperDO({});\nexport { Foo as SweeperDO };\n",
      ['SweeperDO'],
    ], // aliased re-export — the ALIAS is the name that must match a binding
    ['export const ScopeDO = defineScopeDO(MODULES, {});\n', []], // unrelated export, not a sweeper
  ];
  const parseDrift = PARSE_SELF_TEST.filter(([src, want]) => {
    const got = parseExportedSweeperNames(src).sort();
    return JSON.stringify(got) !== JSON.stringify([...want].sort());
  });
  if (parseDrift.length > 0) {
    console.error('schedule-sweeper: the export parser no longer tells its own cases apart:');
    for (const [src] of parseDrift) console.error(`  ${JSON.stringify(src)} -> ${JSON.stringify(parseExportedSweeperNames(src))}`);
    process.exit(2);
  }

  const dirs = deployables();
  if (dirs.length === 0) {
    console.error('schedule-sweeper: found no deployable vertical — the check would pass by scanning nothing.');
    process.exit(2);
  }

  const offenders: string[] = [];
  let checked = 0;
  for (const { dir, permissionsEntry, stores } of dirs) {
    checked++;
    const entryPath = join(dir, permissionsEntry);
    if (!existsSync(entryPath)) {
      cannot(
        `${dir} declares \`substrat.permissions: ${JSON.stringify(permissionsEntry)}\` but ${entryPath}\n` +
          `  does not exist.`,
      );
    }
    let mod: VerticalModule;
    try {
      mod = (await import(pathToFileURL(entryPath).href)) as VerticalModule;
    } catch (e) {
      cannot(`${entryPath} failed to import: ${(e as Error).message}\n  Run \`pnpm build\` first.`);
    }
    const modules = mod.permissions?.modules;
    if (!modules) {
      cannot(
        `${entryPath} exports no \`permissions\` (a definePermissions() result) — this tool\n` +
          `  cannot see this vertical's declared schedules and would pass over a surface\n` +
          `  nobody checked.`,
      );
    }
    const schedules: ScheduleRef[] = [];
    for (const m of modules) {
      for (const s of m.manifest.schedules ?? []) {
        schedules.push({ moduleId: m.manifest.id, operation: s.operation });
      }
    }

    const workerPath = join(dir, 'src', 'worker.ts');
    const exportedNames = exportedSweeperNamesOf(workerPath);

    const wranglerPath = join(dir, 'wrangler.jsonc');
    const bound = stores.map((s) => ({ name: s.binding, class_name: s.class }));
    if (existsSync(wranglerPath)) {
      try {
        bound.push(...parseWranglerBindings(readFileSync(wranglerPath, 'utf8')));
      } catch (e) {
        cannot(`${wranglerPath}: ${(e as Error).message}`);
      }
    }
    const present = (xs: (string | undefined)[]) => xs.filter((x): x is string => Boolean(x));

    const why = offense(schedules, {
      exportedNames,
      boundClassNames: present(bound.map((b) => b.class_name)),
      boundBindingNames: present(bound.map((b) => b.name)),
      // The workspace's own vertical-host, resolved from the vertical as a push would.
      platformCanSupply: platformCanSupplySweeper(dir),
    });
    if (why) offenders.push(`${workerPath}: ${why}`);
  }

  if (offenders.length > 0) {
    console.error(
      'schedule-sweeper: a vertical declares recurring work its wiring would leave unrun on a hosted deploy.',
    );
    for (const o of offenders) console.error(`  ${o}`);
    process.exit(1);
  }
  console.log(`schedule-sweeper: ok (${checked} deployable vertical(s) checked)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
