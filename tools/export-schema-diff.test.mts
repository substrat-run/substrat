import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyExports, run } from './export-schema-diff.mts';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), 'export-schema-diff.mts');

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const exp = (schemaVersion: number, payload: Record<string, unknown>) => ({ schemaVersion, readPermission: 'r:read', payload });
const base = { 'crm.customer-created': exp(1, obj({ id: { type: 'string' }, name: { type: 'string' } }, ['id', 'name'])) };
const rules = (head: Record<string, ReturnType<typeof exp>>) =>
  classifyExports('m.json', base, head).map((v) => `${v.rule}:${v.field ?? '-'}`);

test('a removed field at the same version is refused; bumped, it passes', () => {
  const head = { 'crm.customer-created': exp(1, obj({ id: { type: 'string' } }, ['id'])) };
  assert.deepEqual(rules(head), ['removed:name']);
  assert.deepEqual(rules({ 'crm.customer-created': exp(2, obj({ id: { type: 'string' } }, ['id'])) }), []);
});

test('a retyped field is refused; a changed description is not a retype', () => {
  const retyped = { 'crm.customer-created': exp(1, obj({ id: { type: 'string' }, name: { type: 'number' } }, ['id', 'name'])) };
  assert.deepEqual(rules(retyped), ['retyped:name']);
  const described = {
    'crm.customer-created': exp(1, obj({ id: { type: 'string' }, name: { type: 'string', description: 'the name' } }, ['id', 'name'])),
  };
  assert.deepEqual(rules(described), []);
});

test('a newly required field is refused — events already sent at this version lack it; a new optional one passes', () => {
  const required = {
    'crm.customer-created': exp(1, obj({ id: { type: 'string' }, name: { type: 'string' }, org: { type: 'string' } }, ['id', 'name', 'org'])),
  };
  assert.deepEqual(rules(required), ['newly-required:org']);
  const optional = {
    'crm.customer-created': exp(1, obj({ id: { type: 'string' }, name: { type: 'string' }, org: { type: 'string' } }, ['id', 'name'])),
  };
  assert.deepEqual(rules(optional), []);
});

test('a field no longer required is refused', () => {
  const loosened = { 'crm.customer-created': exp(1, obj({ id: { type: 'string' }, name: { type: 'string' } }, ['id'])) };
  assert.deepEqual(rules(loosened), ['no-longer-required:name']);
});

test('a schemaVersion that went down is refused; a dropped export is the promote gate\'s, not this one\'s', () => {
  const b2 = { t: exp(2, obj({ id: { type: 'string' } }, ['id'])) };
  assert.deepEqual(
    classifyExports('m.json', b2, { t: exp(1, obj({ id: { type: 'string' } }, ['id'])) }).map((v) => v.rule),
    ['version-down'],
  );
  assert.deepEqual(classifyExports('m.json', b2, {}), []);
  // A new export is additive.
  assert.deepEqual(classifyExports('m.json', {}, b2), []);
});

test('a break inside $defs is found: references are resolved before anything is compared', () => {
  const org = (required: string[]) => ({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required });
  const payload = (required: string[]) => ({
    type: 'object',
    properties: { org: { $ref: '#/$defs/Org' }, parent: { $ref: '#/$defs/Org' } },
    required: ['org'],
    $defs: { Org: org(required) },
  });
  const b = { t: exp(1, payload(['id', 'name'])) };
  // Loosened INSIDE the definition: both references still read {"$ref": "#/$defs/Org"}.
  assert.deepEqual(
    classifyExports('m.json', b, { t: exp(1, payload(['id'])) }).map((v) => `${v.rule}:${v.field}`),
    ['no-longer-required:org.name', 'no-longer-required:parent.name'],
  );
  // The twin: the same definition, and nothing is found.
  assert.deepEqual(classifyExports('m.json', b, { t: exp(1, payload(['id', 'name'])) }), []);
  // A payload that IS a reference is resolved too, and a field removed there is a removal.
  const top = (props: Record<string, unknown>) => ({ $ref: '#/$defs/P', $defs: { P: { type: 'object', properties: props, required: [] } } });
  assert.deepEqual(
    classifyExports('m.json', { t: exp(1, top({ id: { type: 'string' }, gone: { type: 'string' } })) }, { t: exp(1, top({ id: { type: 'string' } })) }).map(
      (v) => `${v.rule}:${v.field}`,
    ),
    ['removed:gone'],
  );
});

test('inside a nested object, an optional field added is additive, and a removed or newly required one is a break', () => {
  const org = (props: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: props, required, additionalProperties: false });
  const p = (o: unknown) => obj({ org: o }, ['org']);
  const base = { t: exp(1, p(org({ id: { type: 'string' } }, ['id']))) };
  // org: { id } -> org: { id, note? } is additive.
  assert.deepEqual(classifyExports('m.json', base, { t: exp(1, p(org({ id: { type: 'string' }, note: { type: 'string' } }, ['id']))) }), []);
  // ...required, it is a break at its own path.
  assert.deepEqual(
    classifyExports('m.json', base, { t: exp(1, p(org({ id: { type: 'string' }, note: { type: 'string' } }, ['id', 'note']))) }).map(
      (v) => `${v.rule}:${v.field}`,
    ),
    ['newly-required:org.note'],
  );
  // A nested field removed or retyped is named at its path.
  assert.deepEqual(
    classifyExports('m.json', base, { t: exp(1, p(org({}, []))) }).map((v) => `${v.rule}:${v.field}`),
    ['removed:org.id'],
  );
  assert.deepEqual(
    classifyExports('m.json', base, { t: exp(1, p(org({ id: { type: 'number' } }, ['id']))) }).map((v) => `${v.rule}:${v.field}`),
    ['retyped:org.id'],
  );
  // An object that stops being one is a retype of the field.
  assert.deepEqual(classifyExports('m.json', base, { t: exp(1, p({ type: 'string' })) }).map((v) => `${v.rule}:${v.field}`), ['retyped:org']);
});

test('a change inside anyOf/oneOf is a retype', () => {
  const p = (alts: unknown[]) => obj({ v: { anyOf: alts } }, ['v']);
  assert.deepEqual(
    classifyExports('m.json', { t: exp(1, p([{ type: 'string' }, { type: 'number' }])) }, { t: exp(1, p([{ type: 'string' }])) }).map((v) => v.rule),
    ['retyped'],
  );
});

test('a self-referencing definition resolves without looping', () => {
  const node = { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } };
  const payload = { type: 'object', properties: { head: { $ref: '#/$defs/Node' } }, required: [], $defs: { Node: node } };
  assert.deepEqual(classifyExports('m.json', { t: exp(1, payload) }, { t: exp(1, payload) }), []);
});

// -- against a real repository --------------------------------------------------------------

function repo(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'export-schema-diff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 't');
  const write = (model: unknown) => {
    mkdirSync(join(dir, 'demos/crm'), { recursive: true });
    writeFileSync(join(dir, 'demos/crm/model.json'), JSON.stringify(model, null, 2));
  };
  return { dir, g, write };
}

test('against the base branch: a break is found, and the twin (the same change, bumped) passes', (t) => {
  const { dir, g, write } = repo(t);
  write({ entities: {}, exports: base });
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'change');
  write({ entities: {}, exports: { 'crm.customer-created': exp(1, obj({ id: { type: 'string' } }, ['id'])) } });
  g('commit', '-qam', 'drop name');
  assert.deepEqual(run('main', dir).map((v) => v.rule), ['removed']);
  write({ entities: {}, exports: { 'crm.customer-created': exp(2, obj({ id: { type: 'string' } }, ['id'])) } });
  g('commit', '-qam', 'bump');
  assert.deepEqual(run('main', dir), []);
});

test('a model.json the base genuinely lacks is new, and passes', (t) => {
  const { dir, g, write } = repo(t);
  writeFileSync(join(dir, 'README'), 'x');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'change');
  write({ entities: {}, exports: base });
  g('add', '.');
  g('commit', '-q', '-m', 'first export');
  assert.deepEqual(run('main', dir), []);
});

test('a base that is not in the checkout is exit 2, never read as "new file" — on a shallow clone it says so', (t) => {
  const { dir, g, write } = repo(t);
  write({ entities: {}, exports: base });
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  write({ entities: {}, exports: { 'crm.customer-created': exp(1, obj({ id: { type: 'string' } }, ['id'])) } });
  g('commit', '-qam', 'break it');
  // A depth-1 clone holds the breaking commit and not the base it would be compared with.
  const shallow = mkdtempSync(join(tmpdir(), 'export-schema-diff-shallow-'));
  t.after(() => rmSync(shallow, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow]);
  const res = spawnSync('npx', ['tsx', TOOL, '--base', baseSha, '--root', shallow], { encoding: 'utf8' });
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /not in this checkout.*shallow clone/);
  const missing = spawnSync('npx', ['tsx', TOOL, '--base', 'refs/heads/no-such-base'], { cwd: dir, encoding: 'utf8' });
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /cannot run/);
  // The twin: with the base present, the same break is found (exit 1), not skipped.
  assert.deepEqual(run(baseSha, dir).map((v) => v.rule), ['removed']);
});

test('no --base is exit 2', () => {
  const res = spawnSync('npx', ['tsx', TOOL], { encoding: 'utf8' });
  assert.equal(res.status, 2);
});
