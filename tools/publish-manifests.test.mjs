/**
 * `publish-manifests.mjs`: each refusal beside the allow next to it, so a check that
 * refused everything — or nothing — cannot pass, and the gate's own pack path driven
 * against `pnpm pack` itself, the producer of what ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import semver from 'semver';
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

test('against the producers: `npm publish` is refused by the guard, `pnpm publish` gets past it', () => {
  // --dry-run on both: the lifecycle runs, nothing reaches the registry. npm runs with
  // pnpm's environment inherited — as under `pnpm test` — which must not let it through.
  const dir = join(root, 'packages/control-plane-client');
  const env = { ...process.env, npm_config_user_agent: 'pnpm/10.10.0 npm/? node/v24.0.0' };
  const npm = spawnSync('npm', ['publish', '--dry-run'], { cwd: dir, encoding: 'utf8', env });
  assert.notEqual(npm.status, 0);
  assert.match(npm.stderr, /refusing to publish with npm-cli\.js/);
  const pnpm = spawnSync('pnpm', ['publish', '--dry-run', '--no-git-checks'], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(`${pnpm.stdout}${pnpm.stderr}`, /refusing to publish/);
  assert.equal(pnpm.status, 0, pnpm.stderr);
});

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

test('registry specs: agrees with node-semver on ranges, and accepts dist-tags only by their own grammar', () => {
  const ranges = [
    '^0.135.0', '0.135.0', '~1.2.3', '>=5', '>= 5 <7', '1.x', '*', '', 'x', '^1.0.0-beta.1', '1.2.3+build.5',
    '1.2.3 - 2.0.0', '^1 || ^2', 'v1.2.3', '~>1.2', '<=1.2.3 >0.1',
    'workspace:^', 'workspace:*', 'catalog:', 'file:../x', 'link:../x', 'portal:../x', 'github:a/b',
    'https://example.test/x.tgz', '^1.2.3.4', '01.2.3', '>>1', '1.2.3 -', '^', 'npm:x@1',
  ];
  for (const r of ranges) {
    const valid = semver.validRange(r) !== null;
    // A dist-tag-shaped word is accepted as a tag even where semver says "not a range".
    const tagShaped = /^[A-Za-z][A-Za-z0-9._-]*$/.test(r);
    assert.equal(isRegistrySpec(r), valid || tagShaped, `'${r}': node-semver says ${valid}`);
  }
  for (const tag of ['latest', 'next', 'beta-2', 'rc.1']) assert.equal(isRegistrySpec(tag), true, tag);
});

test('an npm: alias with a workspace: (or any non-registry) range is refused, in every runtime field', () => {
  for (const field of RUNTIME_FIELDS) {
    for (const spec of ['npm:@substrat-run/contracts@workspace:^', 'npm:@substrat-run/contracts@catalog:', 'npm:left-pad@file:../x']) {
      assert.deepEqual(manifestProblems(pkg({ [field]: { c: spec } }), members), [
        `@substrat-run/x@1.0.0: ${field}['c'] is '${spec}' — an npm: alias must name a semver range or dist-tag`,
      ]);
    }
    assert.deepEqual(manifestProblems(pkg({ [field]: { c: 'npm:@substrat-run/contracts@latest' } }), members), []);
  }
});

test('registry mode: an alias with a workspace: range is refused, and never sent to npm as a question', async () => {
  const served = pkg({ dependencies: { c: 'npm:@substrat-run/contracts@workspace:^', '@substrat-run/contracts': 'workspace:^' } });
  // The same check registry mode runs on what npm serves.
  assert.equal(manifestProblems(served, members).length, 2);
  const asked = [];
  const missing = await unresolvedEdges(served, members, async (n, r) => (asked.push(`${n}@${r}`), true), {
    deadline: 60_000,
    ...fakeTime(),
  });
  assert.deepEqual([asked, missing], [[], []]);
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
    { field: 'dependencies', dep: 'c2', name: '@substrat-run/contracts', range: '^0.136.0' },
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
