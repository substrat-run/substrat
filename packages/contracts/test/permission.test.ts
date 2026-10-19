/**
 * The coverage answer's own invariant.
 *
 * `covered` and `missing` are two readings of ONE answer to §5.1's assignment bound, and
 * a producer that let them part company would refuse for the caller that reads `covered`
 * and allow for the caller that reads `missing.length`. The union is what makes that
 * unrepresentable; these are the values it has to refuse for that to be true.
 */
import { describe, expect, it } from 'vitest';
import { permissionKey } from '../src/ids.js';
import { moduleManifest, permissionDeclaration } from '../src/manifest.js';
import { manifestOperations } from '../src/operations.js';
import { coverage, roleDefinition } from '../src/permission.js';

const PERM = permissionKey.parse('billing:manage');

describe('coverage', () => {
  it('accepts a covered answer with nothing missing', () => {
    expect(coverage.parse({ covered: true, missing: [] })).toEqual({
      covered: true,
      missing: [],
    });
  });

  it('accepts a refusal that names what is missing', () => {
    expect(coverage.parse({ covered: false, missing: [PERM] })).toEqual({
      covered: false,
      missing: [PERM],
    });
  });

  /** The contradiction that used to parse: an allow that also names a missing permission. */
  it('refuses a covered answer that names a missing permission', () => {
    expect(() => coverage.parse({ covered: true, missing: [PERM] })).toThrow();
  });

  /** And its mirror: a refusal a person cannot act on, because it names nothing. */
  it('refuses a refusal with nothing missing', () => {
    expect(() => coverage.parse({ covered: false, missing: [] })).toThrow();
  });
});

describe('roleDefinition.holder', () => {
  const base = { key: 'assistant-host', permissions: [PERM], source: 'vertical' as const };

  it('keeps holder through parsing', () => {
    expect(roleDefinition.parse({ ...base, holder: 'system' }).holder).toBe('system');
  });

  it('is optional, and refuses an unknown holder', () => {
    expect(roleDefinition.parse(base).holder).toBeUndefined();
    expect(() => roleDefinition.parse({ ...base, holder: 'robot' })).toThrow();
  });
});

describe('permissionDeclaration.holder', () => {
  const base = { key: 'assistant:run', description: 'Drive a run' };

  it('keeps holder: system through parsing, and through the manifest that carries it', () => {
    expect(permissionDeclaration.parse({ ...base, holder: 'system' }).holder).toBe('system');
    const manifest = moduleManifest.parse({
      id: '@acme/engine-x',
      version: '0.0.1',
      kernelContract: '^0.0.1',
      permissions: [{ ...base, holder: 'system' }, { key: 'assistant:use', description: 'Use' }],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
      attachmentTargets: [],
      entitlementKey: 'x',
    });
    expect(manifest.permissions.map((p) => p.holder)).toEqual(['system', undefined]);
  });

  // Additive: a declaration written before the field means what it meant, anyone may hold it.
  it('is optional, and refuses person or any other holder', () => {
    expect(permissionDeclaration.parse(base)).toEqual(base);
    expect(() => permissionDeclaration.parse({ ...base, holder: 'person' })).toThrow();
    expect(() => permissionDeclaration.parse({ ...base, holder: 'robot' })).toThrow();
  });
});

// A vertical built from its model describes its keys in `manifestOperations`, not in a hand-written
// manifest: the object form is where it reserves one of its own, and it reaches the declaration.
describe('manifestOperations carries holder: system', () => {
  const declared = manifestOperations(
    {},
    { permissions: { 'list:read': 'Read a list', 'list:reap': { description: 'Reap abandoned lists', holder: 'system' } } },
  ).permissions;

  it('onto the permission declaration, and only for the key that says so', () => {
    expect(declared).toEqual([
      { key: 'list:read', description: 'Read a list' },
      { key: 'list:reap', description: 'Reap abandoned lists', holder: 'system' },
    ]);
    expect(declared.map((p) => permissionDeclaration.parse(p))).toEqual(declared);
  });

  it('refuses an empty description in either form, naming the key', () => {
    const reap = { 'list/reap': { permission: 'list:reap' } };
    for (const text of ['', { description: '', holder: 'system' as const }]) {
      expect(() => manifestOperations(reap, { permissions: { 'list:reap': text } })).toThrow(/no description for permission\(s\) list:reap/);
    }
    // Its twin: described, in either form, it passes.
    for (const text of ['Reap', { description: 'Reap', holder: 'system' as const }]) {
      expect(() => manifestOperations(reap, { permissions: { 'list:reap': text } })).not.toThrow();
    }
  });
});
