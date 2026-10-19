/**
 * #2430: a key reserved to a system principal (`holder: 'system'` on its declaration) is carried on
 * the registry row and refused in a person's role or grant shape where the registry is built and
 * where a push carries it. A registry that reserves nothing is the registry it was.
 */
import { describe, expect, it } from 'vitest';
import { buildPermissionRegistry, pushedOwnerGrantProblems, pushedPermissionRegistry, type PermissionsInput } from '../src/deploy.js';
import { permissionKey } from '../src/ids.js';
import { moduleManifest } from '../src/manifest.js';
import {
  diffRegistries,
  hasRegistryChange,
  registryDirection,
  reservationNote,
  roleHolderNote,
  unitemisedRegistryChanges,
  type RegistryLike,
} from '../src/registry-diff.js';
import { declaredOwnerGrants, ownerGrantSets, reservedKeyOffences, reservedKeysOf } from '../src/reserved-keys.js';

const manifest = (id: string, permissions: { key: string; description: string; holder?: 'system' }[]) =>
  moduleManifest.parse({
    id,
    version: '0.1.0',
    kernelContract: '^0.1.0',
    permissions,
    events: { emits: [], consumes: [] },
    migrations: { journalDir: 'm', compatibleFrom: '0.0.0' },
    attachmentTargets: [],
    entitlementKey: 'x',
  });
const engine = {
  manifest: manifest('@acme/engine-assistant', [
    { key: 'assistant:use', description: 'use' },
    { key: 'assistant:run', description: 'drive a run', holder: 'system' },
  ]),
};
const build = (over: Partial<PermissionsInput> = {}) =>
  buildPermissionRegistry({ modules: [engine], roles: [], entityGrants: [], ...over });
const role = (key: string, permissions: string[], holder?: 'person' | 'system') =>
  ({ key, permissions, source: 'vertical', ...(holder ? { holder } : {}) }) as PermissionsInput['roles'][number];

describe('the registry carries the reservation (#2430)', () => {
  it('marks a reserved key holder: system and leaves every other row as it was', () => {
    expect(build().permissions).toEqual([
      { key: 'assistant:run', description: 'drive a run', declaredBy: ['@acme/engine-assistant'], holder: 'system' },
      { key: 'assistant:use', description: 'use', declaredBy: ['@acme/engine-assistant'] },
    ]);
  });

  it('…by the union rule: a module re-declaring the key unmarked does not lift it, in either order', () => {
    const vertical = { manifest: manifest('@acme/vertical', [{ key: 'assistant:run', description: 'mine now' }]) };
    for (const modules of [[engine, vertical], [vertical, engine]]) {
      const row = buildPermissionRegistry({ modules, roles: [] }).permissions.find((p) => p.key === 'assistant:run');
      expect(row?.holder).toBe('system');
    }
  });

  it('a registry that reserves nothing carries no holder at all, so its digest does not move', () => {
    const unmarked = { manifest: manifest('@acme/engine-y', [{ key: 'y:send', description: 'send' }]) };
    const registry = buildPermissionRegistry({ modules: [unmarked], roles: [role('member', ['y:send'], 'person')] });
    expect(registry.permissions[0]).not.toHaveProperty('holder');
    expect(registry.roles[0]).not.toHaveProperty('holder');
  });

  it('a system-held role carries holder: system; person and absent are both left out', () => {
    const registry = build({
      roles: [role('assistant-host', ['assistant:run'], 'system'), role('a', ['assistant:use'], 'person'), role('b', ['assistant:use'])],
    });
    expect(registry.roles.map((r) => [r.key, r.holder])).toEqual([
      ['a', undefined],
      ['assistant-host', 'system'],
      ['b', undefined],
    ]);
  });
});

describe('a reserved key in a person’s role or grant shape is refused where the registry is built (#2430)', () => {
  it.each([
    ['a person role', { roles: [role('member', ['assistant:use', 'assistant:run'])] }, /role member → assistant:run: declared `holder: 'system'` by @acme\/engine-assistant \(drive a run\)/],
    ['a role holder: person', { roles: [role('member', ['assistant:run'], 'person')] }, /role member → assistant:run/],
    ['an entity grant shape', { entityGrants: [{ entityType: 'thread', permissions: ['assistant:run'] }] }, /grant shape on thread → assistant:run/],
    ['a system-held role holding a person key', { roles: [role('host', ['assistant:run', 'assistant:use'], 'system')] }, /system-held role host → assistant:use: a system-held role holds only keys reserved/],
    ['an empty system-held role', { roles: [{ key: 'host', permissions: [], source: 'vertical', holder: 'system' }] as PermissionsInput['roles'] }, /system-held role host → \(none\): a system-held role must hold at least one/],
  ])('%s', (_name, over, message) => {
    expect(() => build(over as Partial<PermissionsInput>)).toThrow(message);
  });

  it('its twins pass: the run key in a system-held role, and person keys in person roles and shapes', () => {
    expect(() =>
      build({
        roles: [role('assistant-host', ['assistant:run'], 'system'), role('member', ['assistant:use'])],
        entityGrants: [{ entityType: 'thread', permissions: [permissionKey.parse('assistant:use')] }],
      }),
    ).not.toThrow();
  });
});

describe('the push boundary holds the same rule, read off the rows (#2430)', () => {
  const rows = build().permissions;

  it('refuses a person role holding a key its row marks reserved, in the registry’s words', () => {
    const pushed = pushedPermissionRegistry.safeParse({ permissions: rows, roles: [role('member', ['assistant:run'])] });
    expect(pushed.success).toBe(false);
    expect(pushed.error?.issues.map((i) => i.message)).toEqual([
      "role member → assistant:run: reserved to a system principal (`holder: 'system'` on its registry row)",
    ]);
  });

  it('refuses a grant shape and a malformed system-held role the same way', () => {
    const pushed = pushedPermissionRegistry.safeParse({
      permissions: rows,
      roles: [{ ...role('host', ['assistant:use'], 'system') }],
      entityGrants: [{ entityType: 'thread', permissions: ['assistant:run'] }],
    });
    expect(pushed.error?.issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/^system-held role host → \(none\)/),
      expect.stringMatching(/^system-held role host → assistant:use/),
      expect.stringMatching(/^grant shape on thread → assistant:run/),
    ]);
  });

  it('a registry from a CLI that predates the field marks nothing, so it is refused nothing', () => {
    const legacy = rows.map(({ holder: _held, ...row }) => row);
    expect(pushedPermissionRegistry.safeParse({ permissions: legacy, roles: [role('member', ['assistant:run'])] }).success).toBe(true);
  });

  it('a sound registry with a system-held role parses with both marks kept', () => {
    const registry = build({ roles: [role('assistant-host', ['assistant:run'], 'system'), role('member', ['assistant:use'])] });
    const parsed = pushedPermissionRegistry.parse(registry);
    expect(parsed.permissions.find((p) => p.key === 'assistant:run')?.holder).toBe('system');
    expect(parsed.roles.find((r) => r.key === 'assistant-host')?.holder).toBe('system');
  });
});

describe('attribution: a refusal names the module that marks the key, or none (#2430)', () => {
  const vertical = { manifest: manifest('@acme/vertical', [{ key: 'assistant:run', description: 'mine now' }]) };

  it('where the registry is built, the marking module and its description, though another re-declares the key', () => {
    expect(() => build({ modules: [vertical, engine], roles: [role('member', ['assistant:run'])] })).toThrow(
      /role member → assistant:run: declared `holder: 'system'` by @acme\/engine-assistant \(drive a run\)/,
    );
  });

  it('at the push boundary, the mark alone: the row lists every declarer, so it names none', () => {
    const rows = buildPermissionRegistry({ modules: [vertical, engine], roles: [] }).permissions;
    const pushed = pushedPermissionRegistry.safeParse({ permissions: rows, roles: [role('member', ['assistant:run'])] });
    expect(pushed.error?.issues.map((i) => i.message)).toEqual([
      "role member → assistant:run: reserved to a system principal (`holder: 'system'` on its registry row)",
    ]);
  });
});

describe('owner grants are a person’s grant (#2430)', () => {
  const owning = (ownerGrants: string[]) => ({ manifest: { ...engine.manifest, ownerGrants } as typeof engine.manifest });

  it('a module’s ownerGrants holding a reserved key is refused where the registry is built; its twin passes', () => {
    expect(() => build({ modules: [owning(['assistant:use', 'assistant:run'])] })).toThrow(
      /owner grants of @acme\/engine-assistant → assistant:run: declared `holder: 'system'`/,
    );
    expect(() => build({ modules: [owning(['assistant:use'])] })).not.toThrow();
  });

  it('the deploy manifest’s ownerGrants are judged against the registry’s marks at the push boundary', () => {
    const registry = build();
    expect(pushedOwnerGrantProblems({ ownerGrants: ['assistant:use', 'assistant:run'], registry })).toEqual([
      "owner grants (substrat.ownerGrants) → assistant:run: reserved to a system principal (`holder: 'system'` on its registry row)",
    ]);
    expect(pushedOwnerGrantProblems({ ownerGrants: ['assistant:use'], registry })).toEqual([]);
    // A registry from a CLI that predates the marks reserves nothing, and no registry judges nothing.
    const legacy = { ...registry, permissions: registry.permissions.map(({ holder: _held, ...row }) => row) };
    expect(pushedOwnerGrantProblems({ ownerGrants: ['assistant:run'], registry: legacy })).toEqual([]);
    expect(pushedOwnerGrantProblems({ ownerGrants: ['assistant:run'] })).toEqual([]);
  });

  it('ownerGrantSets names each set as its refusal does', () => {
    expect(ownerGrantSets([owning(['a:b'])], ['c:d'])).toEqual([
      { where: 'owner grants of @acme/engine-assistant', permissions: ['a:b'] },
      { where: 'owner grants (substrat.ownerGrants)', permissions: ['c:d'] },
    ]);
    expect(ownerGrantSets([engine])).toEqual([]);
  });

  it('declaredOwnerGrants reads package.json’s list, absent as none, and refuses anything else rather than reading it as none', () => {
    expect(declaredOwnerGrants(undefined)).toEqual({ grants: [] });
    expect(declaredOwnerGrants(['a:b', 'c:d'])).toEqual({ grants: ['a:b', 'c:d'] });
    for (const value of ['a:b', { a: 'b' }, ['a:b', 7], null, 3]) {
      expect(declaredOwnerGrants(value)).toEqual({
        problem: expect.stringMatching(/^declares `substrat\.ownerGrants` as .+, not an array of permission keys\. List the keys/),
      });
    }
  });
});

describe('the promotion diff itemises a moved reservation and a moved role holder (#2430)', () => {
  const key = (k: string, holder?: 'system') => ({ key: k, description: k, declaredBy: ['@acme/engine'], ...(holder ? { holder } : {}) });
  const reg = (permissions: ReturnType<typeof key>[], roles: { key: string; permissions: string[]; holder?: 'system' }[] = []) =>
    ({ permissions, roles: roles.map((r) => ({ ...r, source: 'vertical' })), entityGrants: [] }) as unknown as RegistryLike & Record<string, unknown>;

  it('a lifted reservation beside an added key is a row of its own, never folded into the other change', () => {
    const from = reg([key('a:run', 'system'), key('a:use')]);
    const to = reg([key('a:run'), key('a:use'), key('a:new')]);
    const diff = diffRegistries(from, to);
    expect(diff.addedKeys).toEqual(['a:new']);
    expect(diff.reservationChanges).toEqual([{ key: 'a:run', reserved: false }]);
    expect(reservationNote(diff.reservationChanges[0]!)).toMatch(/a:run is no longer reserved to a system principal/);
    expect(unitemisedRegistryChanges(from, to, diff)).toEqual([]);
    expect(registryDirection(diff)).toBe('adds');
  });

  it('a key that arrives reserved is an added key marked so, and one that arrives unmarked is not', () => {
    const diff = diffRegistries(reg([key('a:use')]), reg([key('a:use'), key('a:run', 'system'), key('a:new')]));
    expect(diff.addedKeys).toEqual(['a:run', 'a:new']);
    expect(diff.reservedAddedKeys).toEqual(['a:run']);
    expect(diff.reservationChanges).toEqual([]);
  });

  it('a new reservation narrows, alone', () => {
    const diff = diffRegistries(reg([key('a:run')]), reg([key('a:run', 'system')]));
    expect(diff.reservationChanges).toEqual([{ key: 'a:run', reserved: true }]);
    expect(hasRegistryChange(diff)).toBe(true);
    expect(registryDirection(diff)).toBe('removes');
  });

  it('a role moving from system-held to a person’s is a role change beside any other', () => {
    const from = reg([key('a:run', 'system'), key('a:use')], [{ key: 'host', permissions: ['a:run'], holder: 'system' }, { key: 'm', permissions: ['a:use'] }]);
    const to = reg([key('a:run', 'system'), key('a:use')], [{ key: 'host', permissions: ['a:run'] }, { key: 'm', permissions: [] }]);
    const diff = diffRegistries(from, to);
    const host = diff.roleChanges.find((r) => r.key === 'host');
    expect(host).toEqual({ key: 'host', added: [], removed: [], isNew: false, isGone: false, holder: { from: 'system', to: 'person' } });
    expect(roleHolderNote(host!)).toMatch(/now a role a person can hold/);
    expect(diff.roleChanges.find((r) => r.key === 'm')).not.toHaveProperty('holder');
  });

  it('a role that arrives system-held is marked so, never shown as a person’s role holding a reserved key', () => {
    const from = reg([key('a:use')], [{ key: 'm', permissions: ['a:use'] }]);
    const to = reg([key('a:use'), key('a:run', 'system')], [{ key: 'm', permissions: ['a:use'] }, { key: 'host', permissions: ['a:run'], holder: 'system' }]);
    const diff = diffRegistries(from, to);
    const host = diff.roleChanges.find((r) => r.key === 'host');
    expect(host).toEqual({ key: 'host', added: ['a:run'], removed: [], isNew: true, isGone: false, systemHeld: true });
    expect(roleHolderNote(host!)).toBe('held by a system principal (holder: system), not a role a person can hold');
    // A new role holds no holder move, so the direction stays what the keys say.
    expect(registryDirection(diff)).toBe('adds');
  });

  it('…and so does one that stays system-held while it changes, or is dropped; a person’s role is not marked', () => {
    const host = (permissions: string[]) => ({ key: 'host', permissions, holder: 'system' as const });
    const keys = [key('a:use'), key('a:run', 'system'), key('a:go', 'system')];
    const widened = diffRegistries(reg(keys, [host(['a:run'])]), reg(keys, [host(['a:run', 'a:go'])])).roleChanges[0]!;
    expect(widened).toMatchObject({ key: 'host', added: ['a:go'], systemHeld: true });
    expect(diffRegistries(reg(keys, [host(['a:run'])]), reg(keys, [])).roleChanges[0]).toMatchObject({ isGone: true, systemHeld: true });
    const person = diffRegistries(reg(keys, []), reg(keys, [{ key: 'm', permissions: ['a:use'] }])).roleChanges[0]!;
    expect(person).not.toHaveProperty('systemHeld');
    expect(roleHolderNote(person)).toBeNull();
  });

  it('a registry that moves nothing reports nothing, holder: person and absent alike', () => {
    const same = reg([key('a:run', 'system')], [{ key: 'm', permissions: ['a:run'] }]);
    const person = reg([key('a:run', 'system')], [{ key: 'm', permissions: ['a:run'], holder: 'person' as 'system' }]);
    expect(hasRegistryChange(diffRegistries(same, person))).toBe(false);
  });
});

describe('the rule itself', () => {
  it('reads a Set as well as the map reservedKeysOf returns', () => {
    const surface = { roles: [role('member', ['assistant:run'])], grants: [] };
    expect(reservedKeyOffences(surface, new Set(['assistant:run']))).toEqual(reservedKeyOffences(surface, reservedKeysOf([engine])));
  });
});
