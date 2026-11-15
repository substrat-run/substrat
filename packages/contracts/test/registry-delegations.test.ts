/**
 * #3161: the module manifests' `delegations` carried in the permission registry, from the build to
 * the push boundary to the reader, and itemised by the promote diff. A vertical that delegates
 * nothing builds the registry it built before, so its permission digest does not move.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPermissionRegistry,
  delegationsOf,
  permissionRegistry,
  pushedDelegationProblems,
  pushedPermissionRegistry,
  type DeployModuleDeclaration,
  type PermissionRegistry,
  type PermissionsInput,
} from '../src/deploy.js';
import { diffRegistries, hasRegistryChange, registryDirection, unitemisedRegistryChanges, type RegistryLike } from '../src/registry-diff.js';

type Delegation = { actor: string; permissions: string[]; channels?: ('mcp' | 'peer')[] };

const KEYS = [
  { key: 'notes:read', description: 'Read a note' },
  { key: 'notes:write', description: 'Write a note' },
  { key: 'notes:sweep', description: 'Sweep the bin', holder: 'system' as const },
];

const surface = (modules: { id: string; delegations?: Delegation[] }[]): PermissionsInput =>
  ({
    modules: modules.map((m, i) => ({ manifest: { id: m.id, permissions: i === 0 ? KEYS : [], ...(m.delegations ? { delegations: m.delegations } : {}) } })),
    roles: [{ key: 'owner', permissions: ['notes:read', 'notes:write'], source: 'vertical' }],
  }) as never;

describe('buildPermissionRegistry carries delegations', () => {
  it('merges one actor across modules (keys and modules unioned), writes channels only when not mcp alone, and sorts', () => {
    const reg = buildPermissionRegistry(
      surface([
        { id: '@fixture/notes', delegations: [{ actor: 'todo', permissions: ['notes:write'] }, { actor: 'crm', permissions: ['notes:read'], channels: ['peer'] }] },
        { id: '@fixture/tags', delegations: [{ actor: 'todo', permissions: ['notes:read', 'notes:write'], channels: ['mcp'] }] },
      ]),
    );
    expect(reg.delegations).toEqual([
      { actor: 'crm', permissions: ['notes:read'], channels: ['peer'], declaredBy: ['@fixture/notes'] },
      { actor: 'todo', permissions: ['notes:read', 'notes:write'], declaredBy: ['@fixture/notes', '@fixture/tags'] },
    ]);
    // What it builds is what the push boundary admits.
    expect(pushedPermissionRegistry.safeParse(reg).success).toBe(true);
  });

  it('builds no field when nothing is delegated, an empty list included, so the digest input is what it was', () => {
    const reg = buildPermissionRegistry(surface([{ id: '@fixture/notes', delegations: [] }, { id: '@fixture/tags' }]));
    expect('delegations' in reg).toBe(false);
  });

  it.each([
    ['a key nothing declares, on the line lint:permissions prints', [{ actor: 'todo', permissions: ['notes:delete'] }], /delegation `todo` → `notes:delete`: a key nothing here declares/],
    ['a key reserved to a system principal', [{ actor: 'todo', permissions: ['notes:sweep'] }], /delegation `todo` → `notes:sweep`: reserved to a system principal/],
  ])('refuses %s', (_, delegations, message) => {
    expect(() => buildPermissionRegistry(surface([{ id: '@fixture/notes', delegations }]))).toThrow(message);
  });

  it('refuses one actor on different channels in two modules: a merged row would hand mcp-only keys to peer', () => {
    expect(() =>
      buildPermissionRegistry(
        surface([
          { id: '@fixture/notes', delegations: [{ actor: 'todo', permissions: ['notes:read'] }] },
          { id: '@fixture/tags', delegations: [{ actor: 'todo', permissions: ['notes:write'], channels: ['peer'] }] },
        ]),
      ),
    ).toThrow(/delegations 'todo' \(@fixture\/tags\): declares channels peer where @fixture\/notes declares mcp/);
  });
});

describe('the push boundary and the reader', () => {
  const base = { permissions: KEYS.map((k) => ({ ...k, declaredBy: ['@fixture/notes'] })), roles: [], entityGrants: [] };

  it('refuses a registry row delegating a key it does not declare or reserves', () => {
    const r = pushedPermissionRegistry.safeParse({ ...base, delegations: [{ actor: 'todo', permissions: ['notes:delete', 'notes:sweep'], declaredBy: ['@fixture/notes'] }] });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toEqual([
      "delegations 'todo': delegates notes:delete, which the registry does not declare",
      "delegations 'todo': delegates notes:sweep, which is reserved to a system principal",
    ]);
  });

  it('holds the registry rows to the modules a current CLI sends, and cannot check an older one', () => {
    const modules = (delegations?: Delegation[]): DeployModuleDeclaration[] =>
      [{ id: '@fixture/notes', permissions: [], ...(delegations ? { delegations } : {}) }] as never;
    const row = { actor: 'todo', permissions: ['notes:read', 'notes:write'], declaredBy: ['@fixture/notes'] } as never;
    expect(pushedDelegationProblems(modules([{ actor: 'todo', permissions: ['notes:read', 'notes:write'] }]), { delegations: [row] })).toEqual([]);
    expect(pushedDelegationProblems(modules([{ actor: 'todo', permissions: ['notes:read'] }]), { delegations: [row] })).toEqual([
      "delegations 'todo': registry row disagrees with module declarations",
    ]);
    expect(pushedDelegationProblems(modules([{ actor: 'todo', permissions: ['notes:read'] }]), {})).toEqual([
      "delegations 'todo': module declaration is absent from registry",
    ]);
    expect(pushedDelegationProblems(modules(), { delegations: [row] })).toEqual([]);
  });

  it('reads a version as its delegations, [] when a current CLI declared none, and null when it cannot say', () => {
    const registry = permissionRegistry.parse(base);
    const current = [{ id: '@fixture/notes', permissions: [], delegations: [] }] as never;
    const older = [{ id: '@fixture/notes', permissions: [] }] as never;
    const rows = [{ actor: 'todo', permissions: ['notes:read'], channels: ['peer'], declaredBy: ['@fixture/notes'] }];
    expect(delegationsOf({ modules: current, registry: { ...registry, delegations: rows } as PermissionRegistry })).toEqual([
      { actor: 'todo', permissions: ['notes:read'], channels: ['peer'] },
    ]);
    expect(delegationsOf({ modules: current, registry })).toEqual([]);
    // A registry stored before the field still parses, and says nothing: never read as "revoke".
    expect('delegations' in registry).toBe(false);
    expect(delegationsOf({ modules: older, registry })).toBeNull();
    expect(delegationsOf({ registry })).toBeNull();
  });
});

describe('the promote diff itemises a delegation', () => {
  const reg = (delegations?: Delegation[]): RegistryLike => ({
    permissions: KEYS,
    roles: [],
    entityGrants: [],
    ...(delegations ? { delegations } : {}),
  });

  it('reads a new actor, a gained key or a gained channel as a widening, and the reverse as a narrowing', () => {
    const narrow = reg([{ actor: 'todo', permissions: ['notes:read'] }]);
    const wide = reg([{ actor: 'todo', permissions: ['notes:read', 'notes:write'], channels: ['mcp', 'peer'] }]);
    const d = diffRegistries(narrow, wide);
    expect(d.delegationChanges).toEqual([
      { actor: 'todo', added: ['notes:write'], removed: [], addedChannels: ['peer'], removedChannels: [], isNew: false, isGone: false },
    ]);
    expect(registryDirection(d)).toBe('adds');
    expect(registryDirection(diffRegistries(wide, narrow))).toBe('removes');
    expect(registryDirection(diffRegistries(reg(), narrow))).toBe('adds');
    expect(diffRegistries(narrow, reg()).delegationChanges).toEqual([
      { actor: 'todo', added: [], removed: ['notes:read'], addedChannels: [], removedChannels: ['mcp'], isNew: false, isGone: true },
    ]);
    // Itemised, so not named again as an unitemised field.
    expect(unitemisedRegistryChanges(narrow as never, wide as never, d)).toEqual([]);
  });

  it('is no change for channels written out as the default, and names a move of declaring module alone', () => {
    const d = diffRegistries(reg([{ actor: 'todo', permissions: ['notes:read'] }]), reg([{ actor: 'todo', permissions: ['notes:read'], channels: ['mcp'] }]));
    expect(hasRegistryChange(d)).toBe(false);
    const from = { ...reg(), delegations: [{ actor: 'todo', permissions: ['notes:read'], declaredBy: ['a'] }] };
    const to = { ...reg(), delegations: [{ actor: 'todo', permissions: ['notes:read'], declaredBy: ['b'] }] };
    expect(unitemisedRegistryChanges(from as never, to as never)).toEqual(['delegations']);
  });
});
