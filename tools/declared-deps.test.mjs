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
  PERMISSIVE_ONLY,
  forbiddenEdgeProblems,
  licenseProblem,
  licenseProblems,
  realResolver,
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
    }
    // The positive twin on the real tree: the resolver does see the AGPL server's closure.
    const api = workspace.get('@substrat-run/control-plane-api');
    assert.ok(licenseProblems({ name: 'probe', dependencies: { [api.pj.name]: '*' } }, root, realResolver(workspace)).length > 0);
  } finally {
    process.chdir(cwd);
  }
});
