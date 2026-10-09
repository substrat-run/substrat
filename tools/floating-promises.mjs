#!/usr/bin/env node
/**
 * `pnpm lint:floating-promises` (#2131): every promise in a workerd suite is awaited, returned,
 * or handed on, never left floating. That is typescript-eslint's `no-floating-promises`, run by
 * oxlint's type-aware mode (`oxlint-tsgolint`, which checks against the TypeScript 7 compiler
 * this repo builds with, so no second toolchain is needed for the type information).
 *
 * The suites are found rather than listed: every vitest config that loads
 * `@cloudflare/vitest-plugin`, and the directories its `include` globs start from. A forgotten
 * `await` there is a rejection nobody handles, which `tools/vitest/workerd-rejections.mjs`
 * catches at run time only on the paths a test happens to drive. This catches it on every path.
 *
 * tsgolint types a file through the NEAREST `tsconfig.json`, and a file outside every project it
 * finds is skipped without a word — so a test directory typed by a project file of another name
 * (`tsconfig.test.json`) would pass this check unread. Each root is therefore refused unless its
 * nearest `tsconfig.json` carries the plugin's types (`@cloudflare/vitest-plugin/types`, through
 * `extends` or itself), which is what tells it the suite's `cloudflare:test` bindings apart from
 * `any`, about which the rule can say nothing.
 *
 * Needs the build: a suite's imports are typed from its dependencies' emitted declarations.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const PLUGIN_TYPES = '@cloudflare/vitest-plugin/types';

const configs = execFileSync('git', ['grep', '-l', '@cloudflare/vitest-plugin', '--', '*vitest*.config.ts'], {
  cwd: repo,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

/** The directory a glob starts from: everything before its first wildcard segment. */
function globRoot(glob) {
  const segments = glob.split('/');
  const fixed = segments.slice(0, segments.findIndex((s) => /[*?{[]/.test(s)));
  return fixed.join('/');
}

/** Whether a tsconfig, or one it extends, names the plugin's types. */
function carriesPluginTypes(file) {
  const text = readFileSync(file, 'utf8');
  if (text.includes(PLUGIN_TYPES)) return true;
  const base = /"extends"\s*:\s*"(\.[^"]+)"/.exec(text)?.[1];
  return base !== undefined && carriesPluginTypes(resolve(dirname(file), base));
}

function nearestTsconfig(dir, stop) {
  for (let at = dir; ; at = dirname(at)) {
    const candidate = join(at, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    if (at === stop) return undefined;
  }
}

const roots = [];
const refused = [];
for (const config of configs) {
  const pkg = dirname(join(repo, config));
  const include = /include:\s*\[([^\]]*)\]/.exec(readFileSync(join(repo, config), 'utf8'))?.[1];
  const globs = [...(include ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (globs.length === 0) refused.push(`${config}: no literal \`include\` to find its suite by`);
  for (const glob of globs) {
    const root = join(pkg, globRoot(glob));
    const tsconfig = nearestTsconfig(root, pkg);
    if (!tsconfig || !carriesPluginTypes(tsconfig)) {
      refused.push(
        `${relative(repo, root)}: its nearest tsconfig.json (${tsconfig ? relative(repo, tsconfig) : 'none'}) does not carry ` +
          `${PLUGIN_TYPES}, so the type-aware rule would read this suite untyped. Add a tsconfig.json beside it ` +
          'that extends the project the suite typechecks with.',
      );
    } else if (!roots.includes(root)) {
      roots.push(root);
    }
  }
}

if (refused.length > 0) {
  console.error(`lint:floating-promises: ${refused.length} workerd suite(s) cannot be checked:\n  ${refused.join('\n  ')}`);
  process.exit(2);
}

const oxlint = spawnSync(
  join(repo, 'node_modules/.bin/oxlint'),
  ['--type-aware', '--deny-warnings', '-c', join(repo, 'tools/oxlint/floating-promises.json'), ...roots.map((r) => relative(repo, r))],
  { cwd: repo, stdio: 'inherit' },
);
if (oxlint.error) throw oxlint.error;
if (oxlint.status === 0) console.log(`lint:floating-promises: ${roots.length} workerd suite roots, no floating promise.`);
process.exit(oxlint.status ?? 1);
