/**
 * #2430: the role doors' refusal and the declared-module check, as both adapters call them.
 */
import { describe, expect, it } from 'vitest';
import { moduleManifest } from '@substrat-run/contracts';
import { assertModuleDeclared, noteReservedKeys, reservedGrantRefusal, reservedRoleRefusal, reservedShapeRefusal } from '../src/reserved-roles.js';

const manifest = (id: string, permissions: { key: string; description: string; holder?: 'system' }[]) =>
  moduleManifest.parse({
    id,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions,
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './m', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'x',
  });
const reserved = new Set(['a:run']);
const role = (permissions: string[]) => ({ key: 'r', permissions });

describe('reservedRoleRefusal', () => {
  it('a person’s door refuses any role carrying a reserved key, all-reserved included', () => {
    expect(reservedRoleRefusal(role(['a:use', 'a:run']), reserved, 'person')).toMatch(
      /^role 'r' holds a:run, reserved to a system principal: no person's bound covers it, to give the role or to take it back/,
    );
    expect(reservedRoleRefusal(role(['a:run']), reserved, 'person')).toMatch(/no person's bound covers it/);
  });

  it('names where the reservation is read from: the registered and listed modules, and the scope node’s', () => {
    for (const refusal of [reservedRoleRefusal(role(['a:run']), reserved, 'person'), reservedGrantRefusal(['a:run'], reserved)]) {
      expect(refusal).toMatch(/\(a module this host registers or lists in its `permissions`, or one registered at the scope node, declares it `holder: 'system'`\)$/);
    }
  });

  it('the platform’s door refuses a mix and admits a role made only of reserved keys (K-55)', () => {
    expect(reservedRoleRefusal(role(['a:use', 'a:run']), reserved, 'platform')).toMatch(/holds a:run, reserved to a system principal, beside a:use/);
    expect(reservedRoleRefusal(role(['a:run']), reserved, 'platform')).toBeNull();
  });

  it('a role with no reserved key passes either door', () => {
    for (const door of ['person', 'platform'] as const) expect(reservedRoleRefusal(role(['a:use']), reserved, door)).toBeNull();
  });
});

describe('reservedGrantRefusal', () => {
  it('refuses a raw grant naming any reserved key, and passes one naming none', () => {
    expect(reservedGrantRefusal(['a:use', 'a:run'], reserved)).toMatch(/^a:run cannot be granted to a principal or an org: reserved to a system principal/);
    expect(reservedGrantRefusal(['a:use'], reserved)).toBeNull();
    expect(reservedGrantRefusal(['a:run'], new Set())).toBeNull();
  });
});

describe('reservedShapeRefusal', () => {
  it('refuses a shape whose keys hold a reserved key, naming the shape', () => {
    const shapes = [
      { entityType: 'doc', permissions: ['a:use'] },
      { entityType: 'run', permissions: ['a:use', 'a:run'] },
    ];
    expect(reservedShapeRefusal(shapes, reserved)).toMatch(/^the entity grant shape on run: a:run cannot be granted to a principal or an org/);
  });

  it('passes shapes holding none, and a reserved key a shape only retires (it is taken back, never given)', () => {
    const retiring = { entityType: 'doc', permissions: ['a:use'], retired: ['a:run'] };
    expect(reservedShapeRefusal([retiring], reserved)).toBeNull();
    expect(reservedShapeRefusal([], reserved)).toBeNull();
  });
});

describe('noteReservedKeys', () => {
  it('reads a declared manifest with no permission list as reserving nothing', () => {
    const keys = new Set<string>();
    noteReservedKeys(keys, { id: '@t/declared' });
    expect(keys.size).toBe(0);
  });

  it('collects the keys a manifest marks, as a union over modules, and nothing else', () => {
    const keys = new Set<string>();
    noteReservedKeys(keys, manifest('@t/a', [{ key: 'a:run', description: 'run', holder: 'system' }, { key: 'a:use', description: 'use' }]));
    // A module re-declaring the key unmarked does not lift it (and one that predates the field reserves nothing).
    noteReservedKeys(keys, manifest('@t/b', [{ key: 'a:run', description: 'mine now' }, { key: 'b:use', description: 'use' }]));
    expect([...keys]).toEqual(['a:run']);
  });
});

describe('assertModuleDeclared', () => {
  const permissions = { modules: [{ manifest: { id: '@t/listed' } }] };

  it('refuses a module the declared surface leaves out, naming it and the list', () => {
    expect(() => assertModuleDeclared(permissions, '@t/other')).toThrow(
      /@t\/other is not in this host's permission surface \(the `permissions` it was given lists @t\/listed\)/,
    );
  });

  it('passes a listed module, and compares nothing with no surface given', () => {
    expect(() => assertModuleDeclared(permissions, '@t/listed')).not.toThrow();
    expect(() => assertModuleDeclared(undefined, '@t/other')).not.toThrow();
  });
});
