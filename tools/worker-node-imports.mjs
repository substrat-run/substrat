#!/usr/bin/env node
/**
 * A worker deployed with no node flag imports no `node:*` module (#2245).
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
 * So this bundles each flagless worker's entry the way wrangler does (esbuild, workerd
 * conditions, `node:*` and `cloudflare:*` left as imports) and refuses one whose bundle statically
 * imports a node builtin (`node:*` or bare). A `require()` or `import()` fails only when
 * reached, and a guarded one never does, so those are left alone. A `process.getBuiltinModule('node:…')` call
 * is not an import and is not counted: that is how vertical-host reaches `AsyncLocalStorage`
 * without one. The platform entry the control plane puts in front of a pushed vertical is not
 * part of any bundle here; the uploader adds `nodejs_als` for it (`withPlatformEntry`).
 *
 * The workers: every tracked `wrangler.jsonc` with a `main`, every vertical whose package.json
 * declares `substrat.runtimeNeeds` (its config derived the way `substrat push` derives it), and
 * the scaffold template, materialized into `packages/template-check` first.
 *
 *   pnpm lint:worker-node-imports
 *
 * Needs the build (`packages/cli/dist`), like every tool that derives a push's config.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';
import { readRuntimeNeeds, wranglerConfigFor } from '../packages/cli/dist/push.js';
import { CHECK_DIR, syncTemplate } from './template-sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_FLAGS = ['nodejs_compat', 'nodejs_als'];

/** Directories holding a worker: tracked wrangler configs, and verticals declaring runtime needs. */
function workerDirs() {
  const tracked = execFileSync('git', ['ls-files', '*wrangler.jsonc', '*package.json'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p && !p.startsWith('spikes/') && !p.includes('node_modules/'));
  return [...new Set(tracked.map((p) => dirname(p)))].sort();
}

/** The scaffold's runtime needs, as `packages/create-substrat/index.js` writes them: no node flag. */
const TEMPLATE = { main: 'src/worker.ts', compatibility_flags: [] };

/**
 * The config a deploy of `dir` builds with: `substrat.runtimeNeeds` wins, derived the way
 * `substrat push` derives it; otherwise the hand-authored `wrangler.jsonc`, read by wrangler.
 */
function deployConfigOf(abs) {
  const needs = readRuntimeNeeds(abs);
  if (needs) return wranglerConfigFor(needs);
  const path = join(abs, 'wrangler.jsonc');
  return existsSync(path) ? experimental_readRawConfig({ config: path }).rawConfig : undefined;
}

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
  if (flags.some((f) => NODE_FLAGS.includes(f))) continue;
  const entry = join(w.dir, w.cfg.main);
  if (!existsSync(entry)) {
    offences.push(`${w.name}: its entry ${relative(ROOT, entry)} does not exist`);
    continue;
  }
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
  }).catch((e) => ({ error: e }));
  if ('error' in result) {
    const why = (result.error.errors ?? []).map((e) => `${e.text}${e.location ? ` (${e.location.file})` : ''}`).slice(0, 3);
    offences.push(`${w.name}: could not bundle ${relative(ROOT, entry)}: ${why.join('; ') || result.error.message}`);
    continue;
  }
  checked.push(w.name);
  // A static import is resolved before the worker runs, so it is what stops it starting. A
  // `require()` or `import()` of a builtin fails only when reached, and a guarded one (a
  // library probing for node's `crypto`) never fails at all: those are not this gate's.
  const isBuiltin = (i) => i.kind === 'import-statement' && (i.path.startsWith('node:') || builtinModules.includes(i.path));
  const imported = new Set();
  for (const input of Object.values(result.metafile.inputs)) {
    for (const i of input.imports) if (isBuiltin(i)) imported.add(i.path);
  }
  if (imported.size) {
    const by = Object.entries(result.metafile.inputs)
      .filter(([, input]) => input.imports.some(isBuiltin))
      .map(([file]) => file);
    offences.push(
      `${w.name}: deployed with no node flag (${JSON.stringify(flags)}), but its bundle imports ${[...imported].join(', ')}\n` +
        `    imported by: ${by.slice(0, 5).join(', ')}${by.length > 5 ? ', …' : ''}`,
    );
  }
}

if (offences.length) {
  console.error(
    `worker-node-imports: ${offences.length} flagless worker(s) would not start on workerd:\n\n  ${offences.join('\n  ')}\n\n` +
      `  Reach a node API without importing it (vertical-host's invocation log uses process.getBuiltinModule),\n` +
      `  or declare nodejs_compat for that worker.`,
  );
  process.exit(1);
}
console.log(`worker-node-imports: ${checked.length} flagless worker bundle(s) import no node builtin:\n  ${checked.join('\n  ')}`);
