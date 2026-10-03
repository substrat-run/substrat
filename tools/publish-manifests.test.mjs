/**
 * `publish-manifests.mjs`: each refusal beside the allow next to it, so a check that
 * refused everything — or nothing — cannot pass, and the gate's own pack path driven
 * against `pnpm pack` itself, the producer of what ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEP_FIELDS,
  RUNTIME_FIELDS,
  UNPUBLISHABLE_PROTOCOLS,
  manifestProblems,
  packedManifest,
  pnpmMembers,
} from './publish-manifests.mjs';

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
