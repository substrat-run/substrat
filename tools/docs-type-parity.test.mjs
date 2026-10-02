import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkParity } from './docs-type-parity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The 13 names #1585 counted in kernel-design.md, each a real exported type.
const ISSUE_MIRRORS = [
  'Tenant', 'Scope', 'CapabilityGrant', 'RoleAssignment', 'RoleDefinition', 'PermissionChecker',
  'ScopeHost', 'ScopeStub', 'OperationContext', 'ModuleManifest', 'DomainEvent', 'EntityRef', 'Node',
];

const contracts = `
import { z } from 'zod';
import { stamp } from './ids.js';
export const scope = z.object({
  id: z.string().min(1),
  parentScopeId: z.string().nullable(),
  servingRef: z.string().min(1).nullish(),
  forkedAt: stamp.optional(),
  kind: z.string().default('main'),
  status: z.enum(['active', 'archived']),
  exotic: z.string().pipe(z.string()),
});
export type Scope = z.infer<typeof scope>;
export const tenantScope = scope.extend({ tenantId: z.string() }).superRefine(() => {});
export type TenantScope = z.infer<typeof tenantScope>;
`;
// A same-named const elsewhere: the relative import, not the global name, decides.
const ids = `import { z } from 'zod';\nexport const stamp = z.string().nullable();\n`;
const decoy = `import { z } from 'zod';\nexport const stamp = z.string();\n`;
const kernel = `
export interface Base { readonly tenantId: string; close?(): void }
export interface Host extends Base {
  getScope(principal: string): Promise<Stub>;
  attributed?(who: string): Host;
  current: string | null;
}
`;
const sketch = (body, name = 'Scope') => `# Fixture\n\n\`\`\`ts\ninterface ${name} {\n${body}\n}\n\`\`\`\n`;

function fixture(t, doc, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'docs-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/architecture'), { recursive: true });
  mkdirSync(join(root, 'packages/contracts/src'), { recursive: true });
  mkdirSync(join(root, 'packages/kernel/src'), { recursive: true });
  writeFileSync(join(root, 'docs/architecture/example.md'), doc);
  const all = {
    'packages/contracts/src/tenancy.ts': contracts,
    'packages/contracts/src/ids.ts': ids,
    'packages/contracts/src/decoy.ts': decoy,
    'packages/kernel/src/scope-host.ts': kernel,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) writeFileSync(join(root, path), text);
  return root;
}
const problems = (t, doc, files) => checkParity(fixture(t, doc, files)).diagnostics.join('\n');

test('the real architecture documents are in parity, covering every mirror #1585 names', () => {
  const { diagnostics, types, members } = checkParity(ROOT);
  assert.deepEqual(diagnostics, []);
  for (const name of ISSUE_MIRRORS) assert.ok(types.includes(name), `${name} is no longer checked`);
  assert.ok(members >= 90, `only ${members} members checked`);
});

test('drift a reader would act on goes red against the real source', (t) => {
  const root = fixture(t, '');
  rmSync(join(root, 'packages'), { recursive: true });
  for (const dir of ['packages/contracts/src', 'packages/kernel/src']) cpSync(join(ROOT, dir), join(root, dir), { recursive: true });
  const original = readFileSync(join(ROOT, 'docs/architecture/kernel-design.md'), 'utf8');
  const drifted = original
    // presence: a method the checker does not have (the defect this PR removed)
    .replace('  covers(subject', '  explain(principal: PrincipalId, node: Node): Promise<EffectivePermissions>;\n  covers(subject')
    // nullability: the parent pointer is nullable in tenancy.ts
    .replace('parentScopeId: ScopeId | null;', 'parentScopeId: ScopeId;')
    // optionality, both directions
    .replace('entity?: EntityRef;          // entity-narrowed', 'entity: EntityRef;          // entity-narrowed')
    .replace('  occurredAt: Instant;', '  occurredAt?: Instant;');
  assert.notEqual(drifted, original);
  writeFileSync(join(root, 'docs/architecture/example.md'), drifted);
  const { diagnostics } = checkParity(root);
  const text = diagnostics.join('\n');
  assert.equal(diagnostics.length, 4, text);
  assert.match(text, /PermissionChecker\.explain: not a member of PermissionChecker in packages\/kernel\/src\/permission-checker\.ts/);
  assert.match(text, /Scope\.parentScopeId: nullable in packages\/contracts\/src\/tenancy\.ts, not in the sketch/);
  assert.match(text, /CapabilityGrant\.entity: optional in packages\/contracts\/src\/permission\.ts, required in the sketch/);
  assert.match(text, /DomainEvent\.occurredAt: required in packages\/contracts\/src\/events\.ts, optional in the sketch/);
});

test('omitting members is the permitted simplification', (t) => {
  assert.equal(problems(t, sketch('id: string;')), '');
  assert.equal(checkParity(fixture(t, sketch('id: string;'))).members, 1);
});

test('a sketched member that does not exist is refused with its location', (t) => {
  assert.match(problems(t, sketch('id: string;\n  invented: string;')), /example\.md:6: Scope\.invented: not a member of Scope in packages\/contracts\/src\/tenancy\.ts/);
});

test('Zod optionality follows z.infer: optional and nullish are optional, default is required', (t) => {
  assert.equal(problems(t, sketch('servingRef?: string | null;\n  forkedAt?: string | null;\n  kind: string;')), '');
  assert.match(problems(t, sketch('servingRef: string | null;')), /Scope\.servingRef: optional in .*, required in the sketch/);
  assert.match(problems(t, sketch('kind?: string;')), /Scope\.kind: required in .*, optional in the sketch/);
  assert.match(problems(t, sketch('id?: string;')), /Scope\.id: required in .*, optional in the sketch/);
});

test('nullability is compared both ways, following aliases through the relative import', (t) => {
  assert.match(problems(t, sketch('parentScopeId: string;')), /nullable in .*tenancy\.ts, not in the sketch/);
  assert.match(problems(t, sketch('id: string | null;')), /not nullable in .*tenancy\.ts, nullable in the sketch/);
  // `stamp` is nullable in ids.ts (imported) and not in decoy.ts (same name, not imported).
  assert.match(problems(t, sketch('forkedAt?: string;')), /Scope\.forkedAt: nullable in/);
  assert.equal(problems(t, sketch('forkedAt?: (string | null);')), '');
});

test('string-literal unions are left to the union gate', (t) => {
  assert.equal(problems(t, sketch("status: 'active' | 'archived' | null;")), '');
});

test('extend and interface extends contribute inherited members', (t) => {
  assert.equal(problems(t, sketch('tenantId: string;\n  parentScopeId: string | null;', 'TenantScope')), '');
  const host = 'readonly tenantId: string;\n  close?(): void;\n  getScope(p: string): Promise<Stub>;\n  attributed?(w: string): Host;\n  current: string | null;';
  assert.equal(problems(t, sketch(host, 'Host')), '');
  assert.match(problems(t, sketch('close(): void;', 'Host')), /Host\.close: optional in packages\/kernel\/src\/scope-host\.ts, required in the sketch/);
  assert.match(problems(t, sketch('getScope?(p: string): Promise<Stub>;', 'Host')), /Host\.getScope: required in .*, optional in the sketch/);
  assert.match(problems(t, sketch('current: string;', 'Host')), /Host\.current: nullable in/);
});

test('markers excuse a stated difference, need a reason, and refuse once stale', (t) => {
  assert.equal(problems(t, sketch('planned: string; // docs-parity-local: proposed in §9, not built')), '');
  assert.match(problems(t, sketch('planned: string; // docs-parity-local:')), /docs-parity-local needs a nonempty reason/);
  assert.match(problems(t, sketch('id: string; // docs-parity-local: sketch')), /docs-parity-local, but .* declares id; remove the marker/);
  assert.equal(problems(t, sketch('kind?: string; // docs-parity-shape: callers may omit it, the default fills it')), '');
  assert.match(problems(t, sketch('kind: string; // docs-parity-shape: stale')), /docs-parity-shape, but the sketch matches/);
  assert.match(problems(t, sketch('planned: string; // docs-parity-local: x // docs-parity-shape: y')), /compares nothing/);
  assert.match(problems(t, sketch('kind: string; // docs-parity-shpae: typo')), /unknown docs-parity marker/);
  // A member cannot borrow a later member's marker on the same line.
  assert.match(problems(t, sketch('kind?: string; id: string; // docs-parity-shape: meant for kind')), /Scope\.kind: required in .*, optional in the sketch/);
});

test('a sketch naming no real type is not a mirror', (t) => {
  assert.deepEqual(checkParity(fixture(t, sketch('anything?: string | null;', 'AttachmentApi'))), { diagnostics: [], types: [], members: 0 });
});

test('unsupported source refuses only for the member a sketch names', (t) => {
  assert.equal(problems(t, sketch('id: string;')), ''); // `exotic` uses .pipe, unsketched
  assert.match(problems(t, sketch('exotic: string;')), /example\.md:5: Scope\.exotic: unsupported source wrapper pipe/);
});

test('an ambiguous or unreadable real type refuses at the sketch declaration', (t) => {
  const twice = { 'packages/kernel/src/other.ts': 'export interface Host { x: string }\n' };
  assert.match(problems(t, sketch('current: string | null;', 'Host'), twice), /example\.md:4: Host: cannot uniquely resolve real type Host \(2 exported declarations\)/);
  const opaque = { 'packages/kernel/src/other.ts': 'export type Opaque = Pick<Host, "current">;\n' };
  assert.match(problems(t, sketch('current: string | null;', 'Opaque'), opaque), /Opaque: .*unsupported real type shape/);
});

test('standalone and aggregate CLIs are advisory by default and refuse with --check', (t) => {
  const root = fixture(t, sketch('id: string;\n  invented: string;'));
  mkdirSync(join(root, 'tools'));
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  for (const script of ['docs-type-parity.mjs', 'docs-union-check.mjs', 'lint-docs.mjs']) cpSync(join(ROOT, 'tools', script), join(root, 'tools', script));
  for (const sibling of ['docs-drift.mjs', 'docs-structure.mjs', 'docs-surface-check.mjs']) writeFileSync(join(root, 'tools', sibling), 'process.exit(0);\n');
  for (const script of ['docs-type-parity.mjs', 'lint-docs.mjs']) {
    for (const check of [false, true]) {
      const result = spawnSync(process.execPath, [join(root, 'tools', script), ...(check ? ['--check'] : [])], { encoding: 'utf8' });
      assert.equal(result.status, check ? 1 : 0, result.stderr);
      assert.match(result.stderr, /Scope\.invented: not a member/);
    }
  }
});
