/**
 * #2430: the role doors' refusal and the declared-module check, as both adapters call them.
 */
import { describe, expect, it } from 'vitest';
import { moduleManifest } from '@substrat-run/contracts';
import {
  assertModuleDeclared,
  noteDeclaredKeys,
  noteReservedKeys,
  registryReservations,
  releaseRolesAskScopes,
  releaseRoleSetRefusal,
  reservedGrantRefusal,
  reservedRoleDefinitionRefusal,
  reservedRoleRefusal,
  reservedRoleSetRefusal,
  reservedRoleSetRefusedRole,
  loadedRoleSetRefusedRole,
  inUnitRoleRefusal,
  reservedShapeRefusal,
  dumpRoleRefusal,
  dumpRoleState,
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
    // A stored PERSON's definition of the same key is no evidence: only a system-held one is (round 1).
    expect(reservedRoleDefinitionRefusal(role(['a:run']), none, [{ ...role(['a:run']), holder: 'person' }])).toBeNull();
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

describe('reservedRoleDefinitionRefusal against the stored row of the same key (#2447 round 1)', () => {
  const host = { reserved: new Set(['a:run']), declared: new Set(['a:run', 'a:use']) };
  const none = { reserved: new Set<string>(), declared: new Set<string>() };
  const stored = (permissions: string[], holder?: 'person' | 'system') => ({ key: 'r', permissions, ...(holder ? { holder } : {}) });

  it('refuses a seated person’s role becoming holder: system', () => {
    expect(reservedRoleDefinitionRefusal({ ...role(['a:run']), holder: 'system' }, host, [stored(['a:use'], 'person')], true)).toMatch(
      /^role 'r' is held by a principal \(stored as a person's role\), so it cannot be declared holder: 'system'/,
    );
  });

  it('refuses a system-held definition of a seated key with NO stored definition (round 2: a projection dropped its row)', () => {
    expect(reservedRoleDefinitionRefusal({ ...role(['a:run']), holder: 'system' }, host, [], true)).toMatch(
      /^role 'r' is held by a principal \(with no definition stored\), so it cannot be declared holder: 'system'/,
    );
  });

  it('twins: the same definitions with no seat are judged as first definitions', () => {
    expect(reservedRoleDefinitionRefusal({ ...role(['a:run']), holder: 'system' }, host, [stored(['a:use'], 'person')], false)).toBeNull();
    expect(reservedRoleDefinitionRefusal({ ...role(['a:run']), holder: 'system' }, host, [], false)).toBeNull();
    // A stored system-held role redefined system-held, seated, is no flip.
    expect(reservedRoleDefinitionRefusal({ ...role(['a:run']), holder: 'system' }, host, [stored(['a:run'], 'system')], true)).toBeNull();
  });

  it('the seats decide a legacy holder-less row too: seated, it cannot become holder: system, with any keys (round 3)', () => {
    const both = { reserved: new Set(['a:run', 'b:run']), declared: new Set(['a:run', 'b:run']) };
    for (const keys of [['a:run'], ['a:run', 'b:run']]) {
      expect(reservedRoleDefinitionRefusal({ ...role(keys), holder: 'system' }, both, [stored(['a:run'])], true)).toMatch(
        /cannot be declared holder: 'system'/,
      );
    }
  });

  it('names a holder-less row as what it is, not a person’s role (round 4)', () => {
    const refusal = reservedRoleDefinitionRefusal({ ...role(['a:run']), holder: 'system' }, host, [stored(['a:run'])], true);
    expect(refusal).toMatch(/^role 'r' is held by a principal \(stored with no holder, from before holders were recorded \(#2480\)\), so it cannot be declared holder: 'system'/);
    expect(refusal).not.toMatch(/stored as a person's role/);
    expect(refusal).toMatch(/Take that seat back first, wherever it is held \(a scope, or the tenant;/);
  });

  it('twin: a legacy holder-less row nobody but a system principal holds may become holder: system (#2480)', () => {
    expect(reservedRoleDefinitionRefusal({ ...role(['a:run']), holder: 'system' }, host, [stored(['a:run'])], false)).toBeNull();
  });

  it('judges a stored system-held role redefined as a person’s with its stored keys counted reserved, even on a module-less host', () => {
    expect(reservedRoleDefinitionRefusal(role(['a:run']), none, [stored(['a:run'], 'system')])).toMatch(
      /^role 'r' is a person's role and would hold a:run \(held by its stored system-held definition\)/,
    );
    // Twin: redefined as a person's role without that key, it is defined.
    expect(reservedRoleDefinitionRefusal(role(['a:use']), none, [stored(['a:run'], 'system')])).toBeNull();
  });

  it('judges a key added to a seated person’s role as the new definition', () => {
    expect(reservedRoleDefinitionRefusal(role(['a:use', 'a:run']), host, [stored(['a:use'], 'person')], true)).toMatch(/would hold a:run/);
    expect(reservedRoleDefinitionRefusal(role(['a:use', 'z:new']), host, [stored(['a:use'], 'person')], true)).toBeNull();
  });

  it('a key the host declares unmarked is a person’s, whatever a stored system-held role holds (symmetric with the system branch)', () => {
    const tenant = [{ key: 'odd', permissions: ['a:use'], holder: 'system' as const }];
    expect(reservedRoleDefinitionRefusal(role(['a:use']), host, tenant)).toBeNull();
    // Twin: a key the host does not declare, held by that system-held role, is refused.
    expect(reservedRoleDefinitionRefusal(role(['z:x']), host, [{ key: 'odd', permissions: ['z:x'], holder: 'system' }])).toMatch(/held by the system-held role 'odd'/);
  });
});

describe('reservedRoleSetRefusal against what the scope stores (#2447 round 1)', () => {
  const host = { reserved: new Set(['a:run']), declared: new Set(['a:run', 'a:use']) };
  it('refuses a set that flips a seated stored person’s role to holder: system; twin with no seat passes', () => {
    const roles = [{ key: 'staff', permissions: ['a:run'], holder: 'system' as const }];
    const stored = { roles: [{ key: 'staff', permissions: ['a:use'], holder: 'person' as const }], seated: new Set(['staff']) };
    expect(reservedRoleSetRefusal(roles, host, stored)).toMatch(/role 'staff' is held by a principal/);
    expect(reservedRoleSetRefusal(roles, host, { ...stored, seated: new Set() })).toBeNull();
    expect(reservedRoleSetRefusal(roles, host)).toBeNull();
  });
});

describe('reservedRoleSetRefusedRole and the in-unit sentence (#2531 part C)', () => {
  const host = { reserved: new Set(['a:run']), declared: new Set(['a:run', 'a:use']) };
  const stored = { roles: [{ key: 'staff', permissions: ['a:use'], holder: 'person' as const }], seated: new Set(['staff']) };
  it('answers the key of the role the set’s walk refuses, with the same refusal; null when admitted', () => {
    const roles = [{ key: 'ok', permissions: ['a:use'] }, { key: 'staff', permissions: ['a:run'], holder: 'system' as const }];
    const refused = reservedRoleSetRefusedRole(roles, host, stored);
    expect(refused).toEqual({ key: 'staff', refusal: reservedRoleSetRefusal(roles, host, stored) });
    expect(reservedRoleSetRefusedRole(roles, host, { ...stored, seated: new Set() })).toBeNull();
  });
  it('the sentence names the role key and nothing else of the scope', () => {
    expect(inUnitRoleRefusal('staff')).toBe(
      "role 'staff' is refused by the reserved-key rule, judged against the roles and seats this scope holds as the write lands (K-55); nothing was written",
    );
  });
});

describe('loadedRoleSetRefusedRole: the directory set judged against a load’s stored state (#2555 PR 2)', () => {
  const host = { reserved: new Set(['a:run']), declared: new Set(['a:run', 'a:use']) };
  const runner = { key: 'runner', permissions: ['a:run'], holder: 'system' as const };
  const person = { key: 'runner', permissions: ['a:use'], holder: 'person' as const };

  it('refuses a seated stored person’s role the directory now defines system-held, as the whole-set walk does', () => {
    const stored = { roles: [person], seated: new Set(['runner']) };
    const refused = loadedRoleSetRefusedRole([runner], host, stored);
    expect(refused).toEqual(reservedRoleSetRefusedRole([runner], host, stored));
    expect(refused?.key).toBe('runner');
  });

  it('twin: the same set with no seat in the role is admitted', () => {
    expect(loadedRoleSetRefusedRole([runner], host, { roles: [person], seated: new Set() })).toBeNull();
  });

  it('asks only about roles the state seats, stores or keeps a tombstone of; the whole set stays their context', () => {
    // A person's role holding a reserved key: the whole-set walk refuses it wherever it is asked.
    const odd = { key: 'odd', permissions: ['a:run'] };
    const empty = { roles: [], seated: new Set<string>() };
    expect(reservedRoleSetRefusedRole([odd], host, empty)?.key).toBe('odd');
    expect(loadedRoleSetRefusedRole([odd], host, empty)).toBeNull();
    // Twins: stored, seated or tombstoned, the same role is asked about, and refused.
    expect(loadedRoleSetRefusedRole([odd], host, { roles: [{ key: 'odd', permissions: ['a:use'] }], seated: new Set() })?.key).toBe('odd');
    expect(loadedRoleSetRefusedRole([odd], host, { roles: [], seated: new Set(['odd']) })?.key).toBe('odd');
    expect(loadedRoleSetRefusedRole([odd], host, { roles: [], seated: new Set(), dropped: [{ key: 'odd', permissions: ['a:use'] }] })?.key).toBe('odd');
  });

  it('agrees with dumpRoleRefusal on the same state read from a dump', () => {
    const tables = [
      { name: '_substrat_roles', columns: ['tenant_id', 'role_key', 'permissions', 'holder', 'revoked_at'], rows: [['t', 'runner', '["a:use"]', 'person', null]] },
      { name: '_substrat_tuples', columns: ['subject', 'relation', 'object', 'expires_at', 'revoked_at'], rows: [['p1', 'role:runner', 'scope:s', null, null]] },
    ];
    const now = '2026-10-25T00:00:00.000Z';
    expect(dumpRoleRefusal([runner], host, { tenantId: 't', tables }, now)).not.toBeNull();
    expect(loadedRoleSetRefusedRole([runner], host, dumpRoleState(tables, 't', now))?.key).toBe('runner');
  });
});

describe('reservedRoleSetRefusal against a dropped role’s tombstone (#2531)', () => {
  const host = { reserved: new Set(['a:run']), declared: new Set(['a:run', 'a:use']) };
  const none = { reserved: new Set<string>(), declared: new Set<string>() };
  const runner = { key: 'runner', permissions: ['a:run'], holder: 'system' as const };
  const seated = new Set(['runner']);

  it('admits a system-held role added back while seated, when its tombstone is system-held', () => {
    expect(reservedRoleSetRefusal([runner], host, { roles: [], seated, dropped: [runner] })).toBeNull();
  });

  it('twin: the same re-add with no tombstone kept is refused, as it was before tombstones', () => {
    expect(reservedRoleSetRefusal([runner], host, { roles: [], seated })).toMatch(/role 'runner' is held by a principal \(with no definition stored\)/);
    expect(reservedRoleSetRefusal([runner], host, { roles: [], seated, dropped: [] })).toMatch(/with no definition stored/);
  });

  it('keeps refusing it when the tombstone is a person’s role, or a row with no holder', () => {
    for (const tomb of [{ ...runner, holder: 'person' as const }, { key: 'runner', permissions: ['a:run'] }]) {
      expect(reservedRoleSetRefusal([runner], host, { roles: [], seated, dropped: [tomb] })).toMatch(/with no definition stored/);
    }
  });

  it('counts a system-held tombstone’s keys as reserved for a person’s role re-added under its key, even on a module-less host', () => {
    // Named as what it is: a tombstone appears in no role listing, so "stored" would send a reader looking for a row.
    expect(reservedRoleSetRefusal([{ key: 'runner', permissions: ['a:run'] }], none, { roles: [], seated: new Set(), dropped: [runner] })).toBe(
      "role 'runner' is a person's role and would hold a:run (held by its definition as a system-held role, since dropped), " +
        "reserved to a system principal: take the key out, or declare a role made only of reserved keys holder: 'system' (K-55)",
    );
    // Twin: the same keys held by a live stored row are named as the stored definition, as before.
    expect(reservedRoleSetRefusal([{ key: 'runner', permissions: ['a:run'] }], none, { roles: [runner], seated: new Set() })).toMatch(
      /would hold a:run \(held by its stored system-held definition\)/,
    );
    // Twin: the person's role without that key is defined; and a person tombstone is no such evidence.
    expect(reservedRoleSetRefusal([{ key: 'runner', permissions: ['a:use'] }], none, { roles: [], seated: new Set(), dropped: [runner] })).toBeNull();
    expect(
      reservedRoleSetRefusal([{ key: 'runner', permissions: ['a:run'] }], none, { roles: [], seated: new Set(), dropped: [{ ...runner, holder: 'person' }] }),
    ).toBeNull();
  });

  it('a live row decides over a tombstone of the same key', () => {
    const personLive = { key: 'runner', permissions: ['a:use'], holder: 'person' as const };
    expect(reservedRoleSetRefusal([runner], host, { roles: [personLive], seated, dropped: [runner] })).toMatch(/stored as a person's role/);
  });

  it('a tombstone of one key is no evidence for another', () => {
    expect(reservedRoleSetRefusal([runner], host, { roles: [], seated, dropped: [{ ...runner, key: 'other' }] })).toMatch(/with no definition stored/);
  });

  it('a promote reads the tombstones the wire carries, as the reconcile does', () => {
    const registry = {
      permissions: [
        { key: 'a:use', description: 'use' },
        { key: 'a:run', description: 'run', holder: 'system' as const },
      ],
      roles: [runner],
    };
    expect(releaseRoleSetRefusal(registry, { roles: [], seated: ['runner'], dropped: [runner] })).toBeNull();
    // An older deployment answers no `dropped`: the promote stays as strict as before.
    expect(releaseRoleSetRefusal(registry, { roles: [], seated: ['runner'] })).toMatch(/with no definition stored/);
  });
});

describe('dumpRoleState (#2447 round 2)', () => {
  const now = '2026-10-24T00:00:00.000Z';
  const tables = [
    {
      name: '_substrat_roles',
      columns: ['tenant_id', 'role_key', 'permissions', 'source', 'holder', 'revoked_at'],
      rows: [
        ['t1', 'staffer', '["a:use"]', 'vertical', 'person', null],
        ['t1', 'gone', '["a:use"]', 'vertical', null, '2026-01-01T00:00:00.000Z'],
        ['t2', 'other', '["a:use"]', 'vertical', 'system', null],
      ],
    },
    {
      name: '_substrat_tuples',
      columns: ['subject', 'relation', 'object', 'expires_at', 'revoked_at'],
      rows: [
        ['principal:p1', 'role:staffer', 'scope:s', null, null],
        ['principal:p2', 'role:ghost', 'scope:s', null, null],
        ['system:@m', 'role:sys', 'scope:s', null, null],
        ['principal:p3', 'role:revoked', 'scope:s', null, '2026-01-01T00:00:00.000Z'],
        ['principal:p4', 'role:expired', 'scope:s', '2026-01-01T00:00:00.000Z', null],
        ['principal:p5', 'granted:a:use', 'scope:s', null, null],
      ],
    },
    {
      name: '_substrat_tenant_tuples',
      columns: ['tenant_id', 'subject', 'relation', 'object', 'expires_at', 'revoked_at'],
      rows: [
        ['t1', 'principal:p6', 'role:tenantwide', 'tenant:t1', null, null],
        ['t2', 'principal:p7', 'role:elsewhere', 'tenant:t2', null, null],
      ],
    },
  ];

  it('reads the tenant’s live roles and the role keys a non-system principal holds a live seat in', () => {
    const state = dumpRoleState(tables, 't1', now);
    expect(state.roles).toEqual([{ key: 'staffer', permissions: ['a:use'], holder: 'person' }]);
    // Scope-level seats only: a dump's projected tenant tuples do not survive the repair (round 3).
    expect([...state.seated].sort()).toEqual(['ghost', 'staffer']);
    // #2531: the tenant's tombstones travel as `dropped`, never as live roles; another tenant's do not.
    expect(state.dropped).toEqual([{ key: 'gone', permissions: ['a:use'] }]);
  });

  it('reads a dump with none of those tables as storing nothing', () => {
    expect(dumpRoleState([], 't1', now)).toEqual({ roles: [], seated: new Set(), dropped: [] });
  });
});

describe('dumpRoleRefusal (#2555)', () => {
  const now = '2026-10-24T00:00:00.000Z';
  const host = { reserved: new Set<string>(), declared: new Set<string>() };
  const seats = (relation: string) => ({
    name: '_substrat_tuples',
    columns: ['subject', 'relation', 'object', 'expires_at', 'revoked_at'],
    rows: [['principal:p1', relation, 'scope:s', null, null]],
  });
  const roleRow = (key: string, holder: 'person' | 'system') => ({
    name: '_substrat_roles',
    columns: ['tenant_id', 'role_key', 'permissions', 'source', 'holder', 'revoked_at'],
    rows: [['t1', key, '["a:run"]', 'vertical', holder, null]],
  });
  const systemRole = { key: 'member', permissions: ['a:run'], holder: 'system' as const };
  const changed = (key: string) =>
    `restore refused: role '${key}', which the dump seats or defines, cannot be applied as the tenant defines it now (K-55); nothing was loaded`;
  const undefinedInDump = (key: string) =>
    `restore refused: the dump seats role '${key}' but carries no definition of it, so its seats cannot be told from a person's, ` +
    `and the tenant now defines the role for a system principal (K-55); nothing was loaded`;

  it('refuses a dump seated in a role the tenant now stores system-held, in one fixed sentence', () => {
    const refusal = dumpRoleRefusal([systemRole], host, { tenantId: 't1', tables: [roleRow('member', 'person'), seats('role:member')] }, now);
    expect(refusal).toBe(changed('member'));
    expect(refusal).not.toContain('p1');
  });

  it('twin: the same dump with no seat in the role is admitted', () => {
    expect(dumpRoleRefusal([systemRole], host, { tenantId: 't1', tables: [roleRow('member', 'person'), seats('role:other')] }, now)).toBeNull();
  });

  it('admits a seat where the dump stores the role system-held itself; names a dump with no definition of it', () => {
    expect(dumpRoleRefusal([systemRole], host, { tenantId: 't1', tables: [roleRow('member', 'system'), seats('role:member')] }, now)).toBeNull();
    expect(dumpRoleRefusal([systemRole], host, { tenantId: 't1', tables: [seats('role:member')] }, now)).toBe(undefinedInDump('member'));
  });

  it('reads the dump’s role rows for the tenant it was captured from', () => {
    // A row the dump stores for another tenant is no evidence for this one's seats.
    const other = { ...roleRow('member', 'system'), rows: [['t2', 'member', '["a:run"]', 'vertical', 'system', null]] };
    expect(dumpRoleRefusal([systemRole], host, { tenantId: 't1', tables: [other, seats('role:member')] }, now)).toBe(undefinedInDump('member'));
  });

  it('chooses the sentence from the reason: a refusal over the keys a definition holds is not blamed on the dump', () => {
    // A person's role the tenant defines over a reserved key, seated by a dump with no role rows: the
    // key is the reason, so the general sentence answers, not the one about a missing definition.
    const reserving = { reserved: new Set(['a:run']), declared: new Set(['a:run']) };
    const personRole = { key: 'member', permissions: ['a:run'], holder: 'person' as const };
    expect(dumpRoleRefusal([personRole], reserving, { tenantId: 't1', tables: [seats('role:member')] }, now)).toBe(changed('member'));
  });

  it('asks only about roles the dump seats or stores; twin: the same role is judged once the dump seats it', () => {
    // A system-held role holding a key a module declares for a person: the rule refuses it wherever it is asked about.
    const wide = { key: 'wide', permissions: ['a:use'], holder: 'system' as const };
    const declared = { reserved: new Set<string>(), declared: new Set(['a:use']) };
    expect(dumpRoleRefusal([wide], declared, { tenantId: 't1', tables: [seats('role:other')] }, now)).toBeNull();
    expect(dumpRoleRefusal([wide], declared, { tenantId: 't1', tables: [roleRow('wide', 'person'), seats('role:other')] }, now)).toBe(changed('wide'));
  });

  // #2531: a dump carries the scope's tombstones, and the judgement reads them as the scope's own rule does.
  const tombstone = (key: string, holder: 'person' | 'system' | null) => ({
    name: '_substrat_roles',
    columns: ['tenant_id', 'role_key', 'permissions', 'source', 'holder', 'revoked_at'],
    rows: [['t1', key, '["a:run"]', 'vertical', holder, '2026-10-01T00:00:00.000Z']],
  });

  it('admits a seat in a role the dump keeps as a system-held tombstone, as it does a live system-held row (#2531)', () => {
    expect(dumpRoleRefusal([systemRole], host, { tenantId: 't1', tables: [tombstone('member', 'system'), seats('role:member')] }, now)).toBeNull();
  });

  it('twin: a person-held or holder-less tombstone is no such evidence, and the dump is answered as defining the role (#2531)', () => {
    for (const holder of ['person', null] as const) {
      expect(dumpRoleRefusal([systemRole], host, { tenantId: 't1', tables: [tombstone('member', holder), seats('role:member')] }, now)).toBe(changed('member'));
    }
  });

  it('counts a system-held tombstone’s keys as reserved for a person’s role the tenant now defines under its key (#2531)', () => {
    const personRole = { key: 'member', permissions: ['a:run'], holder: 'person' as const };
    // The dump only keeps the tombstone, and seats nobody: the role is judged because the dump defines it.
    expect(dumpRoleRefusal([personRole], host, { tenantId: 't1', tables: [tombstone('member', 'system'), seats('role:other')] }, now)).toBe(changed('member'));
    // Twin: a person-held tombstone reserves nothing.
    expect(dumpRoleRefusal([personRole], host, { tenantId: 't1', tables: [tombstone('member', 'person'), seats('role:other')] }, now)).toBeNull();
  });
});


describe('a release’s role set against a scope it moves (#2446)', () => {
  const registry = (roles: { key: string; permissions: string[]; holder?: 'person' | 'system' }[]) => ({
    permissions: [
      { key: 'a:use', description: 'use' },
      { key: 'a:run', description: 'run', holder: 'system' as const },
    ],
    roles,
  });
  const flip = registry([{ key: 'runner', permissions: ['a:run'], holder: 'system' }]);
  const personStored = { roles: [{ key: 'runner', permissions: ['a:use'], holder: 'person' as const }], seated: [] as string[] };

  it('reads the registry’s marks as the reservation: marked keys reserved, every listed key declared', () => {
    const r = registryReservations(flip);
    expect([...r.reserved]).toEqual(['a:run']);
    expect([...r.declared].sort()).toEqual(['a:run', 'a:use']);
  });

  it('refuses a release that makes a seated person’s role holder: system, as the reconcile there would', () => {
    const state = { ...personStored, seated: ['runner'] };
    const refusal = releaseRoleSetRefusal(flip, state);
    expect(refusal).toMatch(/^role 'runner' is held by a principal \(stored as a person's role\), so it cannot be declared holder: 'system'/);
    // The same function and inputs the scope's reconcile judges with.
    expect(refusal).toBe(reservedRoleSetRefusal(flip.roles, registryReservations(flip), { roles: state.roles, seated: new Set(state.seated) }));
  });

  it('twin: the same release where nobody holds a seat in the role passes', () => {
    expect(releaseRoleSetRefusal(flip, personStored)).toBeNull();
  });

  it('refuses a seated key whose stored row is gone, and admits the release where a system-held row is stored', () => {
    expect(releaseRoleSetRefusal(flip, { roles: [], seated: ['runner'] })).toMatch(/with no definition stored/);
    expect(releaseRoleSetRefusal(flip, { roles: [{ key: 'runner', permissions: ['a:run'], holder: 'system' }], seated: ['runner'] })).toBeNull();
  });

  it('asks the scopes only for a release with a system-held role, or a role holding a key its registry does not declare', () => {
    expect(releaseRolesAskScopes(flip)).toBe(true);
    expect(releaseRolesAskScopes(registry([{ key: 'member', permissions: ['a:use'] }]))).toBe(false);
    expect(releaseRolesAskScopes(registry([{ key: 'member', permissions: ['a:use'], holder: 'person' }]))).toBe(false);
    expect(releaseRolesAskScopes(registry([{ key: 'member', permissions: ['x:other'] }]))).toBe(true);
    expect(releaseRolesAskScopes(registry([]))).toBe(false);
  });

  it('a release that asks no scope is one no stored state refuses (the property the skip rests on)', () => {
    const quiet = registry([{ key: 'member', permissions: ['a:use'] }]);
    const states = [
      { roles: [], seated: ['member'] },
      { roles: [{ key: 'member', permissions: ['a:run'], holder: 'system' as const }], seated: ['member'] },
      { roles: [{ key: 'other', permissions: ['a:use'], holder: 'system' as const }], seated: [] },
      { roles: [{ key: 'member', permissions: ['a:use'] }], seated: ['member'] },
      // #2531: a tombstone changes nothing for such a release either.
      { roles: [], seated: ['member'], dropped: [{ key: 'member', permissions: ['a:run'], holder: 'system' as const }] },
    ];
    for (const s of states) expect(releaseRoleSetRefusal(quiet, s)).toBeNull();
    // Its positive twin: an undeclared key is judged against a stored system-held row.
    const undeclared = registry([{ key: 'member', permissions: ['x:other'] }]);
    expect(releaseRoleSetRefusal(undeclared, { roles: [{ key: 'member', permissions: ['x:other'], holder: 'system' }], seated: [] })).toMatch(
      /would hold x:other \(held by its stored system-held definition\)/,
    );
  });
});
