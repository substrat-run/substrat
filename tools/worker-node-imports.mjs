#!/usr/bin/env node
/**
 * A worker imports no node builtin its compatibility flags do not give it (#2245).
 *
 * workerd resolves `node:async_hooks` only under `nodejs_als` or `nodejs_compat`, and every
 * other `node:*` module only under `nodejs_compat`. Without the flag a bundle that imports one
 * builds, uploads, and then fails to start: `No such module "node:async_hooks"`. A node suite
 * cannot see that, because node has every module, and a workerd suite may run under its own
 * flags. An import in a shared package (vertical-host's invocation log, which every
 * deployed vertical and the dashboard bundle) breaks every flagless worker at once — the
 * dashboard's deploy in a release would fail after the control plane and the router had already
 * shipped.
 *
 * So this bundles each worker under workerd conditions and refuses reachable static and
 * dynamic imports of a builtin its flags do not give it, including guarded imports. The
 * shared rule lives in the CLI, which also runs it before upload. The platform entry the
 * control plane puts in front of a pushed vertical is not part of any bundle here; the
 * uploader adds `nodejs_als` for it (`withPlatformEntry`).
 *
 * The workers: every tracked `wrangler.jsonc` with a `main`, every vertical whose package.json
 * declares `substrat.runtimeNeeds` (its config derived the way `substrat push` derives it), and
 * the scaffold template, materialized into `packages/template-check` first.
 *
 *   pnpm lint:worker-node-imports
 *   pnpm test:worker-node-imports     the rule, on fixtures
 *
 * Needs the build (`packages/cli/dist`), like every tool that derives a push's config.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliDist = join(ROOT, 'packages/cli/dist');
if (!existsSync(join(cliDist, 'worker-node-imports.js')) || !existsSync(join(cliDist, 'push.js'))) {
  throw new Error('CLI build is missing; run `pnpm --filter @substrat-run/cli... build` before running this tool.');
}
const { builtinsAllowedBy, refusedBuiltins, workerNodeImportOffence } = await import(pathToFileURL(join(cliDist, 'worker-node-imports.js')).href);

/** Directories holding a worker: tracked wrangler configs, and verticals declaring runtime needs. */
function workerDirs() {
  const tracked = execFileSync('git', ['ls-files', '*wrangler.jsonc', '*package.json'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p && !p.startsWith('spikes/') && !p.includes('node_modules/'));
  return [...new Set(tracked.map((p) => dirname(p)))].sort();
}

/** The scaffold's runtime needs, as `packages/create-substrat/index.js` writes them: no node flag. */
const TEMPLATE = { main: 'src/worker.ts', compatibility_flags: [] };

async function main() {
  // Loaded here, not at the top, so the unit test of the rule above needs no build.
  const { experimental_readRawConfig } = await import('wrangler');
  const { readRuntimeNeeds, wranglerConfigFor } = await import('../packages/cli/dist/push.js');
  const { CHECK_DIR, syncTemplate } = await import('./template-sync.mjs');

  /**
   * The config a deploy of `dir` builds with: `substrat.runtimeNeeds` wins, derived the way
   * `substrat push` derives it; otherwise the hand-authored `wrangler.jsonc`, read by wrangler.
   */
  const deployConfigOf = (abs) => {
    const needs = readRuntimeNeeds(abs);
    if (needs) return wranglerConfigFor(needs);
    const path = join(abs, 'wrangler.jsonc');
    return existsSync(path) ? experimental_readRawConfig({ config: path }).rawConfig : undefined;
  };

  const workers = [];
  const offences = [];
  for (const dir of workerDirs()) {
    const abs = join(ROOT, dir);
    let cfg;
    try {
      cfg = deployConfigOf(abs);
    } catch (e) {
      offences.push(`${dir}: its deploy config could not be read: ${String(e?.message ?? e).split('\n')[0]}`);
      continue;
    }
    if (!cfg || typeof cfg.main !== 'string') continue;
    // A test pool's harness worker: the pool runs it under its own flags, and nothing deploys it.
    if (cfg.main.startsWith('test/')) continue;
    // Not a workspace member (`examples/external-vertical` installs from npm): nothing to resolve.
    if (!existsSync(join(abs, 'node_modules'))) continue;
    workers.push({ name: dir, dir: abs, cfg });
  }
  syncTemplate();
  workers.push({ name: 'the scaffold template (packages/template-check)', dir: CHECK_DIR, cfg: TEMPLATE });

  const checked = [];
  for (const w of workers) {
    const flags = Array.isArray(w.cfg.compatibility_flags) ? w.cfg.compatibility_flags : [];
    if (builtinsAllowedBy(flags) === 'all') continue;
    const entry = join(w.dir, w.cfg.main);
    if (!existsSync(entry)) {
      offences.push(`${w.name}: its entry ${relative(ROOT, entry)} does not exist`);
      continue;
    }
    let found;
    try {
      found = await refusedBuiltins(entry, flags);
    } catch (e) {
      const why = (e.errors ?? []).map((x) => `${x.text}${x.location ? ` (${x.location.file})` : ''}`).slice(0, 3);
      offences.push(`${w.name}: could not bundle ${relative(ROOT, entry)}: ${why.join('; ') || e.message}`);
      continue;
    }
    checked.push(`${w.name} ${JSON.stringify(flags)}`);
    const offence = workerNodeImportOffence(entry, flags, found);
    if (offence) offences.push(`${w.name}: ${offence}`);
  }

  if (offences.length) {
    console.error(`worker-node-imports: ${offences.length} worker(s) would not start on workerd:\n\n  ${offences.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`worker-node-imports: ${checked.length} worker bundle(s) without nodejs_compat import no builtin their flags lack:\n  ${checked.join('\n  ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
