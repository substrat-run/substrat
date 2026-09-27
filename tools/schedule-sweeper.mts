/**
 * A deployable vertical that declares schedules wires `defineScopeSweeperDO`, or those
 * schedules never fire.
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
 * ## What "wires a sweeper" means, mechanically
 *
 * A text check on `src/worker.ts` for `defineScopeSweeperDO` — the same spirit as
 * invocation-log's order check on the same file: loud and source-level rather than an AST
 * walk, because a false positive here is cheap to see and a false negative is a silently
 * dead timer in production. It does not check that the sweeper's roster is ever
 * populated (`noteScope`/`forgetScope` from `onProvision`/delete-scope) — that half is
 * runtime wiring this gate cannot see from source, and is why the issue keeps a
 * production check open rather than asking this gate to close it.
 *
 * Exit codes follow permission-diff's: 0 = fine, 1 = a deployable vertical would ship
 * schedules with nothing to run them, 2 = the tool could not do its job (never a silent
 * pass over nothing).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
 * entry cannot be read off disk the way every other vertical's can. That literal always
 * points here — it is the one place a scaffolded project's `substrat.permissions` comes
 * from — so it is named directly, the same way invocation-log hardcodes the template's
 * inclusion instead of deriving it from a `substrat.slug` that does not exist yet either.
 *
 * The template is also not a workspace member (#797, deliberately: its job is to prove an
 * npm install with no workspace links), so `@substrat-run/*` does not resolve from its raw
 * directory. `tools/template-sync.mjs` materializes it into `packages/template-check`,
 * which owns those links (#878) — the same call every `pnpm -r typecheck`/`test` reach on
 * this file makes first. This tool makes the identical call before importing.
 */
const TEMPLATE_PERMISSIONS_ENTRY = 'src/provision.ts';

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`schedule-sweeper: ${message}\n`);
  process.exit(2);
}

/** The mount we require on the deployed worker entry — text, not an AST. */
export const WIRES_SWEEPER = /defineScopeSweeperDO\s*[<(]/;

export interface ScheduleRef {
  moduleId: string;
  operation: string;
}

/**
 * The offense in one vertical, or `null` when it is fine — the pure predicate under the
 * CLI's file discovery and dynamic import, so it can be unit-tested without a build.
 * No schedules declared means no sweeper is owed, whatever the worker source says.
 */
export function offense(schedules: ScheduleRef[], workerSource: string): string | null {
  if (schedules.length === 0) return null;
  if (WIRES_SWEEPER.test(workerSource)) return null;
  const named = schedules.map((s) => `${s.moduleId} → ${s.operation}`).join(', ');
  return (
    `declares schedules with no sweeper to run them (${named}). On a pushed deploy the ` +
    `control plane's own cron reaches no module — a CP-less vertical brings its own timer. ` +
    `Wire \`defineScopeSweeperDO\` (see demos/ticket0/src/worker.ts).`
  );
}

interface Deployable {
  dir: string;
  permissionsEntry: string;
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
      let pkg: { substrat?: { slug?: string; permissions?: string } };
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
      found.push({ dir, permissionsEntry });
    }
  }
  if (existsSync(join(TEMPLATE, 'src', 'worker.ts'))) {
    // Materialized here, not deferred to the loop below, so a template with no `src`
    // (syncTemplate's own failure mode) is exit 2 before any offense is collected —
    // the same "cannot do its job" distinction every other early exit in this file draws.
    const checkDir = syncTemplate();
    found.push({ dir: checkDir, permissionsEntry: TEMPLATE_PERMISSIONS_ENTRY });
  }
  return found;
}

async function main() {
  // The predicate has to be able to tell its own cases apart, or a green run means
  // nothing. Same guard `invocation-log.mjs`'s SELF_TEST carries, for the same reason.
  const SELF_TEST: [ScheduleRef[], string, boolean][] = [
    [
      [{ moduleId: 'm', operation: 'm/op' }],
      'export const SweeperDO = defineScopeSweeperDO<Env>({\n  intervalMs: 120_000,\n});',
      false,
    ],
    [[{ moduleId: 'm', operation: 'm/op' }], 'export const ScopeDO = defineScopeDO(MODULES, {});', true],
    [[], 'export const ScopeDO = defineScopeDO(MODULES, {});', false], // no schedules, no sweeper owed
  ];
  const drift = SELF_TEST.filter(([schedules, src, shouldOffend]) => Boolean(offense(schedules, src)) !== shouldOffend);
  if (drift.length > 0) {
    console.error('schedule-sweeper: the predicate no longer tells its own cases apart:');
    for (const [schedules, src] of drift) console.error(`  ${JSON.stringify({ schedules, src })} -> ${offense(schedules, src)}`);
    process.exit(2);
  }

  const dirs = deployables();
  if (dirs.length === 0) {
    console.error('schedule-sweeper: found no deployable vertical — the check would pass by scanning nothing.');
    process.exit(2);
  }

  const offenders: string[] = [];
  let checked = 0;
  for (const { dir, permissionsEntry } of dirs) {
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
    const worker = readFileSync(workerPath, 'utf8');
    const why = offense(schedules, worker);
    if (why) offenders.push(`${workerPath}: ${why}`);
  }

  if (offenders.length > 0) {
    console.error(
      'schedule-sweeper: a vertical declares recurring work that nothing will ever run on a hosted deploy.',
    );
    for (const o of offenders) console.error(`  ${o}`);
    process.exit(1);
  }
  console.log(`schedule-sweeper: ok (${checked} deployable vertical(s) checked)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
