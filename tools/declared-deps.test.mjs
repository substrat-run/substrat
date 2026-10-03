/**
 * The K-43 guard in `declared-deps.mjs`: the kernel and the adapters never depend on the
 * attachment parsers. Each refusal beside the allow next to it, so a check that refused
 * everything — or nothing — cannot pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  FORBIDDEN_EDGES,
  PERMISSIVE_EXCEPTIONS,
  PERMISSIVE_LICENSES,
  PERMISSIVE_ONLY,
  forbiddenEdgeProblems,
  licenseProblem,
  licenseProblems,
  realResolver,
  shippedFilesOf,
  shippedImportProblems,
  spdxPermissive,
  workspaceMembers,
} from './declared-deps.mjs';

const PARSERS = '@substrat-run/attachment-extractors';
const kernel = (extra = {}) => ({ name: '@substrat-run/kernel', ...extra });
const adapter = (extra = {}) => ({ name: '@substrat-run/adapter-sqlite', ...extra });

test('refuses the parsers as a runtime dependency of the kernel or an adapter', () => {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.deepEqual(forbiddenEdgeProblems(kernel({ [field]: { [PARSERS]: 'workspace:^' } }), {}), [
      `@substrat-run/kernel declares '${PARSERS}' in ${field} (K-43)`,
    ]);
  }
  assert.equal(forbiddenEdgeProblems(adapter({ dependencies: { [PARSERS]: 'workspace:^' } }), {}).length, 1);
});

test('refuses a reference in source or shipped types — an import, a re-export, a type import', () => {
  for (const text of [
    `import { defaultAttachmentExtractors } from '${PARSERS}';`,
    `export { textExtractor } from '${PARSERS}';`,
    `export declare const x: import('${PARSERS}').ExtractorBounds;`,
  ]) {
    assert.deepEqual(forbiddenEdgeProblems(adapter(), { 'src/index.ts': text }), [
      `@substrat-run/adapter-sqlite references '${PARSERS}' in src/index.ts (K-43)`,
    ]);
  }
});

test('allows the twins: an adapter devDependency, a comment naming it, and any other package', () => {
  assert.deepEqual(forbiddenEdgeProblems(adapter({ devDependencies: { [PARSERS]: 'workspace:^' } }), {}), []);
  assert.deepEqual(
    forbiddenEdgeProblems(adapter(), { 'src/index.ts': `// passed in by the host, never imported from '${PARSERS}'` }),
    [],
  );
  assert.deepEqual(
    forbiddenEdgeProblems(
      { name: '@substrat-run/contract-tests', dependencies: { [PARSERS]: 'workspace:^' } },
      { 'src/x.ts': `import { textExtractor } from '${PARSERS}';` },
    ),
    [],
  );
});

test('names the kernel and both adapters, and the repo as it stands has no forbidden edge', () => {
  assert.deepEqual(Object.keys(FORBIDDEN_EDGES).sort(), [
    '@substrat-run/adapter-cloudflare',
    '@substrat-run/adapter-sqlite',
    '@substrat-run/kernel',
  ]);
  const root = new URL('..', import.meta.url).pathname;
  const walk = (dir, out = []) => {
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (e === 'node_modules') continue;
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|mts)$/.test(p)) out.push(p);
    }
    return out;
  };
  for (const dir of ['packages/kernel', 'packages/adapter-sqlite', 'packages/adapter-cloudflare']) {
    const abs = join(root, dir);
    const pj = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
    const files = Object.fromEntries(
      [...walk(join(abs, 'src')), ...walk(join(abs, 'dist'))].map((f) => [relative(abs, f), readFileSync(f, 'utf8')]),
    );
    assert.deepEqual(forbiddenEdgeProblems(pj, files), [], dir);
  }
});

/**
 * The licence guard (#971): the CLI and the control-plane client are Apache-2.0, and a
 * dependency is the quiet way to make that untrue. A literal graph stands in for the
 * workspace so every shape is judged beside its twin.
 */
const graph = (pkgs) => (name) => (pkgs[name] ? { pj: { name, ...pkgs[name] }, key: name } : null);
const CLI = { name: '@substrat-run/cli', license: 'Apache-2.0' };

test('licenseProblem: an allowlist — refuses the copyleft family AND every licence it was never told about', () => {
  for (const bad of [
    'AGPL-3.0-only',
    'AGPL-3.0-or-later',
    'GPL-3.0',
    'LGPL-2.1',
    'SSPL-1.0',
    'BUSL-1.1',
    // File-level copyleft a GPL-shaped pattern never caught.
    'MPL-2.0',
    'EPL-2.0',
    'CDDL-1.0',
    // Not a licence at all, or not one we can read.
    'UNLICENSED',
    'SEE LICENSE IN LICENSE.md',
    'Some-Brand-New-Licence-1.0',
    'MIT OR',
    '(MIT',
    'MIT AND AND ISC',
  ]) {
    assert.ok(licenseProblem(bad), bad);
  }
  assert.equal(licenseProblem(undefined), 'declares no licence');
  assert.equal(licenseProblem('  '), 'declares no licence');
  assert.match(licenseProblem('MPL-2.0'), /^is MPL-2\.0, which is not on the permissive allowlist$/);
  for (const ok of ['Apache-2.0', 'MIT', 'ISC', 'BSD-3-Clause', '0BSD', 'Unlicense', 'apache-2.0', 'MIT-0', 'Zlib']) {
    assert.equal(licenseProblem(ok), null, ok);
  }
});

test('licenseProblem: SPDX expressions — OR passes on either side, AND needs both, AND binds tighter, WITH never rescues', () => {
  // OR: the consumer may pick the permissive side.
  assert.equal(licenseProblem('(MIT OR Apache-2.0)'), null);
  assert.equal(licenseProblem('MIT OR GPL-3.0'), null);
  assert.equal(licenseProblem('GPL-3.0 OR MPL-2.0'), 'is GPL-3.0 OR MPL-2.0, which is not on the permissive allowlist');
  // AND: every side applies.
  assert.equal(licenseProblem('MIT AND ISC'), null);
  assert.ok(licenseProblem('MIT AND GPL-3.0'));
  assert.ok(licenseProblem('(MIT OR Apache-2.0) AND MPL-2.0'));
  // AND binds tighter than OR: `MIT OR (ISC AND GPL)` is permissive, `(MIT OR ISC) AND GPL` is not.
  assert.equal(licenseProblem('MIT OR ISC AND GPL-3.0'), null);
  assert.ok(licenseProblem('GPL-3.0 AND MIT OR MPL-2.0'));
  // WITH: judged on the licence it qualifies, so an exception does not launder copyleft.
  assert.ok(licenseProblem('GPL-2.0 WITH Classpath-exception-2.0'));
  assert.equal(licenseProblem('Apache-2.0 WITH LLVM-exception'), null);
  // The legacy `licenses` array: alternatives.
  assert.equal(licenseProblem(undefined, [{ type: 'MIT' }, { type: 'GPL-3.0' }]), null);
  assert.ok(licenseProblem(undefined, [{ type: 'GPL-3.0' }, { type: 'MPL-2.0' }]));
  assert.equal(licenseProblem({ type: 'MIT' }), null);
});

test('spdxPermissive: an expression that is not in the SPDX grammar is refused, whatever permissive words it holds', () => {
  for (const malformed of [
    'MIT WITH OR',
    'MIT WITH (',
    'MIT WITH )',
    'MIT WITH',
    'MIT WITH AND ISC',
    'MIT WITH Foo WITH Bar',
    'OR MIT',
    'MIT OR',
    'MIT OR OR ISC',
    'MIT AND',
    '()',
    '( )',
    '',
    '(MIT',
    'MIT)',
    '((MIT)',
    'MIT ISC',
    'MIT, ISC',
    'MIT/ISC',
    'Apache 2.0',
    'MIT@1',
    // A permissive side never rescues a broken one: the whole string must parse.
    'MIT OR GPL-3.0 WITH (',
    'MIT OR ISC )',
    'MIT OR (ISC AND',
  ]) {
    assert.equal(spdxPermissive(malformed), false, JSON.stringify(malformed));
  }
});

test('spdxPermissive: well-formed expressions — nesting, precedence, WITH, `+`, case — judged by their licences', () => {
  for (const ok of [
    'MIT',
    '(MIT)',
    '((MIT))',
    'MIT OR ISC',
    '(MIT AND (ISC OR GPL-3.0))',
    '(GPL-3.0 OR (MIT AND ISC)) AND Apache-2.0',
    'Apache-2.0 WITH LLVM-exception',
    'Apache-2.0 WITH LLVM-exception AND MIT',
    '(Apache-2.0 WITH LLVM-exception) OR GPL-3.0',
    'Apache-2.0+',
    'mit or isc',
    'MIT and ISC',
  ]) {
    assert.equal(spdxPermissive(ok), true, ok);
  }
  for (const no of [
    'GPL-3.0',
    'GPL-2.0+',
    'GPL-2.0 WITH Classpath-exception-2.0',
    '(MIT OR Apache-2.0) AND MPL-2.0',
    'GPL-3.0 OR (MPL-2.0 AND MIT)',
    '((GPL-3.0))',
    'MIT AND (GPL-3.0 OR MPL-2.0)',
  ]) {
    assert.equal(spdxPermissive(no), false, no);
  }
});

test('spdxPermissive: WITH takes a simple licence on the left and an ALLOWLISTED exception on the right', () => {
  // The three shapes that parsed but should not: another licence as the "exception", a LicenseRef, a group on the left.
  for (const bad of [
    'MIT WITH AGPL-3.0-only',
    'MIT WITH LicenseRef-unknown',
    '(MIT OR GPL-3.0) WITH LLVM-exception',
    // Likewise: an addition ref, a document ref, an unreviewed real exception, a group however trivial.
    'MIT WITH AdditionRef-custom',
    'MIT WITH DocumentRef-x:AdditionRef-y',
    'MIT WITH Classpath-exception-2.0',
    '(MIT) WITH LLVM-exception',
    '(Apache-2.0 AND MIT) WITH LLVM-exception',
    // The exception never rescues a licence that was not allowed.
    'GPL-3.0 WITH LLVM-exception',
    'MPL-2.0 WITH LLVM-exception',
    // …nor a broken neighbour.
    'Apache-2.0 WITH LLVM-exception AND (',
  ]) {
    assert.equal(spdxPermissive(bad), false, bad);
  }
  // The positive twins: a reviewed exception on a permissive licence, any case, inside bigger expressions.
  for (const ok of [
    'Apache-2.0 WITH LLVM-exception',
    'apache-2.0 with llvm-exception',
    'Apache-2.0+ WITH LLVM-exception',
    'MIT OR (Apache-2.0 WITH LLVM-exception)',
    'Apache-2.0 WITH LLVM-exception AND MIT',
  ]) {
    assert.equal(spdxPermissive(ok), true, ok);
  }
  assert.deepEqual([...PERMISSIVE_EXCEPTIONS], ['llvm-exception']);
});

test('spdxPermissive: a LicenseRef is a licence nobody named — refused unless allowlisted by its full spelling', () => {
  for (const ref of ['LicenseRef-Custom', 'LicenseRef-Custom OR GPL-3.0', 'DocumentRef-x:LicenseRef-y', 'MIT AND LicenseRef-Custom']) {
    assert.equal(spdxPermissive(ref), false, ref);
  }
  // The positive twin: once someone allowlists it in review, it passes — and a malformed ref still does not.
  PERMISSIVE_LICENSES.add('licenseref-custom');
  try {
    assert.equal(spdxPermissive('LicenseRef-Custom'), true);
    assert.equal(spdxPermissive('MIT AND LicenseRef-Custom'), true);
    assert.equal(spdxPermissive('LicenseRef-Custom WITH'), false);
    assert.equal(spdxPermissive('LicenseRef-'), false);
  } finally {
    PERMISSIVE_LICENSES.delete('licenseref-custom');
  }
  assert.equal(spdxPermissive('LicenseRef-Custom'), false);
});

test('refuses an AGPL package as a direct runtime dependency, whichever field declares it', () => {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const read = graph({ '@substrat-run/control-plane-api': { license: 'AGPL-3.0-only' } });
    assert.deepEqual(
      licenseProblems({ ...CLI, [field]: { '@substrat-run/control-plane-api': 'workspace:^' } }, 'cli', read),
      ['@substrat-run/cli → @substrat-run/control-plane-api is AGPL-3.0-only, which is not on the permissive allowlist'],
      field,
    );
  }
});

test('refuses it through a permissive package, naming the path — the closure, not just the edge', () => {
  const read = graph({
    '@substrat-run/control-plane-client': { license: 'Apache-2.0', dependencies: { hono: '^4' } },
    hono: { license: 'MIT', dependencies: { '@substrat-run/kernel': '*' } },
    '@substrat-run/kernel': { license: 'AGPL-3.0-only' },
  });
  assert.deepEqual(
    licenseProblems({ ...CLI, dependencies: { '@substrat-run/control-plane-client': '*' } }, 'cli', read),
    ['@substrat-run/cli → @substrat-run/control-plane-client → hono → @substrat-run/kernel is AGPL-3.0-only, which is not on the permissive allowlist'],
  );
});

test('refuses a dependency whose licence the allowlist has never heard of (MPL-2.0, EPL-2.0, CDDL-1.0, UNLICENSED), by name and path', () => {
  for (const license of ['MPL-2.0', 'EPL-2.0', 'CDDL-1.0', 'UNLICENSED']) {
    const read = graph({ lib: { license } });
    assert.deepEqual(licenseProblems({ ...CLI, dependencies: { lib: '1' } }, 'cli', read), [
      `@substrat-run/cli → lib is ${license}, which is not on the permissive allowlist`,
    ]);
  }
});

test('allows the twins: a devDependency, a permissive closure, a cycle, and an unresolved optional one', () => {
  const read = graph({
    '@substrat-run/control-plane-api': { license: 'AGPL-3.0-only' },
    esbuild: { license: 'MIT', optionalDependencies: { '@esbuild/other-platform': '1' } },
    a: { license: 'MIT', dependencies: { b: '1' } },
    b: { license: 'ISC', dependencies: { a: '1' } },
  });
  assert.deepEqual(
    licenseProblems(
      {
        ...CLI,
        dependencies: { esbuild: '1', a: '1' },
        devDependencies: { '@substrat-run/control-plane-api': 'workspace:^' },
      },
      'cli',
      read,
    ),
    [],
  );
});

test('refuses what it cannot judge: a required dependency it cannot resolve, a dependency with no licence', () => {
  assert.deepEqual(licenseProblems({ ...CLI, dependencies: { ghost: '1' } }, 'cli', graph({})), [
    '@substrat-run/cli → ghost: cannot be resolved — run `pnpm install`',
  ]);
  assert.deepEqual(licenseProblems({ ...CLI, dependencies: { mystery: '1' } }, 'cli', graph({ mystery: {} })), [
    '@substrat-run/cli → mystery declares no licence',
  ]);
});

test('an unresolved peer is skipped like an optional one — but a name that is also a regular dependency must resolve', () => {
  assert.deepEqual(licenseProblems({ ...CLI, peerDependencies: { react: '*' } }, 'cli', graph({})), []);
  assert.deepEqual(licenseProblems({ ...CLI, optionalDependencies: { fsevents: '*' } }, 'cli', graph({})), []);
  // Declared as both a regular and a peer dependency: the regular one wins, so absence is a problem.
  assert.deepEqual(
    licenseProblems({ ...CLI, dependencies: { react: '*' }, peerDependencies: { react: '*' } }, 'cli', graph({})),
    ['@substrat-run/cli → react: cannot be resolved — run `pnpm install`'],
  );
  // A peer that DOES resolve is still judged.
  assert.deepEqual(
    licenseProblems({ ...CLI, peerDependencies: { lib: '*' } }, 'cli', graph({ lib: { license: 'GPL-3.0' } })),
    ['@substrat-run/cli → lib is GPL-3.0, which is not on the permissive allowlist'],
  );
});

test('two versions of one package are two packages: only the copyleft one is flagged, wherever it sits', () => {
  // cli → a → shared@1 (MIT), cli → b → shared@2 (AGPL): a walk keyed by NAME judges the first and skips the second.
  const instances = {
    'a→shared': { key: 'shared@1', pj: { name: 'shared', version: '1.0.0', license: 'MIT' } },
    'b→shared': { key: 'shared@2', pj: { name: 'shared', version: '2.0.0', license: 'AGPL-3.0-only' } },
  };
  const read = (name, from) =>
    ({
      a: { key: 'a', pj: { name: 'a', license: 'MIT', dependencies: { shared: '^1' } } },
      b: { key: 'b', pj: { name: 'b', license: 'MIT', dependencies: { shared: '^2' } } },
    })[name] ?? instances[`${from}→${name}`] ?? null;
  assert.deepEqual(licenseProblems({ ...CLI, dependencies: { a: '*', b: '*' } }, 'cli', read), [
    '@substrat-run/cli → b → shared is AGPL-3.0-only, which is not on the permissive allowlist',
  ]);
  // Order must not matter.
  assert.deepEqual(licenseProblems({ ...CLI, dependencies: { b: '*', a: '*' } }, 'cli', read), [
    '@substrat-run/cli → b → shared is AGPL-3.0-only, which is not on the permissive allowlist',
  ]);
});

test('the same instance reached twice (a diamond) and a cycle through the root are each walked once', () => {
  let reads = 0;
  const pkgs = {
    a: { key: 'a', pj: { name: 'a', license: 'MIT', dependencies: { shared: '1', cli: '*' } } },
    b: { key: 'b', pj: { name: 'b', license: 'MIT', dependencies: { shared: '1' } } },
    shared: { key: 'shared@1', pj: { name: 'shared', license: 'GPL-3.0' } },
    cli: { key: 'cli', pj: CLI },
  };
  const read = (name) => (reads++, pkgs[name] ?? null);
  // One report for the shared instance, not one per path; the cycle back to the root ends.
  assert.deepEqual(licenseProblems({ ...CLI, dependencies: { a: '*', b: '*' } }, 'cli', read), [
    '@substrat-run/cli → a → shared is GPL-3.0, which is not on the permissive allowlist',
  ]);
  assert.ok(reads < 20, `terminated after ${reads} reads`);
});

test('shipped source may import only what it ships with: a src import of a dev-only dependency is refused, a test import is not', () => {
  const pj = {
    ...CLI,
    dependencies: { esbuild: '1' },
    peerDependencies: { react: '*' },
    devDependencies: { vitest: '1', '@substrat-run/control-plane-api': 'workspace:^' },
  };
  assert.deepEqual(
    shippedImportProblems(pj, { 'src/push.ts': "import { createControlPlaneApi } from '@substrat-run/control-plane-api';" }),
    [
      "@substrat-run/cli ships an import of '@substrat-run/control-plane-api' in src/push.ts, but declares it only as a devDependency — the published package reaches it at run time, where it is not installed",
    ],
  );
  // The emitted types are shipped too.
  assert.equal(
    shippedImportProblems(pj, { 'dist/x.d.ts': "export declare const y: import('vitest').T;" }).length,
    1,
  );
  // The twins: a test or tool may import a dev-only dependency; src may import dependencies, peers, itself.
  assert.deepEqual(shippedImportProblems(pj, { 'test/x.test.ts': "import { it } from 'vitest';" }), []);
  assert.deepEqual(
    shippedImportProblems(pj, {
      'src/a.ts': "import { build } from 'esbuild';\nimport React from 'react';\nimport { z } from '@substrat-run/cli';",
    }),
    [],
  );
  // A name that is a dependency AND a devDependency is shipped.
  assert.deepEqual(
    shippedImportProblems({ ...pj, devDependencies: { esbuild: '1' } }, { 'src/a.ts': "import 'esbuild';" }),
    [],
  );
});

test('the shipped OUTPUT is the authority: dist JS and .d.ts are judged, and an erased `import type` in src is not a finding', () => {
  const pj = { ...CLI, dependencies: { esbuild: '1' }, devDependencies: { vitest: '1', '@babel/types': '1' } };
  const refused = (spec, where) =>
    `@substrat-run/cli ships an import of '${spec}' in ${where}, but declares it only as a devDependency — the published package reaches it at run time, where it is not installed`;
  // A source-excluded generated file emits a dist JS that imports a dev-only package: only dist shows it.
  for (const [where, text] of [
    ['dist/gen.js', "import { it } from 'vitest';\nexport { it };"],
    ['dist/gen.mjs', "export * from 'vitest';"],
    ['dist/cjs.cjs', "const v = require('vitest');"],
    ['dist/lazy.js', "export const load = () => import('vitest');"],
    ['dist/types.d.ts', "export declare const x: import('vitest').T;"],
  ]) {
    assert.deepEqual(shippedImportProblems(pj, { [where]: text }), [refused('vitest', where)], where);
  }
  // Erased: type-only statements in src (single- and multi-line) reach neither the JS nor the package…
  assert.deepEqual(
    shippedImportProblems(pj, {
      'src/a.ts': [
        "import type { T } from 'vitest';",
        'import type {',
        '  A,',
        "  B,",
        "} from '@babel/types';",
        "export type { T } from 'vitest';",
        "import { build } from 'esbuild';",
      ].join('\n'),
    }),
    [],
  );
  // …but a value import, and an inline `type` specifier (which can survive as a side-effect import), are findings.
  assert.deepEqual(shippedImportProblems(pj, { 'src/a.ts': "import { it } from 'vitest';" }), [refused('vitest', 'src/a.ts')]);
  assert.deepEqual(shippedImportProblems(pj, { 'src/a.ts': "import { type T } from 'vitest';" }), [refused('vitest', 'src/a.ts')]);
  // A type that LEAKS into the emitted declarations is caught there, which is what a consumer sees.
  assert.deepEqual(
    shippedImportProblems(pj, { 'src/a.ts': "import type { T } from 'vitest';", 'dist/a.d.ts': "import type { T } from 'vitest';" }),
    [refused('vitest', 'dist/a.d.ts')],
  );
  // Neither dist twin: an import of a shipped dependency, and files outside src/ and dist/.
  assert.deepEqual(shippedImportProblems(pj, { 'dist/ok.js': "import 'esbuild';", 'tools/x.mjs': "import 'vitest';" }), []);
});

test('the guarded packages exist, are themselves permissive, and the repo as it stands holds the rule', () => {
  const root = new URL('..', import.meta.url).pathname;
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const workspace = workspaceMembers();
    assert.deepEqual([...PERMISSIVE_ONLY].sort(), ['@substrat-run/cli', '@substrat-run/control-plane-client']);
    for (const name of PERMISSIVE_ONLY) {
      const member = workspace.get(name);
      assert.ok(member, `${name} is a workspace member`);
      assert.equal(licenseProblem(member.pj.license), null, name);
      assert.deepEqual(licenseProblems(member.pj, member.key, realResolver(workspace)), [], name);
      // The scan reads the emitted JS and types, not only the sources (the positive twin: it sees them).
      const shipped = Object.keys(shippedFilesOf(member.key));
      assert.ok(shipped.some((f) => /^dist\/.*\.js$/.test(f)), `${name}: dist JS is scanned`);
      assert.ok(shipped.some((f) => /^dist\/.*\.d\.ts$/.test(f)), `${name}: dist types are scanned`);
      assert.ok(shipped.some((f) => f.startsWith('src/')), `${name}: src is scanned`);
      assert.deepEqual(shippedImportProblems(member.pj, shippedFilesOf(member.key)), [], name);
    }
    // The positive twin on the real tree: the resolver does see the AGPL server's closure.
    const api = workspace.get('@substrat-run/control-plane-api');
    assert.ok(licenseProblems({ name: 'probe', dependencies: { [api.pj.name]: '*' } }, root, realResolver(workspace)).length > 0);
  } finally {
    process.chdir(cwd);
  }
});
