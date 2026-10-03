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
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

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
export function specifiersIn(raw) {
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

/**
 * Edges that must not exist, however a package declares them (K-43).
 *
 * **The kernel indexes attachment text; it does not parse file formats.** Every parser lives
 * in `@substrat-run/attachment-extractors`, which whoever constructs a host passes in — the
 * kernel and the adapters never import it. A guard nobody can accidentally undo is the point
 * of that decision, so it is held here rather than in prose: neither a runtime declaration
 * (dependencies, peer, optional) nor a reference in source or shipped types. A DEV dependency
 * stays legal, because an adapter's own test harness is a composition root and wires the
 * extractors in exactly as a deployment does.
 */
export const FORBIDDEN_EDGES = {
  '@substrat-run/kernel': ['@substrat-run/attachment-extractors'],
  '@substrat-run/adapter-sqlite': ['@substrat-run/attachment-extractors'],
  '@substrat-run/adapter-cloudflare': ['@substrat-run/attachment-extractors'],
};

/**
 * The forbidden edges one package has: `pj` is its package.json, `files` its source and
 * shipped-type texts keyed by a path to name in the report.
 */
export function forbiddenEdgeProblems(pj, files, forbidden = FORBIDDEN_EDGES) {
  const banned = forbidden[pj.name] ?? [];
  const out = [];
  for (const target of banned) {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      if (pj[field] && target in pj[field]) out.push(`${pj.name} declares '${target}' in ${field} (K-43)`);
    }
    for (const [where, text] of Object.entries(files)) {
      if (specifiersIn(text).has(target)) out.push(`${pj.name} references '${target}' in ${where} (K-43)`);
    }
  }
  return out;
}

/**
 * Packages whose RUNTIME dependency closure must hold only permissive licences (#971).
 *
 * `@substrat-run/cli` and `@substrat-run/control-plane-client` are Apache-2.0 on purpose
 * (LICENSING.md): the tools a builder runs against their own code must never
 * copyleft-capture it. A dependency is the quiet way to break that — the tarball would still
 * say Apache-2.0 while `npm install` pulled the AGPL server in beside it — which is exactly
 * what moving the client out of `control-plane-api` was for. So the closure is judged, not
 * only the direct edge: `dependencies`, `peerDependencies` and `optionalDependencies`, one
 * hop after another, workspace and registry packages alike. A devDependency is not shipped
 * and stays legal (the CLI's own tests may import anything).
 */
export const PERMISSIVE_ONLY = ['@substrat-run/cli', '@substrat-run/control-plane-client'];

/**
 * The licences a permissive-only closure may contain — an ALLOWLIST, not a denylist of the
 * copyleft ones it happens to know. A denylist passes whatever it has not heard of: MPL-2.0,
 * EPL-2.0 and CDDL-1.0 are file-level copyleft that none of a GPL-shaped pattern catches, and
 * a licence nobody named yet is by construction not on it. Everything not listed here is
 * refused, including `UNLICENSED`, `SEE LICENSE IN …` and a field that is absent; widening
 * the list is a decision a review reads, one identifier at a time. SPDX ids compare
 * case-insensitively.
 */
export const PERMISSIVE_LICENSES = new Set(
  [
    'MIT',
    'MIT-0',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    '0BSD',
    'Unlicense',
    'CC0-1.0',
    'BlueOak-1.0.0',
    'Zlib',
    'Python-2.0',
    'CC-BY-4.0',
  ].map((id) => id.toLowerCase()),
);

/**
 * The SPDX licence-expression grammar (SPDX spec, annex D), as a recursive-descent parser:
 *
 *     expression  = and-expr *( "OR" and-expr )
 *     and-expr    = with-expr *( "AND" with-expr )
 *     with-expr   = simple [ "WITH" exception-id ]
 *     simple      = "(" expression ")" / license-id [ "+" ] / license-ref
 *     license-id, exception-id = 1*( ALPHA / DIGIT / "-" / "." )
 *     license-ref = [ "DocumentRef-" idstring ":" ] "LicenseRef-" idstring
 *
 * `AND` binds tighter than `OR`, and the operators are read case-insensitively (an `or` is
 * unambiguous). It returns the expression's verdict — `OR`: either side permits, `AND`: both
 * must — and THROWS on anything that is not in the grammar, so a caller fails closed:
 * `MIT WITH OR`, `MIT WITH (`, a dangling operator, an unbalanced parenthesis, and an
 * identifier with a character the grammar does not allow are all errors rather than guesses.
 * `X WITH exception` is judged on `X` alone: an exception never makes a copyleft licence
 * permissive. A `LicenseRef-*` is a licence nobody named in this file, so it is refused unless
 * it is allowlisted by its full spelling.
 */
function parseSpdx(expression) {
  const tokens = String(expression).match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const fail = (why) => {
    throw new SyntaxError(`${why} in SPDX expression ${JSON.stringify(String(expression))}`);
  };
  const isOperator = (t) => t !== undefined && /^(?:AND|OR|WITH)$/i.test(t);
  const isWord = (t, w) => t !== undefined && t.toUpperCase() === w;
  const IDSTRING = /^[A-Za-z0-9.-]+$/;
  const LICENSE_REF = /^(?:DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+$/;

  function simple() {
    const t = tokens[at++];
    if (t === undefined) return fail('expected a licence, found the end');
    if (t === ')') return fail("unexpected ')'");
    if (t === '(') {
      const inner = or();
      if (tokens[at++] !== ')') return fail("expected ')'");
      return inner;
    }
    if (isOperator(t)) return fail(`expected a licence, found '${t}'`);
    if (LICENSE_REF.test(t)) return PERMISSIVE_LICENSES.has(t.toLowerCase());
    const id = t.endsWith('+') ? t.slice(0, -1) : t;
    if (!IDSTRING.test(id)) return fail(`'${t}' is not a licence identifier`);
    return PERMISSIVE_LICENSES.has(id.toLowerCase());
  }
  function withException() {
    const value = simple();
    if (isWord(tokens[at], 'WITH')) {
      at++;
      const exception = tokens[at++];
      if (exception === undefined || exception === '(' || exception === ')' || isOperator(exception) || !IDSTRING.test(exception)) {
        return fail('expected an exception identifier after WITH');
      }
    }
    return value;
  }
  function and() {
    let value = withException();
    while (isWord(tokens[at], 'AND')) {
      at++;
      const right = withException();
      value = value && right;
    }
    return value;
  }
  function or() {
    let value = and();
    while (isWord(tokens[at], 'OR')) {
      at++;
      const right = and();
      value = value || right;
    }
    return value;
  }
  const verdict = or();
  if (at !== tokens.length) fail(`unexpected '${tokens[at]}'`);
  return verdict;
}

/** Whether an SPDX expression is wholly permissive; one that does not parse is not. */
export function spdxPermissive(expression) {
  try {
    return parseSpdx(expression);
  } catch {
    return false;
  }
}

/**
 * Why a package's licence is not acceptable in a permissive-only closure, or `null`. Reads
 * the `license` field (an SPDX string, or the legacy `{ type }` object) and, failing that,
 * the legacy `licenses` array, whose entries are alternatives.
 */
export function licenseProblem(license, legacyLicenses) {
  let text = typeof license === 'string' ? license : license && typeof license === 'object' ? license.type : undefined;
  if (!text && Array.isArray(legacyLicenses)) {
    text = legacyLicenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean).join(' OR ') || undefined;
  }
  if (!text || !String(text).trim()) return 'declares no licence';
  return spdxPermissive(text) ? null : `is ${text}, which is not on the permissive allowlist`;
}

/**
 * The closure problems of one package. `read(name, fromKey)` answers
 * `{ pj, key } | null` for a dependency named from the package at `fromKey` — the CLI wires
 * it to the workspace and `node_modules`; a test wires it to a literal graph. An optional or
 * peer dependency that cannot be resolved is skipped (esbuild's per-platform binaries are
 * installed for one platform only; a peer is the consumer's to install); a required one is a problem, because a check that
 * silently skipped what it could not find would pass on an empty install.
 */
export function licenseProblems(rootPj, rootKey, read) {
  const out = [];
  // Visited by resolved INSTANCE (the directory a dependency was found in), not by name: two
  // versions of one package are two packages, and the second may carry a licence the first
  // does not. A diamond that reaches the SAME instance twice, and a cycle, are still walked once.
  const seen = new Set([rootKey]);
  const walkDeps = (pj, key, trail) => {
    const required = new Set(Object.keys(pj.dependencies ?? {}));
    // A peer is the CONSUMER's to provide, so it is legitimately absent from this package's own
    // install; an optional dependency is absent on the platforms it does not target. A name
    // that is also a regular dependency is neither: it must resolve.
    const mayBeAbsent = new Set(
      [...Object.keys(pj.peerDependencies ?? {}), ...Object.keys(pj.optionalDependencies ?? {})].filter(
        (n) => !required.has(n),
      ),
    );
    const names = new Set([...required, ...mayBeAbsent]);
    for (const name of names) {
      const dep = read(name, key);
      if (!dep) {
        if (!mayBeAbsent.has(name)) out.push(`${[...trail, name].join(' → ')}: cannot be resolved — run \`pnpm install\``);
        continue;
      }
      if (seen.has(dep.key)) continue;
      seen.add(dep.key);
      const why = licenseProblem(dep.pj.license, dep.pj.licenses);
      if (why) out.push(`${[...trail, name].join(' → ')} ${why}`);
      walkDeps(dep.pj, dep.key, [...trail, name]);
    }
  };
  walkDeps(rootPj, rootKey, [rootPj.name]);
  return out;
}

/**
 * What a permissive-only package SHIPS must import only what it ships with (#971). The
 * declared-imports check above accepts a `devDependency`, which is right for a test or a
 * tool and wrong for `src/`: the compiled JS (and the emitted `.d.ts`) reaches the importing
 * package at run time, where a dependency declared only for development is not installed.
 * It is also how the licence closure would be sidestepped — the closure walks the runtime
 * dependencies, so an AGPL package declared as a devDependency and imported from `src/` would
 * pass both checks and still be loaded by the published CLI.
 *
 * `files` maps a path relative to the package to its text; only `src/` and the emitted
 * `dist/` types are judged, so a test file's import of a dev-only dependency stays legal.
 */
export function shippedImportProblems(pj, files) {
  const shipped = new Set([
    ...Object.keys(pj.dependencies ?? {}),
    ...Object.keys(pj.peerDependencies ?? {}),
    ...Object.keys(pj.optionalDependencies ?? {}),
    pj.name,
  ]);
  const devOnly = new Set(Object.keys(pj.devDependencies ?? {}).filter((n) => !shipped.has(n)));
  const out = [];
  for (const [where, text] of Object.entries(files)) {
    if (!/^(?:src|dist)[/\\]/.test(where)) continue;
    for (const spec of specifiersIn(text)) {
      if (devOnly.has(spec)) {
        out.push(
          `${pj.name} ships an import of '${spec}' in ${where}, but declares it only as a devDependency — ` +
            'the published package reaches it at run time, where it is not installed',
        );
      }
    }
  }
  return out;
}

/** The real resolver: workspace members by name, everything else up the `node_modules` chain. */
export function realResolver(workspace) {
  return (name, fromKey) => {
    const member = workspace.get(name);
    if (member) return member;
    let dir = fromKey;
    for (;;) {
      const pjPath = join(dir, 'node_modules', name, 'package.json');
      if (existsSync(pjPath)) return { pj: JSON.parse(readFileSync(pjPath, 'utf8')), key: realpathSync(dirname(pjPath)) };
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  };
}

/** Every workspace member under the roots, by package name. */
export function workspaceMembers(roots = ROOTS) {
  const members = new Map();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const pjPath = join(root, name, 'package.json');
      if (!existsSync(pjPath)) continue;
      const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
      members.set(pj.name, { pj, key: resolve(root, name) });
    }
  }
  return members;
}

function main() {
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

      problems.push(
        ...forbiddenEdgeProblems(
          pj,
          Object.fromEntries(
            surfaces.flatMap(({ files }) => files.map((f) => [relative(dir, f), readFileSync(f, 'utf8')])),
          ),
        ),
      );

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

  const workspace = workspaceMembers();
  const read = realResolver(workspace);
  for (const name of PERMISSIVE_ONLY) {
    const member = workspace.get(name);
    if (!member) {
      // A rename must not silently drop the guard.
      problems.push(`${name}: listed in PERMISSIVE_ONLY but no workspace member has that name`);
      continue;
    }
    const own = licenseProblem(member.pj.license, member.pj.licenses);
    if (own) problems.push(`${name} ${own}`);
    const shipped = {};
    for (const sub of ['src', 'dist']) {
      for (const f of walk(join(member.key, sub))) {
        const isSource = /\.(ts|tsx|mts)$/.test(f) && !f.endsWith('.d.ts') && !f.includes('.generated.');
        if ((sub === 'src' && isSource) || (sub === 'dist' && f.endsWith('.d.ts'))) {
          shipped[relative(member.key, f)] = readFileSync(f, 'utf8');
        }
      }
    }
    problems.push(...shippedImportProblems(member.pj, shipped));
    for (const p of licenseProblems(member.pj, member.key, read)) problems.push(`licence closure: ${p}`);
  }

  if (problems.length > 0) {
    console.error('declared-deps: a package references modules it never declared, an edge K-43 forbids, or a permissive-only package reaches a licence off the allowlist\n');
    for (const p of problems.sort()) console.error(`  ✕ ${p}`);
    console.error(
      `\n${problems.length} problem(s). A published package must declare what its types and code\n` +
        'reference — anything else is relying on another package hoisting it — and a permissive-only\n' +
        'package (PERMISSIVE_ONLY) must reach only allowlisted permissive licences through its runtime dependencies.',
    );
    process.exit(1);
  }

  console.log(
    `declared-deps: ${checkedPackages} packages declare everything they reference, no forbidden edge exists, and ${PERMISSIVE_ONLY.length} permissive-only closures hold only allowlisted licences`,
  );
}

// Run as a command; importable for its test without running the sweep.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
