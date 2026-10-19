#!/usr/bin/env node
/**
 * A vertical's scope host is given the permission surface `substrat push` reads (#2430).
 *
 * `lint:permissions` and `substrat push` judge a vertical by the modules in its declared
 * `permissions` (`definePermissions({ modules, … })`). What actually runs is whatever the host
 * registers. By convention both read one `MODULES` constant, and nothing checked it: a module
 * registered beside the list was judged by neither, including a reservation it declares
 * (`holder: 'system'`). So both scope hosts and `defineScopeDO` take that same `permissions`, and
 * refuse to register a module it leaves out.
 *
 * The option is opt-in, which makes it easy to forget. This makes forgetting it red: in every
 * package that declares a permission surface (`substrat.permissions` in package.json, and the
 * scaffold template, whose package.json `create-substrat` writes), each host construction that
 * registers modules passes `permissions` in the options it is written with:
 *
 * - `new SqliteScopeHost({ … })` / `new CloudflareScopeHost({ … })` in a file that calls
 *   `registerModule`;
 * - `defineScopeDO(modules, bareOps, { … })` whose module list is not an empty array literal.
 *
 * The options must be an object literal with a `permissions` property (shorthand included): a
 * variable is refused, since the property cannot be seen through it. A package that declares no
 * surface has no list to hold registration to and is out of scope. A file that genuinely cannot
 * pass it says why with `host-permissions-allow: <reason>`, which is printed on every run. Tests are
 * out of scope: they construct hosts over fixture modules with no surface behind them.
 *
 * What this does NOT judge: whether the object passed IS the surface push reads. That is the
 * vertical's `substrat.permissions` entry, and the convention is to import it from there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseTypeScript } from '@babel/parser';
import { repoRoot, toPosix } from './repo-path.mjs';

const ROOT = repoRoot(import.meta.url);
/** Where a package that declares a permission surface can live. */
const ROOTS = ['demos', 'apps', 'examples', 'engines', 'packages'];
/** Not a workspace member, and its package.json is written by `create-substrat`: named directly. */
const TEMPLATE = 'packages/create-substrat/template';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '__tests__', '.wrangler', '.builder', 'app', 'web']);
const HOSTS = new Set(['SqliteScopeHost', 'CloudflareScopeHost']);
const ALLOW = /host-permissions-allow:\s*(\S.*)$/m;

const parse = (text) => parseTypeScript(text, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true });

/** Every node under `node`, depth first. */
function* walk(node) {
  if (!node || typeof node.type !== 'string') return;
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    if (Array.isArray(value)) for (const child of value) yield* walk(child);
    else if (value && typeof value === 'object') yield* walk(value);
  }
}

const hasPermissions = (options) =>
  options?.type === 'ObjectExpression' &&
  options.properties.some((p) => p.type === 'ObjectProperty' && !p.computed && (p.key.name ?? p.key.value) === 'permissions');

/**
 * Each host construction in `source` that registers modules and passes no `permissions`, as
 * `{ line, what }`. Empty when every one does, or when the file constructs none.
 */
export function hostPermissionOffences(source) {
  const nodes = [...walk(parse(source).program)];
  const registers = nodes.some(
    (n) => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property?.name === 'registerModule',
  );
  const out = [];
  for (const n of nodes) {
    if (n.type === 'NewExpression' && HOSTS.has(n.callee.name) && registers && !hasPermissions(n.arguments[0])) {
      out.push({ line: n.loc.start.line, what: `new ${n.callee.name}(…)` });
    }
    if (n.type === 'CallExpression' && n.callee.name === 'defineScopeDO') {
      const [modules, , options] = n.arguments;
      const none = modules?.type === 'ArrayExpression' && modules.elements.length === 0;
      if (!none && !hasPermissions(options)) out.push({ line: n.loc.start.line, what: 'defineScopeDO(…)' });
    }
  }
  return out;
}

// ── The predicate has to be able to tell its own cases apart, or a green run means nothing.
const SELF_TEST = [
  ['const h = new SqliteScopeHost({ dir, permissions });\nfor (const m of M) h.registerModule(m);', 0],
  ["const h = new SqliteScopeHost({ dir, 'permissions': p });\nh.registerModule(m);", 0],
  ['const h = new SqliteScopeHost({ dir });\nfor (const m of M) h.registerModule(m);', 1],
  ['const h = new CloudflareScopeHost(options);\nh.registerModule(m);', 1],
  // A host that registers nothing has no module to hold to a list.
  ['const h = new CloudflareScopeHost({ scope });', 0],
  ['export const ScopeDO = defineScopeDO(MODULES, {}, { permissions });', 0],
  ['export const ScopeDO = defineScopeDO(MODULES, {});', 1],
  ['export const ScopeDO = defineScopeDO(MODULES, {}, opts);', 1],
  ['export const ScopeDO = defineScopeDO([], {});', 0],
];
const drift = SELF_TEST.filter(([src, count]) => hostPermissionOffences(src).length !== count);
if (drift.length > 0) {
  console.error('host-permissions: the predicate no longer tells its own cases apart:');
  for (const [src, count] of drift) console.error(`  ${JSON.stringify(src)} → expected ${count}, got ${hostPermissionOffences(src).length}`);
  process.exit(2);
}

/** Every package directory under `dir` whose package.json declares `substrat.permissions`. */
function* declaringPackages(dir, depth = 0) {
  if (depth > 3 || !existsSync(dir)) return;
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).substrat?.permissions) yield dir;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const child = join(dir, entry);
    if (statSync(child).isDirectory()) yield* declaringPackages(child, depth + 1);
  }
}

/** The non-test sources of one package. */
function* sources(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(m?ts|tsx)$/.test(entry) && !/\.(test|spec)\.|\.d\.ts$/.test(entry)) yield path;
  }
}

const packages = [...new Set([...ROOTS.flatMap((r) => [...declaringPackages(join(ROOT, r))]), join(ROOT, TEMPLATE)])];
const offences = [];
let constructions = 0;
for (const pkg of packages) {
  for (const file of sources(pkg)) {
    const text = readFileSync(file, 'utf8');
    if (!/SqliteScopeHost|CloudflareScopeHost|defineScopeDO/.test(text)) continue;
    const rel = toPosix(relative(ROOT, file));
    const allowed = ALLOW.exec(text);
    if (allowed) {
      console.log(`host-permissions: ${rel} is exempt — ${allowed[1].trim()}`);
      continue;
    }
    constructions += [...text.matchAll(/new (?:Sqlite|Cloudflare)ScopeHost\(|defineScopeDO\(/g)].length;
    for (const o of hostPermissionOffences(text)) offences.push(`  ${rel}:${o.line}  ${o.what}`);
  }
}

if (constructions === 0) {
  console.error('host-permissions: found no host construction in any package that declares a permission surface — a gate that checked nothing.');
  process.exit(2);
}
if (offences.length > 0) {
  console.error(
    `host-permissions: ${offences.length} host construction(s) register modules without the declared permission surface:\n` +
      `${offences.join('\n')}\n\n` +
      '  `lint:permissions` and `substrat push` judge this vertical by its `permissions.modules`; a host\n' +
      '  given that same `permissions` refuses a module the list leaves out, so the two cannot part.\n' +
      '  Remedy: pass it in the options literal — `new SqliteScopeHost({ dir, permissions })`,\n' +
      '  `defineScopeDO(MODULES, {}, { permissions })` — importing `permissions` from the vertical\'s\n' +
      '  `substrat.permissions` entry. A file that cannot says why: `// host-permissions-allow: <reason>`.',
  );
  process.exit(2);
}
console.log(`host-permissions: ${constructions} host construction(s) in ${packages.length} package(s) declaring a permission surface pass it`);
