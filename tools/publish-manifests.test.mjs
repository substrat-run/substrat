/**
 * `publish-manifests.mjs`: each refusal beside the allow next to it, so a check that
 * refused everything — or nothing — cannot pass. The tarball reader is driven against
 * `pnpm pack` itself, since a reader that only agrees with a hand-built archive proves
 * nothing about the one the gate actually opens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  DEP_FIELDS,
  RUNTIME_FIELDS,
  UNPUBLISHABLE_PROTOCOLS,
  manifestProblems,
  readPackedManifest,
  workspaceMembers,
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

/** A ustar archive of `entries` ([path, body]), gzipped — the shape npm and pnpm write. */
function tgz(entries) {
  const blocks = [];
  for (const [path, body] of entries) {
    const header = Buffer.alloc(512);
    const [prefix, name] = path.length > 100 ? [path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1)] : ['', path];
    header.write(name, 0);
    header.write(Buffer.byteLength(body).toString(8).padStart(11, '0'), 124);
    header.write('0', 156);
    header.write('ustar', 257);
    header.write(prefix, 345);
    const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
    data.write(body);
    blocks.push(header, data);
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test('reads package/package.json past the entries in front of it, and through a ustar prefix', () => {
  const manifest = { name: 'a', version: '1.0.0' };
  const long = `package/${'d'.repeat(120)}/index.js`;
  assert.deepEqual(
    readPackedManifest(tgz([['package/LICENSE', 'x'.repeat(700)], [long, ''], ['package/package.json', JSON.stringify(manifest)]])),
    manifest,
  );
  // The match is on the whole path: a nested package.json is not the package's own.
  assert.throws(
    () => readPackedManifest(tgz([['package/node_modules/y/package.json', '{}']])),
    /no package\/package\.json/,
  );
});

const root = resolve(import.meta.dirname, '..');

test('against the producer: `pnpm pack` rewrites workspace: and catalog:, and the reader sees the rewrite', () => {
  const dir = join(root, 'packages/control-plane-client');
  const source = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  // The source manifest is what the gate must never be fooled by — prove it is still the
  // unpublishable one, or this test checks nothing.
  assert.match(source.dependencies['@substrat-run/contracts'], /^workspace:/);
  assert.notEqual(manifestProblems(source, workspaceMembers(root)).length, 0);

  const dest = mkdtempSync(join(tmpdir(), 'publish-manifests-test-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', dest], { cwd: dir, stdio: 'pipe' });
    const [file] = readdirSync(dest);
    const packed = readPackedManifest(readFileSync(join(dest, file)));
    assert.equal(packed.name, source.name);
    assert.match(packed.dependencies['@substrat-run/contracts'], /^\^\d/);
    assert.deepEqual(manifestProblems(packed, workspaceMembers(root)), []);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('workspace members come from pnpm, with their private flag', () => {
  const all = workspaceMembers(root);
  assert.equal(all.get('@substrat-run/control-plane-client')?.private, false);
  assert.equal(all.get('@substrat-run/engine-test-kit')?.private, true);
  assert.ok([...all.values()].every((m) => !m.path.includes('/.builder/')));
});
