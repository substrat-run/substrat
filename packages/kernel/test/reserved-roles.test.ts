/**
 * #2430: the role doors' refusal and the declared-module check, as both adapters call them.
 */
import { describe, expect, it } from 'vitest';
import { moduleManifest } from '@substrat-run/contracts';
import {
  assertModuleDeclared,
  noteDeclaredKeys,
  noteReservedKeys,
  reservedGrantRefusal,
  reservedRoleDefinitionRefusal,
  reservedRoleRefusal,
  reservedRoleSetRefusal,
  reservedShapeRefusal,
} from '../src/reserved-roles.js';

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

  it('uses the persisted holder for new rows and keeps the legacy NULL decision', () => {
    expect(reservedRoleRefusal({ ...role(['a:run']), holder: 'person' }, reserved, 'platform')).toBe(
      "role 'r' holds a:run, reserved to a system principal: its stored holder is person; a role made only of reserved keys must declare holder: 'system'",
    );
    expect(reservedRoleRefusal({ ...role(['a:run']), holder: 'system' }, reserved, 'platform')).toBeNull();
    expect(reservedRoleRefusal({ ...role(['a:run']), holder: undefined }, reserved, 'platform')).toBeNull();
    expect(reservedRoleRefusal({ ...role(['a:run']), holder: null } as never, reserved, 'platform')).toBeNull();
    expect(reservedRoleRefusal({ ...role(['a:run']), holder: 'unknown' } as never, reserved, 'platform')).toMatch(/must declare holder: 'system'/);
  });

  it('a role with no reserved key passes either door', () => {
    for (const door of ['person', 'platform'] as const) expect(reservedRoleRefusal(role(['a:use']), reserved, door)).toBeNull();
  });
});

describe('reservedGrantRefusal', () => {
  it('refuses a raw grant naming any reserved key, and passes one naming none', () => {
    expect(reservedGrantRefusal(['a:use', 'a:run'], reserved)).toMatch(/^a:run cannot be granted to a principal, an org or a connection: reserved to a system principal/);
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
    expect(reservedShapeRefusal(shapes, reserved)).toMatch(/^the entity grant shape on run: a:run cannot be granted to a principal, an org or a connection/);
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

describe('reservedRoleRefusal: the stored holder at a person’s door (#2447)', () => {
  it('refuses a system-held role to a person even when the host reserves nothing', () => {
    expect(reservedRoleRefusal({ ...role(['a:run']), holder: 'system' }, new Set(), 'person')).toBe(
      "role 'r' is declared holder: 'system', a role for a system principal: no person's bound covers it, to give the role or to take it back (K-55)",
    );
  });

  it('twin: a person’s role passes the person’s door, and the platform’s door admits the system-held one', () => {
    expect(reservedRoleRefusal({ ...role(['a:run']), holder: 'person' }, new Set(), 'person')).toBeNull();
    expect(reservedRoleRefusal({ ...role(['a:run']), holder: 'system' }, new Set(), 'platform')).toBeNull();
  });
});

describe('reservedRoleDefinitionRefusal (#2447)', () => {
  const host = { reserved: new Set(['a:run']), declared: new Set(['a:run', 'a:use']) };
  const none = { reserved: new Set<string>(), declared: new Set<string>() };

  it('refuses a person’s role carrying a key the host reserves, holder omitted or person', () => {
    for (const holder of [undefined, 'person'] as const) {
      expect(reservedRoleDefinitionRefusal({ ...role(['a:use', 'a:run']), holder }, host, [])).toMatch(
        /^role 'r' is a person's role and would hold a:run \(a module this host registers/,
      );
    }
  });

  it('twin: a person’s role holding only person keys is defined, and so is one narrowed out of a reserved key', () => {
    expect(reservedRoleDefinitionRefusal(role(['a:use']), host, [{ ...role(['a:use', 'a:run']) }])).toBeNull();
  });

  it('a module-less host learns the reservation from the tenant’s other system-held roles', () => {
    const tenant = [{ key: 'runner', permissions: ['a:run'], holder: 'system' as const }];
    expect(reservedRoleDefinitionRefusal(role(['a:use', 'a:run']), none, tenant)).toMatch(
      /would hold a:run \(held by the system-held role 'runner'\)/,
    );
    // Twin: the same role with no system-held role in the tenant cannot be judged, and is admitted.
    expect(reservedRoleDefinitionRefusal(role(['a:use', 'a:run']), none, [])).toBeNull();
    // The role being redefined is not its own evidence.
    expect(reservedRoleDefinitionRefusal(role(['a:run']), none, [{ ...role(['a:run']), holder: 'system' }])).toBeNull();
  });

  it('fails open on a key the host knows nothing about: admitted for a person, and in a system-held role', () => {
    expect(reservedRoleDefinitionRefusal(role(['z:unknown']), host, [])).toBeNull();
    expect(reservedRoleDefinitionRefusal({ ...role(['a:run', 'z:unknown']), holder: 'system' }, host, [])).toBeNull();
  });

  it('refuses a system-held role holding a key the host declares for a person, or one a person’s role holds', () => {
    expect(reservedRoleDefinitionRefusal({ ...role(['a:run', 'a:use']), holder: 'system' }, host, [])).toBe(
      "role 'r' is declared holder: 'system' but holds a:use (declared for a person by a module this host registers): a system-held role holds only keys reserved to a system principal (K-55)",
    );
    expect(reservedRoleDefinitionRefusal({ ...role(['z:mine']), holder: 'system' }, none, [{ key: 'staff', permissions: ['z:mine'] }])).toMatch(
      /holds z:mine \(held by the person's role 'staff'\)/,
    );
  });

  it('twin: a system-held role made only of reserved keys is defined', () => {
    expect(reservedRoleDefinitionRefusal({ ...role(['a:run']), holder: 'system' }, host, [{ key: 'staff', permissions: ['a:use'] }])).toBeNull();
  });
});

describe('reservedRoleSetRefusal (#2447)', () => {
  it('judges each role of a set against the rest of it', () => {
    const roles = [
      { key: 'runner', permissions: ['z:run'], holder: 'system' as const },
      { key: 'staff', permissions: ['z:use', 'z:run'] },
    ];
    expect(reservedRoleSetRefusal(roles, { reserved: new Set(), declared: new Set() })).toMatch(/^role 'runner' is declared holder: 'system' but holds z:run \(held by the person's role 'staff'\)/);
    expect(reservedRoleSetRefusal([roles[1]!, roles[0]!], { reserved: new Set(), declared: new Set() })).toMatch(/^role 'staff' is a person's role and would hold z:run \(held by the system-held role 'runner'\)/);
    expect(reservedRoleSetRefusal([roles[0]!, { key: 'staff', permissions: ['z:use'] }], { reserved: new Set(), declared: new Set() })).toBeNull();
  });
});

describe('noteDeclaredKeys (#2447)', () => {
  it('collects every declared key, marked or not, and nothing from a manifest with no permission list', () => {
    const keys = new Set<string>();
    noteDeclaredKeys(keys, { id: '@t/declared' });
    noteDeclaredKeys(keys, manifest('@t/a', [{ key: 'a:run', description: 'run', holder: 'system' }, { key: 'a:use', description: 'use' }]));
    expect([...keys].sort()).toEqual(['a:run', 'a:use']);
  });
});
