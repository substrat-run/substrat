// tsx --test tools/permission-diff.test.mts
//
// The permission-diff checkpoint, driven end to end on fixture verticals: the tool itself, run
// with `--root` on a project written to a temp directory, so the rendering AND the drift gate are
// held, not only a function. Today it holds the *Upload links* section, which no vertical in the
// repo declares yet — so `lint:permissions --check` passing says nothing about it on its own.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

interface Target {
  entityType: string;
  readPermission: string;
  writePermission?: string;
  uploadLinks?: { maxBytes: number; contentTypes?: string[] };
}

/** Write (or rewrite) a fixture vertical whose one module declares `targets`. */
const writeFixture = (dir: string, targets: Target[]): string => {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', type: 'module', substrat: { permissions: 'src/p.mjs' } }),
  );
  writeFileSync(
    join(dir, 'src/p.mjs'),
    `export const permissions = {
  entityGrants: [],
  roles: [{ key: 'owner', permissions: ['doc:read', 'doc:write'], source: 'vertical' }],
  modules: [{ manifest: {
    id: '@fixture/docs',
    permissions: [{ key: 'doc:read', description: 'read a document' }, { key: 'doc:write', description: 'attach to a document' }],
    attachmentTargets: ${JSON.stringify(targets)},
  } }],
};`,
  );
  return dir;
};
const run = (dir: string, ...flags: string[]) =>
  spawnSync('pnpm', ['exec', 'tsx', 'tools/permission-diff.mts', '--root', dir, ...flags], { encoding: 'utf8' });
const rendered = (dir: string): string => readFileSync(join(dir, 'PERMISSIONS.md'), 'utf8');

const contract: Target = {
  entityType: 'contract',
  readPermission: 'doc:read',
  writePermission: 'doc:write',
  uploadLinks: { maxBytes: 1048576, contentTypes: ['image/*', 'application/pdf'] },
};
const note: Target = { entityType: 'note', readPermission: 'doc:read', writePermission: 'doc:write' };

test('a target declaring uploadLinks gets a row: the minter’s key, the ceiling, the sorted types, the module', () => {
  const dir = writeFixture(mkdtempSync(join(tmpdir(), 'permission-diff-')), [contract, note]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const md = rendered(dir);
  assert.match(md, /## \d+\. Upload links — what a bearer URL may add/);
  assert.match(md, /\| `contract` \| `doc:write` \| 1048576 \| `application\/pdf`, `image\/\*` \| `@fixture\/docs` \|/);
  // A target with no `uploadLinks` takes no link, and is not listed as if it did.
  assert.doesNotMatch(md, /\| `note` \|/);
});

test('an absent allowlist reads as "any" — the widest policy says so in words', () => {
  const dir = writeFixture(mkdtempSync(join(tmpdir(), 'permission-diff-')), [
    { ...contract, uploadLinks: { maxBytes: 4096 } },
  ]);
  assert.equal(run(dir).status, 0);
  assert.match(rendered(dir), /\| `contract` \| `doc:write` \| 4096 \| any \| `@fixture\/docs` \|/);
});

test('its twin: a vertical that declares no uploadLinks renders no Upload links section at all', () => {
  const dir = writeFixture(mkdtempSync(join(tmpdir(), 'permission-diff-')), [note]);
  assert.equal(run(dir).status, 0);
  assert.doesNotMatch(rendered(dir), /Upload links/);
});

test('widening a link policy is drift: --check refuses until the artifact is regenerated, and the diff names the widening', () => {
  const dir = writeFixture(mkdtempSync(join(tmpdir(), 'permission-diff-')), [contract]);
  assert.equal(run(dir).status, 0);
  const before = rendered(dir);
  assert.equal(run(dir, '--check').status, 0, 'a fresh artifact matches');

  const types = contract.uploadLinks!.contentTypes!;
  for (const widened of [
    // a bigger ceiling
    [{ ...contract, uploadLinks: { maxBytes: 2 * 1048576, contentTypes: types } }],
    // an active type admitted by name
    [{ ...contract, uploadLinks: { maxBytes: 1048576, contentTypes: [...types, 'image/svg+xml'] } }],
    // the allowlist dropped: any type
    [{ ...contract, uploadLinks: { maxBytes: 1048576 } }],
    // a second target opting in
    [contract, { ...note, uploadLinks: { maxBytes: 1 } }],
  ]) {
    writeFixture(dir, widened);
    const check = run(dir, '--check');
    assert.equal(check.status, 1, `a widening must be drift: ${JSON.stringify(widened)}`);
    assert.match(check.stderr, /out of date/);
    assert.equal(run(dir).status, 0);
    assert.notEqual(rendered(dir), before, 'the regenerated artifact shows the change');
    // Back to the reviewed baseline for the next case.
    writeFixture(dir, [contract]);
    assert.equal(run(dir).status, 0);
    assert.equal(rendered(dir), before);
  }
});
