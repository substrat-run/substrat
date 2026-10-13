#!/usr/bin/env node
/**
 * A worker imports no node builtin its compatibility flags do not give it (#2245).
 *
 * workerd resolves `node:async_hooks` only under `nodejs_als` or `nodejs_compat`, and every
 * other `node:*` module only under `nodejs_compat`. Without the flag a bundle that imports one
 * builds, uploads, and then fails to start: `No such module "node:async_hooks"`. No node suite
 * can see that, because node has every module, and a workerd suite runs under the pool's own
 * flags. A static import in a shared package (vertical-host's invocation log, which every
 * deployed vertical and the dashboard bundle) breaks every flagless worker at once — the
 * dashboard's deploy in a release would fail after the control plane and the router had already
 * shipped.
 *
 * So this bundles the entry of each worker that lacks `nodejs_compat` the way wrangler does
 * (esbuild, workerd conditions, `node:*` and `cloudflare:*` left as imports) and refuses a
 * static import of a node builtin (`node:*` or bare) its flags do not give it. `nodejs_als`
 * gives `node:async_hooks` alone, so a worker declaring only it may import nothing else. A
 * `require()` or `import()` fails only when reached, and a guarded one never does, so those
 * are left alone; a `process.getBuiltinModule('node:…')` call is not an import at all, which
 * is how vertical-host reaches `AsyncLocalStorage` without one. The platform entry the
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
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Flags that give a worker every node builtin. */
const ALL_OF_NODE = ['nodejs_compat', 'nodejs_compat_v2'];
/** `nodejs_als` gives `node:async_hooks` and nothing else. */
const ALS_ONLY = ['node:async_hooks', 'async_hooks'];

/**
 * Which node builtins a worker with these flags may import statically: `'all'` under
 * `nodejs_compat`, `node:async_hooks` alone under `nodejs_als`, none otherwise.
 * @param {readonly string[]} flags
 * @returns {'all' | ReadonlySet<string>}
 */
export function builtinsAllowedBy(flags) {
  if (flags.some((f) => ALL_OF_NODE.includes(f))) return 'all';
  return new Set(flags.includes('nodejs_als') ? ALS_ONLY : []);
}

/**
 * Bundle one worker entry the way wrangler does and name the node builtins it imports
 * statically that its flags do not give it. A `require()` or `import()` of a builtin fails
 * only when reached, and a guarded one (a library probing for node's `crypto`) never fails at
 * all: those are not this gate's. Throws when the entry cannot be bundled.
 * @param {string} entry  absolute path of the worker's main module
 * @param {readonly string[]} flags  its compatibility flags
 * @returns {Promise<{ refused: string[]; importedBy: string[] }>}
 */
export async function refusedBuiltins(entry, flags) {
  const allowed = builtinsAllowedBy(flags);
  if (allowed === 'all') return { refused: [], importedBy: [] };
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['node:*', 'cloudflare:*', ...builtinModules],
    // Non-code assets a worker imports are irrelevant to which modules it imports.
    loader: { '.html': 'text', '.txt': 'text', '.md': 'text', '.css': 'text', '.svg': 'text', '.wasm': 'binary' },
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  const refusedImport = (i) =>
    i.kind === 'import-statement' && (i.path.startsWith('node:') || builtinModules.includes(i.path)) && !allowed.has(i.path);
  const refused = new Set();
  const importedBy = [];
  for (const [file, input] of Object.entries(result.metafile.inputs)) {
    const hits = input.imports.filter(refusedImport);
    for (const i of hits) refused.add(i.path);
    if (hits.length) importedBy.push(file);
  }
  return { refused: [...refused], importedBy };
}

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
    if (found.refused.length) {
      const by = found.importedBy;
      offences.push(
        `${w.name}: deployed with flags ${JSON.stringify(flags)}, which do not give it ${found.refused.join(', ')}, but its bundle imports them\n` +
          `    imported by: ${by.slice(0, 5).join(', ')}${by.length > 5 ? ', …' : ''}`,
      );
    }
  }

  if (offences.length) {
    console.error(
      `worker-node-imports: ${offences.length} worker(s) would not start on workerd:\n\n  ${offences.join('\n  ')}\n\n` +
        `  Reach a node API without importing it (vertical-host's invocation log uses process.getBuiltinModule),\n` +
        `  or declare nodejs_compat for that worker.`,
    );
    process.exit(1);
  }
  console.log(`worker-node-imports: ${checked.length} worker bundle(s) without nodejs_compat import no builtin their flags lack:\n  ${checked.join('\n  ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
