/**
 * `publish-manifests.mjs`: each refusal beside the allow next to it, so a check that
 * refused everything — or nothing — cannot pass, and the gate's own pack path driven
 * against `pnpm pack` itself, the producer of what ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import npa from 'npm-package-arg';
import {
  DEP_FIELDS,
  RUNTIME_FIELDS,
  UNPUBLISHABLE_PROTOCOLS,
  guardProblem,
  installTarget,
  manifestProblems,
  isRegistrySpec,
  npmViewAnswer,
  packedManifest,
  provenanceNote,
  pnpmMembers,
  unresolvedEdges,
  withOneRetry,
} from './publish-manifests.mjs';
import { PUBLISH_GUARD, publisherProblem } from './publish-guard.mjs';

const members = new Map([
  ['@substrat-run/contracts', { private: false }],
  ['@substrat-run/engine-test-kit', { private: true }],
]);
const pkg = (extra = {}) => ({ name: '@substrat-run/x', version: '1.0.0', ...extra });

test('refuses the manifest @substrat-run/control-plane-client@0.1.0 reached npm with', () => {
  const published = {
    name: '@substrat-run/control-plane-client',
    version: '0.1.0',
    dependencies: { '@substrat-run/contracts': 'workspace:^' },
    devDependencies: { '@types/node': 'catalog:', typescript: 'catalog:', vitest: 'catalog:' },
  };
  assert.deepEqual(manifestProblems(published, members), [
    `@substrat-run/control-plane-client@0.1.0: dependencies['@substrat-run/contracts'] is 'workspace:^' — npm cannot resolve the workspace: protocol`,
    `@substrat-run/control-plane-client@0.1.0: devDependencies['@types/node'] is 'catalog:' — npm cannot resolve the catalog: protocol`,
    `@substrat-run/control-plane-client@0.1.0: devDependencies['typescript'] is 'catalog:' — npm cannot resolve the catalog: protocol`,
    `@substrat-run/control-plane-client@0.1.0: devDependencies['vitest'] is 'catalog:' — npm cannot resolve the catalog: protocol`,
  ]);
});

test('refuses every unpublishable protocol in every dependency field', () => {
  for (const field of DEP_FIELDS) {
    for (const protocol of UNPUBLISHABLE_PROTOCOLS) {
      const spec = `${protocol}*`;
      assert.deepEqual(manifestProblems(pkg({ [field]: { dep: spec } }), members), [
        `@substrat-run/x@1.0.0: ${field}['dep'] is '${spec}' — npm cannot resolve the ${protocol} protocol`,
      ]);
    }
  }
});

test('refuses a runtime dependency on a private workspace member', () => {
  for (const field of RUNTIME_FIELDS) {
    assert.deepEqual(manifestProblems(pkg({ [field]: { '@substrat-run/engine-test-kit': '^0.1.0' } }), members), [
      `@substrat-run/x@1.0.0: ${field}['@substrat-run/engine-test-kit'] is a private workspace member — it is never published`,
    ]);
  }
});

test('allows the twins: rewritten ranges, a public member, a private one as a devDependency, registry packages', () => {
  assert.deepEqual(
    manifestProblems(
      pkg({
        dependencies: { '@substrat-run/contracts': '^0.135.0', esbuild: '^0.28.2' },
        peerDependencies: { typescript: '>=5' },
        optionalDependencies: { fsevents: '2.3.3' },
        devDependencies: { '@substrat-run/engine-test-kit': '^0.1.0', vitest: '^3.2.7' },
      }),
      members,
    ),
    [],
  );
  // A name that merely LOOKS internal but is not a workspace member is a registry package.
  assert.deepEqual(manifestProblems(pkg({ dependencies: { '@substrat-run/gone': '^1.0.0' } }), members), []);
  assert.deepEqual(manifestProblems(pkg(), members), []);
});

test('a protocol is matched at the start only — a URL or a path segment containing it is not', () => {
  assert.deepEqual(manifestProblems(pkg({ dependencies: { a: 'npm:workspace-tools@^1' } }), members), []);
});

const root = resolve(import.meta.dirname, '..');
const workspace = pnpmMembers(root);

test('against the producer: `pnpm pack` rewrites workspace: and catalog:, and the gate reads the rewrite', async () => {
  const dir = join(root, 'packages/control-plane-client');
  const source = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  // The source manifest is what the gate must never be fooled by — prove it is still the
  // unpublishable one, or this test checks nothing.
  assert.match(source.dependencies['@substrat-run/contracts'], /^workspace:/);
  assert.notEqual(manifestProblems(source, workspace).length, 0);

  const packed = await packedManifest(dir);
  assert.equal(packed.name, source.name);
  assert.match(packed.dependencies['@substrat-run/contracts'], /^\^\d/);
  assert.deepEqual(manifestProblems(packed, workspace), []);
});

test('workspace members come from pnpm, with their private flag', () => {
  assert.equal(workspace.get('@substrat-run/control-plane-client')?.private, false);
  assert.equal(workspace.get('@substrat-run/engine-test-kit')?.private, true);
  assert.ok([...workspace.values()].every((m) => !m.path.includes('/.builder/')));
});

test('the publish guard: pnpm passes, npm and an unknown client are refused', () => {
  for (const pnpm of [
    '/home/runner/setup-pnpm/node_modules/.bin/pnpm',
    '/usr/local/lib/node_modules/corepack/shims/../../pnpm/bin/pnpm.cjs',
    '/opt/pnpm/bin/pnpm.js',
  ]) {
    assert.equal(publisherProblem(pnpm), null, pnpm);
  }
  assert.match(publisherProblem('/usr/lib/node_modules/npm/bin/npm-cli.js'), /^refusing to publish with npm-cli\.js/);
  assert.match(publisherProblem('/usr/lib/node_modules/yarn/bin/yarn.js'), /^refusing to publish with yarn\.js/);
  assert.match(publisherProblem(undefined), /^refusing to publish with an unknown client/);
  // The binary's own name, not a directory that happens to say pnpm.
  assert.notEqual(publisherProblem('/home/me/pnpm/npm/bin/npm-cli.js'), null);
});

test('every public package declares the guard, and one that does not is refused', () => {
  assert.equal(guardProblem(pkg({ scripts: { prepublishOnly: PUBLISH_GUARD } })), null);
  for (const scripts of [undefined, {}, { prepublishOnly: 'tsc' }]) {
    assert.match(guardProblem(pkg({ scripts })), /^@substrat-run\/x@1\.0\.0: scripts\.prepublishOnly must be/);
  }
  for (const [name, m] of workspace) {
    if (m.private) continue;
    const pj = JSON.parse(readFileSync(join(m.path, 'package.json'), 'utf8'));
    assert.equal(guardProblem(pj), null, name);
  }
});

test('against the producers: `npm publish` is refused by the guard, `pnpm publish` gets past it', async () => {
  // A real public package cannot be the subject: its version is on npm right after every
  // release, and npm 11's --dry-run refuses to publish over a published version — so the
  // verdict would depend on the registry and on this machine's npm. Instead, a fixture laid
  // out the way every public package is (`<root>/packages/<name>`, declaring PUBLISH_GUARD,
  // which the test above holds every one of them to) runs the real lifecycle against a
  // registry this test serves: it has never heard of anything, and no auth reaches it.
  const fixture = mkdtempSync(join(tmpdir(), 'publish-guard-'));
  const registry = createServer((_, res) => res.writeHead(404, { 'content-type': 'application/json' }).end('{}'));
  try {
    // A copy, not a symlink: node runs a symlinked main module from its real path, and the
    // guard only acts when it is the main module — through a link it would refuse nothing.
    mkdirSync(join(fixture, 'tools'));
    copyFileSync(join(root, 'tools/publish-guard.mjs'), join(fixture, 'tools/publish-guard.mjs'));
    const dir = join(fixture, 'packages/fixture');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.js'), '');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@substrat-run/publish-guard-fixture',
        version: '1.0.0',
        // Outside the repo pnpm would switch to whatever version this machine defaults to;
        // the pin keeps the publisher the one `pnpm release` runs.
        packageManager: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager,
        scripts: { prepublishOnly: PUBLISH_GUARD },
        publishConfig: { access: 'public' },
      }),
    );
    writeFileSync(join(fixture, 'npmrc'), '');
    await new Promise((ready) => registry.listen(0, '127.0.0.1', ready));
    const env = {
      ...process.env,
      npm_config_registry: `http://127.0.0.1:${registry.address().port}/`,
      npm_config_userconfig: join(fixture, 'npmrc'),
    };
    // --dry-run on both: the lifecycle runs, nothing is uploaded. npm runs with pnpm's
    // environment inherited — as under `pnpm test` — which must not let it through.
    const npm = await run('npm', ['publish', '--dry-run'], dir, { ...env, npm_config_user_agent: 'pnpm/10.10.0 npm/? node/v24.0.0' });
    assert.notEqual(npm.status, 0, npm.output);
    assert.match(npm.output, /refusing to publish with npm-cli\.js/);
    const pnpm = await run('pnpm', ['publish', '--dry-run', '--no-git-checks'], dir, env);
    assert.doesNotMatch(pnpm.output, /refusing to publish/);
    assert.equal(pnpm.status, 0, pnpm.output);
  } finally {
    registry.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

/** `spawn`, not `spawnSync`: the stub registry answers from this process's event loop. */
function run(cmd, args, cwd, env) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd, env });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', fail);
    child.on('close', (status) => done({ status, output }));
  });
}

test('an npm: alias installs its target: scoped, unscoped, with and without a range', () => {
  assert.deepEqual(installTarget('kit', 'npm:@substrat-run/engine-test-kit@0.1.0'), { name: '@substrat-run/engine-test-kit', range: '0.1.0' });
  assert.deepEqual(installTarget('b', 'npm:codex-review-b@^1.0.0'), { name: 'codex-review-b', range: '^1.0.0' });
  assert.deepEqual(installTarget('b', 'npm:@scope/b'), { name: '@scope/b', range: 'latest' });
  assert.deepEqual(installTarget('zod', '^3.25.0'), { name: 'zod', range: '^3.25.0' });
});

test('refuses an alias to a private member in every runtime field; allows one to a public member or an external package', () => {
  // The shape `pnpm pack` writes for `"kit": "workspace:@substrat-run/engine-test-kit@*"`.
  for (const field of RUNTIME_FIELDS) {
    assert.deepEqual(manifestProblems(pkg({ [field]: { kit: 'npm:@substrat-run/engine-test-kit@0.1.0' } }), members), [
      `@substrat-run/x@1.0.0: ${field}['kit'] (an alias of @substrat-run/engine-test-kit) is a private workspace member — it is never published`,
    ]);
    assert.deepEqual(manifestProblems(pkg({ [field]: { c: 'npm:@substrat-run/contracts@^0.135.0' } }), members), []);
    assert.deepEqual(manifestProblems(pkg({ [field]: { 'string-width-cjs': 'npm:string-width@^4.2.0' } }), members), []);
  }
  // A devDependency is never installed for a consumer, aliased or not.
  assert.deepEqual(manifestProblems(pkg({ devDependencies: { kit: 'npm:@substrat-run/engine-test-kit@0.1.0' } }), members), []);
});

test("npm view's answers are classified by npm's own error code, pinned", () => {
  // Each row is a shape npm 10 actually prints for `npm view <spec> version --json`.
  const e404 = (summary) => JSON.stringify({ error: { code: 'E404', summary } });
  const table = [
    [{ ok: true, stdout: '"0.135.0"\n' }, true],
    [{ ok: true, stdout: '' }, false],
    [{ ok: false, stdout: e404('No match found for version ^99.0.0'), stderr: 'npm error code E404' }, false],
    [{ ok: false, stdout: e404('Not Found - GET https://registry.npmjs.org/@x%2fy'), stderr: 'npm error code E404' }, false],
    [{ ok: false, stderr: 'npm error code ETARGET\nnpm error notarget No matching version' }, false],
    [{ ok: false, stderr: 'npm error code E429' }, 'transient'],
    [{ ok: false, stderr: 'npm error code E503' }, 'transient'],
    [{ ok: false, stderr: 'npm error code ECONNRESET' }, 'transient'],
    [{ ok: false, stderr: 'npm error code EAI_AGAIN' }, 'transient'],
    // An error about the QUESTION is not an answer about the package — never "found".
    [{ ok: false, stderr: 'npm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "workspace:"' }, undefined],
    [{ ok: false, stderr: 'npm error code EINVALIDTAGNAME' }, undefined],
    [{ ok: false, stderr: 'something npm has never printed' }, undefined],
  ];
  for (const [result, expected] of table) assert.equal(npmViewAnswer(result), expected, JSON.stringify(result));
});

test('a transient answer is asked once more; a second transient, or no answer, throws', async () => {
  const sleep = async () => {};
  const answers = (...xs) => () => Promise.resolve(xs.shift());
  assert.equal(await withOneRetry(answers('transient', true), 'q', { sleep }), true);
  assert.equal(await withOneRetry(answers('transient', false), 'q', { sleep }), false);
  await assert.rejects(withOneRetry(answers('transient', 'transient'), 'q', { sleep }), /q: no answer from the registry \(transient\)/);
  await assert.rejects(withOneRetry(answers(undefined, true), 'q', { sleep }), /q: no answer from the registry \(unexpected error\)/);
});

test('registry specs, pinned: npm-package-arg\'s classification of the whole spec', () => {
  // Regression table. `99+build` and `7+build` are valid ranges a hand-written grammar once
  // refused; `foo.tgz` and its kin are local files a dist-tag approximation once accepted.
  // Both are why this asks npm's own parser instead of imitating it.
  const table = {
    '^0.135.0': true, '0.135.0': true, '~1.2.3': true, '>=5': true, '>= 5 <7': true, '1.x': true, '*': true,
    '': true, '^1.0.0-beta.1': true, '1.2.3+build.5': true, '99+build': true, '7+build': true,
    '1.2.3 - 2.0.0': true, '^1 || ^2': true, 'v1.2.3': true, '~>1.2': true,
    latest: true, next: true, 'beta-2': true, 'rc.1': true, workspace: true,
    'workspace:^': false, 'workspace:*': false, 'catalog:': false, 'file:../x': false, 'link:../x': false,
    'portal:../x': false, 'github:a/b': false, 'a/b': false, 'git+https://github.com/a/b.git': false,
    'git+ssh://git@github.com/a/b.git#v1': false, 'https://example.test/x-1.0.0.tgz': false,
    'foo.tgz': false, 'x.tar': false, 'x.tar.gz': false, './x': false, '../x': false, '~/x': false, '/abs/path': false,
  };
  for (const [spec, expected] of Object.entries(table)) {
    assert.equal(isRegistrySpec(spec), expected, `'${spec}'`);
    // The same spec inside an alias is judged the same way.
    if (spec !== '') assert.equal(isRegistrySpec(`npm:is-number@${spec}`), expected, `'npm:is-number@${spec}'`);
  }
  assert.equal(isRegistrySpec('npm:is-number'), true);
});

test('a +build range is accepted plain and inside an alias, and both are asked of npm', async () => {
  const served = pkg({ dependencies: { '@substrat-run/contracts': '99+build', n: 'npm:is-number@7+build', c: 'npm:@substrat-run/contracts@99+build' } });
  assert.deepEqual(manifestProblems(served, members), []);
  const asked = [];
  await unresolvedEdges(served, members, async (n, r) => (asked.push(`${n}@${r}`), true), { deadline: 60_000, ...fakeTime() });
  assert.deepEqual(asked.sort(), ['@substrat-run/contracts@99+build', '@substrat-run/contracts@99+build']);
});

test('a public package depends only on registry specs: git, github:, URL, tarball and non-range aliases are refused', () => {
  const refuse = (field, dep, spec) =>
    `@substrat-run/x@1.0.0: ${field}['${dep}'] is '${spec}' — a public package may depend only on a semver range or dist-tag`;
  for (const field of RUNTIME_FIELDS) {
    // An https tarball on an INTERNAL dependency, and a git spec on an EXTERNAL one.
    const tarball = 'https://example.test/contracts-0.135.0.tgz';
    assert.deepEqual(manifestProblems(pkg({ [field]: { '@substrat-run/contracts': tarball } }), members), [
      refuse(field, '@substrat-run/contracts', tarball),
    ]);
    for (const spec of [
      'git+https://github.com/jonschlinkert/is-number.git', 'github:jonschlinkert/is-number', 'jonschlinkert/is-number',
      'foo.tgz', 'x.tar', 'x.tar.gz', './x', '../x', '~/x', '/abs/path',
      'npm:is-number@foo.tgz', 'npm:is-number@x.tar.gz', 'npm:is-number@./x', 'npm:is-number@/abs/path',
    ]) {
      assert.deepEqual(manifestProblems(pkg({ [field]: { 'is-number': spec } }), members), [refuse(field, 'is-number', spec)]);
    }
    for (const spec of ['npm:@substrat-run/contracts@workspace:^', 'npm:@substrat-run/contracts@catalog:', 'npm:left-pad@file:../x']) {
      assert.deepEqual(manifestProblems(pkg({ [field]: { c: spec } }), members), [refuse(field, 'c', spec)]);
    }
    assert.deepEqual(manifestProblems(pkg({ [field]: { c: 'npm:@substrat-run/contracts@latest' } }), members), []);
  }
  // A devDependency is never installed for a consumer: what it points at is its own business.
  assert.deepEqual(manifestProblems(pkg({ devDependencies: { 'is-number': 'github:jonschlinkert/is-number' } }), members), []);
});

test('registry mode: a non-registry spec reaching edge resolution is a thrown invariant, never a question to npm', async () => {
  const served = pkg({ dependencies: { c: 'npm:@substrat-run/contracts@workspace:^' } });
  assert.equal(manifestProblems(served, members).length, 1);
  const asked = [];
  await assert.rejects(
    unresolvedEdges(served, members, async (n, r) => (asked.push(`${n}@${r}`), true), { deadline: 60_000, ...fakeTime() }),
    /spec 'npm:@substrat-run\/contracts@workspace:\^' is not a registry spec — refuse it with manifestProblems first/,
  );
  assert.deepEqual(asked, []);
});

/** A clock that only moves when the code under test sleeps. */
function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

const dependent = pkg({
  dependencies: {
    '@substrat-run/contracts': '^0.135.0',
    c2: 'npm:@substrat-run/contracts@^0.136.0',
    '@substrat-run/engine-test-kit': '^0.1.0',
    zod: '^3.25.0',
  },
});

test('registry: a required public member that resolves is fine, and only public members are asked', async () => {
  const asked = [];
  const missing = await unresolvedEdges(dependent, members, async (name, range) => (asked.push(`${name}@${range}`), true), {
    deadline: 60_000,
    ...fakeTime(),
  });
  assert.deepEqual(missing, []);
  // The alias is asked by its TARGET; the private member and the registry package are not asked.
  assert.deepEqual(asked.sort(), ['@substrat-run/contracts@^0.135.0', '@substrat-run/contracts@^0.136.0']);
});

test('registry: inside the window a missing member is a warning, and resolving later clears it', async () => {
  const time = fakeTime();
  const warnings = [];
  let calls = 0;
  const missing = await unresolvedEdges(dependent, members, async () => ++calls > 2, {
    deadline: 180_000,
    interval: 20_000,
    warn: (w) => warnings.push(w),
    ...time,
  });
  assert.deepEqual(missing, []);
  assert.deepEqual(warnings, [
    '@substrat-run/x@1.0.0 requires @substrat-run/contracts@^0.135.0, not on npm yet — asking again',
    '@substrat-run/x@1.0.0 requires @substrat-run/contracts@^0.136.0, not on npm yet — asking again',
  ]);
});

test('registry: after the window a member that never resolved is returned, for the caller to refuse', async () => {
  const time = fakeTime();
  const warnings = [];
  const missing = await unresolvedEdges(dependent, members, async (_, range) => range !== '^0.136.0', {
    deadline: 180_000,
    interval: 20_000,
    warn: (w) => warnings.push(w),
    ...time,
  });
  assert.deepEqual(missing, [
    { field: 'dependencies', dep: 'c2', spec: 'npm:@substrat-run/contracts@^0.136.0', name: '@substrat-run/contracts', range: '^0.136.0' },
  ]);
  // It waited out the window — bounded, not forever and not zero.
  assert.equal(time.now(), 180_000);
  assert.equal(warnings.length, 9);
});

test('registry: a served version without provenance is a note; one with it is not', () => {
  assert.equal(
    provenanceNote({ name: '@substrat-run/control-plane-client', version: '0.1.0', dist: {} }),
    '@substrat-run/control-plane-client@0.1.0 has no provenance attestation — published outside release.yml',
  );
  assert.equal(provenanceNote(pkg({ dist: { attestations: { provenance: {} } } })), null);
});

test("npm-package-arg itself refuses an alias to a non-registry spec — the guarantee isRegistrySpec's alias branch backs up", () => {
  // `isRegistrySpec` also checks an alias's subSpec type, but through this npa that branch
  // is unreachable: npa throws first. Pinned here so an npa upgrade that stops throwing is
  // a red test, not a silent move of the whole guarantee onto the backup branch.
  for (const spec of ['npm:is-number@foo.tgz', 'npm:is-number@github:a/b', 'npm:is-number@https://e.test/x.tgz', 'npm:is-number@./x']) {
    assert.throws(() => npa.resolve('dep', spec), /aliases only work for registry deps/, spec);
  }
});
