#!/usr/bin/env node
/**
 * `pnpm lint:floating-promises` (#2131): every promise in code that runs in a workerd suite is
 * awaited, returned, or handed on, never left floating. That is typescript-eslint's
 * `no-floating-promises`, run by oxlint's type-aware mode (`oxlint-tsgolint`, which checks against
 * the TypeScript 7 compiler this repo builds with, so no second toolchain is needed for the type
 * information).
 *
 * The suites are found rather than listed: every vitest config that loads
 * `@cloudflare/vitest-plugin`, and the directories its `include` globs start from. To those are
 * added the shared suites they import (`SHARED_SUITES`), which run inside the same workers. A
 * forgotten `await` there is a rejection nobody handles, which `tools/vitest/workerd-rejections.mjs`
 * catches at run time only on the paths a test happens to drive. This catches it on every path.
 *
 * tsgolint types a file through its NEAREST `tsconfig.json`, and a file that project does not
 * include is skipped without a word, so a suite typed by a project file of another name
 * (`tsconfig.test.json`) would pass this check unread. Each root is therefore refused unless its
 * nearest `tsconfig.json` includes every TypeScript file under it, as the compiler itself lists
 * them (`tsc --listFilesOnly`). A suite root's project must also carry the plugin's types
 * (`@cloudflare/vitest-plugin/types`, as `tsc --showConfig` resolves them through `extends`). Those
 * types are what tell its `cloudflare:test` bindings apart from `any`, and the rule can say
 * nothing about `any`.
 *
 * Needs the build: a suite's imports are typed from its dependencies' emitted declarations.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const PLUGIN_TYPES = '@cloudflare/vitest-plugin/types';
/** Suites written once and run by an adapter's workerd suite too (and by node ones, so no plugin types). */
const SHARED_SUITES = ['packages/contract-tests/src'];
const tsc = join(repo, 'node_modules/.bin/tsc');

const configs = execFileSync('git', ['grep', '-l', '@cloudflare/vitest-plugin', '--', '*vitest*.config.ts'], {
  cwd: repo,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

/** The directory a glob starts from: everything before its first wildcard segment. */
function globRoot(glob) {
  const segments = glob.split('/');
  return segments.slice(0, segments.findIndex((s) => /[*?{[]/.test(s))).join('/');
}

function nearestTsconfig(dir, stop) {
  for (let at = dir; ; at = dirname(at)) {
    const candidate = join(at, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    if (at === stop) return undefined;
  }
}

/** The TypeScript sources under a directory, as the filesystem has them. */
function sourcesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.[cm]?tsx?$/.test(e.name) && !join(e.parentPath, e.name).includes('/node_modules/'))
    .map((e) => join(e.parentPath, e.name));
}

/** One `tsc` answer about a project; its first diagnostic as the error when it has none. */
function ask(tsconfig, flag) {
  const run = spawnSync(tsc, ['-p', tsconfig, flag], { cwd: repo, encoding: 'utf8' });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`tsc ${flag}: ${(run.stdout + run.stderr).split('\n')[0]}`);
  return run.stdout;
}

const projects = new Map();
/** What the compiler makes of a project: the files it includes and the `types` it resolves. */
function project(tsconfig) {
  if (!projects.has(tsconfig)) {
    try {
      projects.set(tsconfig, {
        files: new Set(ask(tsconfig, '--listFilesOnly').split('\n').filter(Boolean).map((f) => resolve(repo, f))),
        types: JSON.parse(ask(tsconfig, '--showConfig')).compilerOptions?.types ?? [],
      });
    } catch (error) {
      projects.set(tsconfig, { error: /** @type {Error} */ (error).message });
    }
  }
  return projects.get(tsconfig);
}

/** Why a root cannot be read typed, or undefined when it can. */
function unreadable(root, stop, needsPluginTypes) {
  const tsconfig = nearestTsconfig(root, stop);
  if (!tsconfig) return 'no tsconfig.json at or above it inside its package';
  const where = relative(repo, tsconfig);
  const { files, types, error } = project(tsconfig);
  if (error) return `its nearest tsconfig.json (${where}) does not load (${error})`;
  const outside = sourcesUnder(root).filter((f) => !files.has(f));
  if (outside.length > 0) {
    return `its nearest tsconfig.json (${where}) does not include ${outside.map((f) => relative(repo, f)).join(', ')}`;
  }
  if (needsPluginTypes && !types.includes(PLUGIN_TYPES)) return `its nearest tsconfig.json (${where}) does not carry ${PLUGIN_TYPES}`;
  return undefined;
}

const roots = [];
const refused = [];
const check = (root, stop, needsPluginTypes) => {
  if (roots.includes(root)) return;
  const why = unreadable(root, stop, needsPluginTypes);
  if (why) refused.push(`${relative(repo, root)}: ${why}, so the type-aware rule would read it untyped`);
  else roots.push(root);
};
for (const config of configs) {
  const pkg = dirname(join(repo, config));
  const include = /include:\s*\[([^\]]*)\]/.exec(readFileSync(join(repo, config), 'utf8'))?.[1];
  const globs = [...(include ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (globs.length === 0) refused.push(`${config}: no literal \`include\` to find its suite by`);
  for (const glob of globs) check(join(pkg, globRoot(glob)), pkg, true);
}
for (const shared of SHARED_SUITES) check(join(repo, shared), dirname(join(repo, shared)), false);

if (refused.length > 0) {
  console.error(
    `lint:floating-promises: ${refused.length} root(s) cannot be checked:\n  ${refused.join('\n  ')}\n` +
      'Add a tsconfig.json beside the suite that extends the project it typechecks with, and includes it.',
  );
  process.exit(2);
}

const oxlint = spawnSync(
  join(repo, 'node_modules/.bin/oxlint'),
  ['--type-aware', '--deny-warnings', '-c', join(repo, 'tools/oxlint/floating-promises.json'), ...roots.map((r) => relative(repo, r))],
  { cwd: repo, stdio: 'inherit' },
);
if (oxlint.error) throw oxlint.error;
if (oxlint.status === 0) console.log(`lint:floating-promises: ${roots.length} roots, no floating promise.`);
process.exit(oxlint.status ?? 1);
