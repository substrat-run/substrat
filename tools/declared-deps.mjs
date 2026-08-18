#!/usr/bin/env node
/**
 * Every module a package references must be one it DECLARED. (#742)
 *
 * The rule this enforces is the general one; zod was only how it was noticed.
 * `@substrat-run/contract-tests` shipped 130 `import("zod")` references in its
 * published `.d.ts` while declaring zod nowhere — it resolved for years because
 * some other package's dependency happened to hoist a copy into view. That is
 * not a dependency, it is a coincidence, and it breaks the moment the tree
 * shifts.
 *
 * Two surfaces are checked, and the first is the one that reaches users:
 *
 * 1. **Emitted `.d.ts`.** TypeScript writes the ORIGINAL module specifier into
 *    declarations regardless of how the source imported it — re-exporting `z`
 *    from `@substrat-run/contracts` still emits `import("zod")`. So a published
 *    package's types can require a module its package.json never mentions, and
 *    the consumer is the one who finds out.
 * 2. **Source imports.** pnpm's symlinked layout already refuses most of these,
 *    but a hoisted copy at the workspace root can satisfy an import that a
 *    standalone install of the same package would not.
 *
 * Known limit, stated rather than hidden: this reads text, not an AST, so an
 * import-shaped string inside a template literal is indistinguishable from a
 * real import. The failure mode is a loud false positive, never a silent pass —
 * which is the right way round for a check whose job is to refuse.
 *
 * Deliberately NOT checked: ambient globals. `setTimeout` needs `@types/node` in
 * `types`, and nothing in an import graph says so — that one is caught by
 * `lib: ES2023` refusing to declare it, which is why two packages needed an
 * explicit `"types": ["node"]` when the tree shifted under them.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { builtinModules } from 'node:module';

const ROOTS = ['packages', 'engines', 'connectors', 'demos', 'apps'];
/**
 * Builtins need no declaration, prefixed or not. The bare spellings matter:
 * `require('fs')` appears inside a template literal in `contracts/src/ci.ts`
 * that EMITS a CI script, and a checker that cannot tell a builtin from a
 * package reports it as a missing dependency of contracts.
 */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
const packageOf = (spec) => {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

/** A real npm package name, so prose in a comment cannot pass for a specifier. */
const PACKAGE_NAME = /^(?:@[a-z0-9~][\w.-]*\/)?[a-z0-9~][\w.-]*$/;

/** Comments are where the prose lives, and prose is what produced false hits. */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\`])\/\/[^\n]*/g, '$1');

/** Bare specifiers referenced by a file — imports, re-exports, and `import("x")`. */
function specifiersIn(raw) {
  const text = stripComments(raw);
  const found = new Set();
  const patterns = [
    // Only as part of an import/export STATEMENT, never a bare `from '…'`.
    /(?:^|[\n;{])\s*(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[\n;{])\s*import\s+['"]([^'"]+)['"]/g,
    // Type positions: TypeScript emits these into .d.ts.
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/') || BUILTINS.has(spec)) continue;
      if (spec.includes(':')) continue; // cloudflare:test, bun:sqlite, data:…
      const pkg = packageOf(spec);
      if (BUILTINS.has(pkg)) continue;
      if (!PACKAGE_NAME.test(pkg)) continue;
      found.add(pkg);
    }
  }
  return found;
}

const problems = [];
let checkedPackages = 0;

for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const pjPath = join(dir, 'package.json');
    if (!existsSync(pjPath)) continue;
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
    const declared = new Set([
      ...Object.keys(pj.dependencies ?? {}),
      ...Object.keys(pj.devDependencies ?? {}),
      ...Object.keys(pj.peerDependencies ?? {}),
      ...Object.keys(pj.optionalDependencies ?? {}),
      pj.name,
    ]);
    checkedPackages += 1;

    const surfaces = [
      { label: 'published types', files: walk(join(dir, 'dist')).filter((f) => f.endsWith('.d.ts')) },
      {
        label: 'source',
        // `*.generated.ts` is emitted, gitignored, and frequently embeds other
        // projects' source verbatim — its imports are not this package's.
        files: walk(join(dir, 'src')).filter(
          (f) => /\.(ts|tsx|mts)$/.test(f) && !f.endsWith('.d.ts') && !f.includes('.generated.'),
        ),
      },
    ];

    for (const { label, files } of surfaces) {
      const missing = new Map();
      for (const f of files) {
        for (const spec of specifiersIn(readFileSync(f, 'utf8'))) {
          if (!declared.has(spec)) {
            if (!missing.has(spec)) missing.set(spec, relative(dir, f));
          }
        }
      }
      for (const [spec, where] of missing) {
        problems.push(`${pj.name} (${dir}): ${label} reference '${spec}' — not declared. First seen: ${where}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('declared-deps: a package references modules it never declared\n');
  for (const p of problems.sort()) console.error(`  ✕ ${p}`);
  console.error(
    `\n${problems.length} undeclared reference(s). A published package must declare what its\n` +
      'types and code reference — anything else is relying on another package hoisting it.',
  );
  process.exit(1);
}

console.log(`declared-deps: ${checkedPackages} packages declare everything they reference`);
