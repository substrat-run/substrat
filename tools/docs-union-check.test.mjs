import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkUnions } from './docs-union-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = `
export const scopeStatus = z.enum(['active', 'archived', 'reaped']);
export const jurisdiction = z.enum(['eu', 'us', 'global']);
export const scope = z.object({ status: scopeStatus, jurisdiction });
`;
const sketch = (fields, name = 'Scope') => `# Fixture\n\n\`\`\`ts\ninterface ${name} {\n${fields}\n}\n\`\`\`\n`;
function fixture(t, doc, source = schema) {
  const root = mkdtempSync(join(tmpdir(), 'docs-union-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/architecture'), { recursive: true });
  mkdirSync(join(root, 'packages/contracts/src'), { recursive: true });
  writeFileSync(join(root, 'docs/architecture/example.md'), doc);
  writeFileSync(join(root, 'packages/contracts/src/tenancy.ts'), source);
  return root;
}
function problems(t, doc, source) { return checkUnions(fixture(t, doc, source)).diagnostics.join('\n'); }

test('real architecture checks all five initial fields without changing prose', () => {
  assert.deepEqual(checkUnions(ROOT), { diagnostics: [], checked: 5 });
});

test('historical defects are caught against real contract source', (t) => {
  const root = fixture(t, '');
  for (const file of ['tenancy.ts', 'events.ts']) cpSync(join(ROOT, 'packages/contracts/src', file), join(root, 'packages/contracts/src', file));
  const original = readFileSync(join(ROOT, 'docs/architecture/kernel-design.md'), 'utf8');
  const docPath = join(root, 'docs/architecture/example.md');
  writeFileSync(docPath, original.replace("'eu' | 'us' | 'global'", "'eu' | null").replaceAll(" | 'reaped'", ''));
  const result = checkUnions(root);
  assert.equal(result.diagnostics.length, 3);
  assert.match(result.diagnostics.join('\n'), /Scope.jurisdiction:.*extra \[null\].*missing \["us", "global"\]/);
  for (const type of ['Tenant', 'Scope']) assert.match(result.diagnostics.join('\n'), new RegExp(`${type}.status:.*missing \\["reaped"\\]`));
});

test('source enum additions fail without changing the sketch', (t) => {
  assert.match(problems(t, sketch("status: 'active' | 'archived' | 'reaped';"), schema.replace("'reaped'", "'reaped', 'new-state'")), /missing \["new-state"\]/);
});

test('sets ignore order, quotes, whitespace, parentheses and optional spelling', (t) => {
  const doc = '```typescript\ntype Scope = {\n status?: (\n "reaped"\n | \'active\'\n | \'archived\'\n );\n ignored: Other | null;\n mixed: ModuleId | \'vertical\';\n}\n```\n';
  assert.equal(problems(t, doc), '');
});

test('single literal plus null and multiline nullability cannot bypass discovery', (t) => {
  assert.match(problems(t, sketch("jurisdiction:\n 'eu'\n | null;")), /example.md:5: Scope.jurisdiction:.*extra \[null\]/);
  assert.match(problems(t, sketch("status: 'active';")), /missing \["archived", "reaped"\]/);
});

test('field nullability follows aliases and supported wrappers', (t) => {
  const source = schema.replace('status: scopeStatus', 'status: nullableStatus.optional().default(null)').concat('\nconst nullableStatus = scopeStatus.nullable().brand();');
  assert.equal(problems(t, sketch("status: 'active' | 'archived' | 'reaped' | null;"), source), '');
  assert.match(problems(t, sketch("status: 'active' | 'archived' | 'reaped';"), source), /missing \[null\]/);
  assert.equal(problems(t, sketch("status: 'active' | 'archived' | 'reaped' | null;"), schema.replace('status: scopeStatus', 'status: scopeStatus.nullish().readonly()')), '');
});

test('subsets allow omissions only and require a reason', (t) => {
  assert.equal(problems(t, sketch("status: 'active'; // subset: only the running state is relevant")), '');
  assert.match(problems(t, sketch("status: 'active'; // subset:")), /subset needs a nonempty/);
  for (const extra of ["'invented'", 'null']) {
    assert.match(problems(t, sketch(`status: 'active' | ${extra}; // subset: running state only`)), /extra \[.*\].*subset permits omissions only/);
  }
});

test('explicit source mapping resolves renamed fields and preserves schema nullability', (t) => {
  assert.equal(problems(t, sketch("state: 'active' | 'archived' | 'reaped'; // docs-union-source: tenancy.ts#scope.status", 'Renamed')), '');
  assert.match(problems(t, sketch("state: 'active'; // docs-union-source: missing.ts#scope.status", 'Renamed')), /cannot uniquely resolve missing.ts#scope.status/);
  assert.match(problems(t, sketch("status: 'active'; // docs-union-source: scopeStatus")), /must be file.ts#exportedSchema.field/);
});

test('unresolved candidates and unsupported source forms diagnose mapping and location', (t) => {
  assert.match(problems(t, sketch("state: 'active';", 'Unknown')), /example.md:5: Unknown.state: cannot uniquely resolve.*docs-union-source/);
  assert.match(problems(t, sketch("unknown: 'active';")), /tenancy.ts#scope.unknown: missing or ambiguous schema field/);
  assert.match(problems(t, sketch("status: 'active';"), schema.replace('status: scopeStatus', 'status: scopeStatus.transform(fn)')), /tenancy.ts#scope.status: unsupported enum wrapper transform/);
  assert.match(problems(t, sketch("status: 'active';"), schema.replace('status: scopeStatus', 'status: cycle').concat('\nconst cycle = cycle;')), /cyclic source alias/);
});

test('no-counterpart sketches require an explicit reason; real contracts cannot opt out', (t) => {
  assert.equal(problems(t, sketch("mode: 'preview'; // docs-union-local: proposal has no contract yet", 'Proposal')), '');
  assert.match(problems(t, sketch("mode: 'preview'; // docs-union-local:", 'Proposal')), /nonempty/);
  assert.match(problems(t, sketch("status: 'active'; // docs-union-local: simplification")), /requires no contract counterpart/);
  assert.match(problems(t, sketch("status: 'active'; // docs-union-soruce: typo")), /unknown docs-union marker/);
});

test('non-TypeScript fences and unrelated fields do not become candidates', (t) => {
  assert.equal(problems(t, sketch('id: Id;\n data: Record<string, unknown>;\n nullable: Id | null;') + "```text\ninterface Unknown { state: 'x' }\n```\n"), '');
});

test('standalone and aggregate CLIs are advisory by default and refuse with --check', (t) => {
  const root = fixture(t, sketch("jurisdiction: 'eu' | null;"));
  mkdirSync(join(root, 'tools'));
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  for (const script of ['docs-union-check.mjs', 'lint-docs.mjs']) cpSync(join(ROOT, 'tools', script), join(root, 'tools', script));
  // Isolate sibling gates; run the real aggregate runner and new checker together.
  for (const sibling of ['docs-drift.mjs', 'docs-structure.mjs', 'docs-surface-check.mjs']) writeFileSync(join(root, 'tools', sibling), 'process.exit(0);\n');
  for (const script of ['docs-union-check.mjs', 'lint-docs.mjs']) {
    for (const check of [false, true]) {
      const result = spawnSync(process.execPath, [join(root, 'tools', script), ...(check ? ['--check'] : [])], { encoding: 'utf8' });
      assert.equal(result.status, check ? 1 : 0, result.stderr);
      assert.match(result.stderr, /Scope.jurisdiction:.*extra \[null\]/);
    }
  }
});

test('generic aliases, longer closing fences and CRLF preserve coverage', (t) => {
  const doc = '~~~ts\ntype Scope<T> = {\n status: "active";\n}\n~~~~\n'.replaceAll('\n', '\r\n');
  assert.match(problems(t, doc), /Scope.status:.*missing \["archived", "reaped"\]/);
});

test('a field cannot borrow a later field marker on the same line', (t) => {
  assert.match(problems(t, sketch("status: 'active'; other: 'x'; // subset: another field")), /Scope.status:.*missing \["archived", "reaped"\]/);
});

test('unreadable named sketches and explicitly mapped nonliteral fields refuse', (t) => {
  assert.match(problems(t, sketch("status: 'active' | ;")), /example.md:5: cannot parse TypeScript sketch/);
  assert.match(problems(t, sketch("status: Status; // docs-union-source: tenancy.ts#scope.status")), /unsupported sketch union member/);
});
