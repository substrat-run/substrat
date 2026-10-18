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
import { classifyPermissions, parsePermissions } from '../packages/cli/src/bump.ts';

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

// ─── #2384: the Operations section ───────────────────────────────────────────────────────────

/** A fixture whose one module registers `handlers` with the binder's `checks` (or none at all). */
const writeOpsFixture = (dir: string, operations: unknown): string => {
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
  modules: [{
    manifest: {
      id: '@fixture/docs',
      permissions: [{ key: 'doc:read', description: 'read a document' }, { key: 'doc:write', description: 'write a document' }],
    },
    ${operations === undefined ? '' : `operations: ${JSON.stringify(operations)},`}
  }],
};`,
  );
  return dir;
};
const fresh = () => mkdtempSync(join(tmpdir(), 'permission-diff-ops-'));
const handlers = (...names: string[]) => Object.fromEntries(names.map((n) => [n, {}]));

test('each declared check gets its row: the key and what it narrows to, in the receipt’s grammar', () => {
  const dir = writeOpsFixture(fresh(), {
    handlers: handlers('docs/create', 'docs/edit', 'docs/line', 'docs/timeline', 'docs/attach', 'docs/mine', 'docs/accept', 'docs/raw'),
    checks: {
      'docs/create': { permission: 'doc:write' },
      'docs/edit': { permission: { key: 'doc:write', entity: 'doc', idFrom: 'docId' } },
      'docs/line': { permission: { key: 'doc:write', entity: 'doc', resolved: 'the doc a line sits on' } },
      'docs/timeline': { permission: { key: 'doc:read', entityFrom: 'type', idFrom: 'id' } },
      'docs/attach': { permission: { key: 'doc:write', refFrom: 'subject' } },
      'docs/mine': { narrows: { reason: 'each doc the caller reads', checks: ['doc:read'] } },
      'docs/accept': { narrows: { reason: 'the invite | is the authority', checks: [], unchecked: true } },
    },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const md = rendered(dir);
  assert.match(md, /## \d+\. Operations — which key each checks/);
  const row = (op: string, key: string, on: string) =>
    assert.ok(md.includes(`| \`${op}\` | ${key} | ${on} | \`@fixture/docs\` |`), `${op} row: ${md}`);
  row('docs/create', '`doc:write`', 'the scope');
  row('docs/edit', '`doc:write`', 'one `doc`, id from `docId`');
  row('docs/line', '`doc:write`', 'one `doc`, resolved in the handler: the doc a line sits on');
  row('docs/timeline', '`doc:read`', 'one entity, type from `type`, id from `id`');
  row('docs/attach', '`doc:write`', 'one entity, whole ref from `subject`');
  row('docs/mine', '`doc:read`', 'each row, by a proof walk: each doc the caller reads');
  row('docs/accept', '— none —', 'nothing: the invite \\| is the authority');
  // A handler with no declaration is said to be exactly that — never given a guessed key.
  row('docs/raw', '— checked in code, not declared —', '—');
});

test('its twins: an older binder is "not readable", and no operations is said in words', () => {
  const old = writeOpsFixture(fresh(), { handlers: handlers('docs/create') });
  assert.equal(run(old).status, 0);
  assert.match(rendered(old), /\| `docs\/create` \| — not readable: bound by a kernel that does not carry declarations — \| — \|/);
  assert.doesNotMatch(rendered(old), /not declared —/);

  // Known-empty: an operation map with nothing in it is the one surface that may say "none".
  const none = writeOpsFixture(fresh(), { handlers: {}, checks: {} });
  assert.equal(run(none).status, 0);
  assert.match(rendered(none), /## \d+\. Operations — which key each checks\n[\s\S]*_No module here registers an operation\._/);
  assert.doesNotMatch(rendered(none), /Operations not readable for/);
});

test('a bare manifest\'s operations are UNKNOWN, named under the table — never folded into "none"', () => {
  // All bare: no table, no "none" claim, the module named.
  const bare = writeOpsFixture(fresh(), undefined);
  assert.equal(run(bare).status, 0);
  const md = rendered(bare);
  assert.doesNotMatch(md, /_No module here registers an operation\._/);
  assert.match(md, /^Operations not readable for `@fixture\/docs`: registered as a bare manifest, so its operations are not known here\.$/m);
  // And both readers take it that way: readable, nothing listed, the module named as unknown.
  assert.deepEqual(parsePermissions(md).operationsUnknownFor, ['@fixture/docs']);
  assert.equal(parsePermissions(md).operationsUnreadable, undefined);
});

test('mixed: a registered module\'s rows, and the bare one named under them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'permission-diff-mixed-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', substrat: { permissions: 'src/p.mjs' } }));
  writeFileSync(
    join(dir, 'src/p.mjs'),
    `export const permissions = {
  entityGrants: [],
  roles: [{ key: 'owner', permissions: ['doc:read'], source: 'vertical' }],
  modules: [
    { manifest: { id: '@fixture/docs', permissions: [{ key: 'doc:read', description: 'read a document' }] },
      operations: { handlers: { 'docs/read': {} }, checks: { 'docs/read': { permission: 'doc:read' } } } },
    { manifest: { id: '@fixture/bare', permissions: [] } },
  ],
};`,
  );
  assert.equal(run(dir).status, 0);
  const md = rendered(dir);
  assert.match(md, /\| `docs\/read` \| `doc:read` \| the scope \| `@fixture\/docs` \|\n\nOperations not readable for `@fixture\/bare`:/);
  assert.deepEqual(Object.keys(parsePermissions(md).operations ?? {}), ['docs/read']);
  assert.deepEqual(parsePermissions(md).operationsUnknownFor, ['@fixture/bare']);
});

test('moving an operation to another key is drift: --check refuses until the artifact shows it', () => {
  const dir = writeOpsFixture(fresh(), { handlers: handlers('docs/edit'), checks: { 'docs/edit': { permission: 'doc:write' } } });
  assert.equal(run(dir).status, 0);
  assert.equal(run(dir, '--check').status, 0, 'a fresh artifact matches');
  writeOpsFixture(dir, { handlers: handlers('docs/edit'), checks: { 'docs/edit': { permission: 'doc:read' } } });
  const check = run(dir, '--check');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /out of date/);
  assert.equal(run(dir).status, 0);
  assert.match(rendered(dir), /\| `docs\/edit` \| `doc:read` \| the scope \|/);
});

test('a changed resolution is a changed row: the stated reason is part of the check, and --check refuses', () => {
  const at = (resolved: string) => ({
    handlers: handlers('docs/line'),
    checks: { 'docs/line': { permission: { key: 'doc:write', entity: 'doc', resolved } } },
  });
  const dir = writeOpsFixture(fresh(), at('the doc a line sits on'));
  assert.equal(run(dir).status, 0);
  const before = rendered(dir);
  writeOpsFixture(dir, at("the line's owner"));
  assert.equal(run(dir, '--check').status, 1, 'a reworded resolution must be drift');
  assert.equal(run(dir).status, 0);
  const after = rendered(dir);
  assert.match(after, /resolved in the handler: the line's owner \|/);
  // And the classifier sees it, flagged, on the very rows the emitter wrote.
  const r = classifyPermissions(before, after);
  assert.deepEqual(r.changes.map((c) => [c.path, c.level, c.flagged]), [['operation docs/line', 'minor', true]]);
});

test('round trip: a reason with a pipe reads back as one cell, so "Declared by" stays in its column', () => {
  const dir = writeOpsFixture(fresh(), {
    handlers: handlers('docs/accept'),
    checks: { 'docs/accept': { narrows: { reason: 'the invite | is the authority', checks: [], unchecked: true } } },
  });
  assert.equal(run(dir).status, 0);
  const ops = parsePermissions(rendered(dir)).operations;
  assert.deepEqual(ops?.['docs/accept'], {
    keys: [],
    terms: ['— none —', 'nothing: the invite | is the authority', '`@fixture/docs`'],
  });
});

test('a reworded proof-walk reason is a changed row: --check refuses, and the classifier flags it minor', () => {
  const at = (reason: string) => ({
    handlers: handlers('docs/mine'),
    checks: { 'docs/mine': { narrows: { reason, checks: ['doc:read'] } } },
  });
  const dir = writeOpsFixture(fresh(), at('each doc the caller reads'));
  assert.equal(run(dir).status, 0);
  const before = rendered(dir);
  writeOpsFixture(dir, at('each doc the caller wrote'));
  assert.equal(run(dir, '--check').status, 1, 'a reworded walk reason must be drift');
  assert.equal(run(dir).status, 0);
  const r = classifyPermissions(before, rendered(dir));
  assert.deepEqual(r.changes.map((c) => [c.path, c.level, c.flagged]), [['operation docs/mine', 'minor', true]]);
});
