/**
 * A vertical's workerd suite config, as the platform UPLOADS the vertical (#1902) rather than
 * as its source declares it.
 *
 * Since #1902 a vertical that declares schedules and exports no sweeper is given one at
 * upload: the control plane's `withPlatformEntry` adds the platform's entry module, the
 * sweeper module it re-exports from, the `SWEEPER` binding and the class's migration. A suite
 * that ran `src/worker.ts` as its main module would run a worker with no timer at all, which
 * is not what production runs. So this takes the producers themselves — the CLI's
 * `deriveDeclaredSurface` and `sweeperClassesOf` (what the push declares), control-plane-api's
 * `platformSweeperDecision` (what the push route decides from it) and `withPlatformEntry`
 * (what the uploader then does) — applies them to the derived
 * wrangler config, writes the platform's modules beside it, and points `main` at the
 * platform's entry. Built output, like every other caller of those packages from a config:
 * run `pnpm build` first.
 *
 *   const cfg = await asUploaded(here, derived);
 *
 * The modules go to `<dir>/.workerd-uploaded/` (gitignored), not under `node_modules`: the
 * workers pool does not transform an import made from a module in there, so the entry's
 * import of the vertical's TypeScript would never resolve.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { deriveDeclaredSurface, sweeperClassesOf } from '../packages/cli/dist/push.js';
import { platformSweeperDecision, withPlatformEntry } from '../packages/control-plane-api/dist/platform-entry.js';

/**
 * What a push of `dir` declares about its sweeper (#1902): the schedules its modules declare
 * (`deriveDeclaredSurface`, which bundles and imports the permission entry) and the sweeper
 * classes its entry exports — memoized per directory, since that build is the slow part.
 *
 * @param {string} dir  the vertical's directory
 * @param {Record<string, any>} cfg  its deploy config
 */
export function declaredSweeper(dir, cfg) {
  let found = memo.get(dir);
  if (!found) {
    found = deriveDeclaredSurface(dir).then(({ schedules }) => ({ schedules, sweeperClasses: sweeperClassesOf(dir, cfg) }));
    memo.set(dir, found);
  }
  return found;
}
const memo = new Map();

/**
 * @param {string} dir  the vertical's directory
 * @param {Record<string, any>} derived  its wrangler config, as `resolveWranglerConfig` derived it
 * @returns {Promise<Record<string, any>>} the config to hand the workers pool
 */
export async function asUploaded(dir, derived) {
  const cacheDir = join(dir, '.workerd-uploaded');
  mkdirSync(cacheDir, { recursive: true });
  const main = resolve(dir, String(derived.main));
  const { schedules, sweeperClasses } = await declaredSweeper(dir, derived);
  const doBindings = derived.durable_objects?.bindings ?? [];
  const migrations = derived.migrations ?? [];
  // The vertical's entry, named by its path from where the platform's modules are written —
  // the uploader names it by its path from the script root, and the entry imports it so.
  const entry = relative(cacheDir, main).split('\\').join('/');
  const modules = [{ name: entry, content: new Uint8Array(), contentType: 'application/javascript+module' }];
  const bindings = doBindings.map((b) => ({ type: 'durable_object_namespace', name: b.name, class_name: b.class_name }));
  // The decision the control plane makes once, at push, from the same declaration.
  const decision = platformSweeperDecision({ schedules, bindings, ...(sweeperClasses ? { sweeperClasses } : {}) }, { entry, modules });
  if ('refuse' in decision) throw new Error(`the control plane would refuse this push: ${decision.refuse}`);
  const uploaded = withPlatformEntry({
    entry,
    modules,
    doClasses: migrations.flatMap((m) => m.new_sqlite_classes ?? []),
    bindings,
    supplySweeper: decision.supply,
  });
  for (const m of uploaded.modules) {
    if (m.name !== entry) writeFileSync(join(cacheDir, m.name), m.content);
  }
  const added = uploaded.bindings.slice(doBindings.length);
  const declared = new Set(migrations.flatMap((m) => m.new_sqlite_classes ?? []));
  const newClasses = uploaded.doClasses.filter((c) => !declared.has(c));
  return {
    ...derived,
    main: join(cacheDir, uploaded.entry),
    durable_objects: {
      bindings: [
        ...doBindings,
        ...added.filter((b) => b.type === 'durable_object_namespace').map((b) => ({ name: b.name, class_name: b.class_name })),
      ],
    },
    migrations: newClasses.length
      ? [...migrations, { tag: `platform-${migrations.length + 1}`, new_sqlite_classes: newClasses }]
      : migrations,
    vars: {
      ...(derived.vars ?? {}),
      ...Object.fromEntries(added.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text])),
    },
  };
}
