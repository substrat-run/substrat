/**
 * #1686: a binding shape's `bind` — who may hand a record's shape to the person it names. What the
 * registry refuses where it is built and where a push carries it, that a registry binding nothing
 * keeps the permission digest it had, and how a version-to-version diff states a bind change.
 */
import { describe, expect, it } from 'vitest';
import {
  assertNoBindingShapeBreak,
  bindShapeProblems,
  buildPermissionRegistry,
  pushedPermissionRegistry,
  type EntityGrantShape,
  type ModuleManifest,
} from '../src/index.js';
import { bindingShapeBreaks, diffRegistries, grantShapeHolderNotes, registryDirection } from '../src/registry-diff.js';

const holder = { table: 'desk_contacts', idColumn: 'id', principalColumn: 'principal' };
const shape = (over: Partial<Record<keyof EntityGrantShape, unknown>> = {}) =>
  ({ entityType: 'contact', permissions: ['desk:read-own'], bootstrap: true, holder, bind: { permission: 'contact:invite' }, ...over }) as EntityGrantShape;
/** Only what the registry builder reads off a module: its id and its declared keys. */
const manifest = {
  id: '@test/desk',
  permissions: [
    { key: 'desk:read-own', description: 'read your own history' },
    { key: 'contact:invite', description: 'invite a contact to their portal' },
  ],
} as unknown as ModuleManifest;
const build = (entityGrants: EntityGrantShape[], modules = [{ manifest }]) => buildPermissionRegistry({ modules, roles: [], entityGrants });

describe("a shape's `bind` (#1686)", () => {
  it('is accepted on a bootstrap shape with a table holder, carried into the registry', () => {
    expect(build([shape()]).entityGrants).toEqual([{ ...shape(), permissions: ['desk:read-own'] }]);
  });

  it('is omitted when unset, so a registry that binds nothing is the registry it was', () => {
    const plain = build([shape({ bind: undefined })]);
    expect(plain.entityGrants[0]).not.toHaveProperty('bind');
    expect(build([{ ...shape(), bind: undefined }])).toEqual(plain);
  });

  it.each([
    ['on a sharing shape', shape({ bootstrap: undefined }), /only for a bootstrap shape/],
    ["with a 'grantee' holder", shape({ holder: 'grantee' }), /needs a table holder/],
    ["with a 'self' holder", shape({ holder: 'self' }), /needs a table holder/],
    ['with no holder', shape({ holder: undefined }), /needs a table holder/],
    ["with one of the shape's own keys", shape({ bind: { permission: 'desk:read-own' } as EntityGrantShape['bind'] }), /one of the shape's own keys/],
    ['with a key the shape retired', shape({ retired: ['contact:invite'] } as Partial<EntityGrantShape>), /one of the shape's own keys/],
  ])('refuses one %s, where the registry is built and where a push carries it', (_name, bad, message) => {
    expect(bindShapeProblems(bad)).toEqual([expect.stringMatching(message)]);
    expect(() => build([bad])).toThrow(message);
    const pushed = pushedPermissionRegistry.safeParse({ permissions: [], roles: [], entityGrants: [bad] });
    expect(pushed.success).toBe(false);
    expect(pushed.error?.issues.some((i) => message.test(i.message))).toBe(true);
  });

  it('refuses a bind key no module declares, where the registry is built', () => {
    expect(() => build([shape({ bind: { permission: 'contact:nobody' } as EntityGrantShape['bind'] })])).toThrow(/which no module declares/);
  });

  it('a push carrying a sound binding parses', () => {
    expect(pushedPermissionRegistry.parse({ permissions: [], roles: [], entityGrants: [shape()] }).entityGrants[0]?.bind).toEqual({
      permission: 'contact:invite',
    });
  });
});

describe('a bind change between versions (#1686)', () => {
  const registry = (grant: EntityGrantShape) => ({ permissions: [], roles: [], entityGrants: [grant] });

  it('gaining a bind is a change that adds, and says who may now hand the shape out', () => {
    const d = diffRegistries(registry(shape({ bind: undefined })), registry(shape()));
    expect(d.grantChanges).toEqual([
      { entityType: 'contact', added: [], removed: [], retired: [], kept: [], bind: { from: null, to: 'contact:invite' }, isNew: false, isGone: false },
    ]);
    expect(registryDirection(d)).toBe('adds');
    expect(grantShapeHolderNotes(d.grantChanges[0]!)).toEqual(['whoever holds contact:invite on a record may bind its person to it with a link']);
  });

  it('losing one is a change that removes', () => {
    const d = diffRegistries(registry(shape()), registry(shape({ bind: undefined })));
    expect(d.grantChanges[0]?.bind).toEqual({ from: 'contact:invite', to: null });
    expect(registryDirection(d)).toBe('removes');
    expect(grantShapeHolderNotes(d.grantChanges[0]!)).toEqual(['links may no longer bind a person to a record (was contact:invite)']);
  });

  it('an unchanged bind is no change at all', () => {
    expect(diffRegistries(registry(shape()), registry(shape())).grantChanges).toEqual([]);
  });
});

describe('a holder change between versions (#2178)', () => {
  const registry = (grant: EntityGrantShape) => ({ permissions: [], roles: [], entityGrants: [grant] });

  it.each([
    ['table', { ...holder, table: 'desk_people' }, 'desk_people.principal (by id)'],
    ['id column', { ...holder, idColumn: 'key' }, 'desk_contacts.principal (by key)'],
    ['principal column', { ...holder, principalColumn: 'owner' }, 'desk_contacts.owner (by id)'],
    ['kind', 'grantee' as const, 'grantee'],
  ])('a moved %s is reported, with a note that existing holders stay where they were', (_name, to, label) => {
    const d = diffRegistries(registry(shape({ bind: undefined })), registry(shape({ bind: undefined, holder: to })));
    expect(d.grantChanges[0]?.holder).toEqual({ from: 'desk_contacts.principal (by id)', to: label });
    expect(grantShapeHolderNotes(d.grantChanges[0]!)).toEqual([
      `holders are now read from ${label} (was desk_contacts.principal (by id)); existing holders are not moved`,
    ]);
    expect(registryDirection(d)).toBe('mixed');
  });

  it('a holder declared where there was none is a change too; an unchanged one, or a shape appearing, says no holder change', () => {
    expect(diffRegistries(registry(shape({ bind: undefined, holder: undefined })), registry(shape({ bind: undefined }))).grantChanges[0]?.holder).toEqual({
      from: null,
      to: 'desk_contacts.principal (by id)',
    });
    expect(diffRegistries(registry(shape()), registry({ ...shape(), holder: { ...holder } })).grantChanges).toEqual([]);
    expect(diffRegistries({ permissions: [], roles: [], entityGrants: [] }, registry(shape())).grantChanges[0]).not.toHaveProperty('holder');
  });
});

describe('the binding-shape gate (#2178)', () => {
  const grants = (...entityGrants: EntityGrantShape[]) => ({ entityGrants });
  const moved = { ...holder, principalColumn: 'owner' };

  it.each([
    ['drops the shape', grants(), 'removed'],
    ['moves its holder', grants(shape({ holder: moved })), 'holder'],
    ['makes it a sharing shape', grants({ entityType: 'contact', permissions: ['desk:read-own'] } as EntityGrantShape), 'sharing'],
    ['retires every key and drops the bind, holder moved', grants(shape({ permissions: [], retired: ['desk:read-own'], holder: moved, bind: undefined })), null],
  ])('judges a version that %s while the running one binds', (_name, to, change) => {
    const from = grants(shape({ permissions: ['desk:read-own'] }));
    const breaks = bindingShapeBreaks(from, to);
    if (change === null) expect(breaks).toEqual([]);
    else expect(breaks).toEqual([{ entityType: 'contact', change, unretired: ['desk:read-own'] }]);
  });

  it('refuses a key dropped from a binding shape without being retired: v1 {a, b} → v2 {a} → v3 retires a → v4 drops (review of #2181)', () => {
    const v1 = grants(shape({ permissions: ['desk:a', 'desk:b'] }));
    const v2 = grants(shape({ permissions: ['desk:a'] }));
    expect(bindingShapeBreaks(v1, v2)).toEqual([{ entityType: 'contact', change: 'kept', unretired: ['desk:b'] }]);
    // Directly to the version that retires only `a` is the same strand of `b`.
    const v3 = grants(shape({ permissions: [], retired: ['desk:a'] }));
    expect(bindingShapeBreaks(v1, v3)).toEqual([{ entityType: 'contact', change: 'kept', unretired: ['desk:b'] }]);
    // The positive twin: `b` retired in the step that drops it, then `a`, then the shape goes.
    const v2ok = grants(shape({ permissions: ['desk:a'], retired: ['desk:b'] }));
    const v3ok = grants(shape({ permissions: [], retired: ['desk:a', 'desk:b'] }));
    expect(bindingShapeBreaks(v1, v2ok)).toEqual([]);
    expect(bindingShapeBreaks(v2ok, v3ok)).toEqual([]);
    expect(bindingShapeBreaks(v3ok, grants())).toEqual([]);
  });

  it('passes a legitimate evolution: a key added, a key dropped and retired in the same version', () => {
    const from = grants(shape({ permissions: ['desk:a', 'desk:b'] }));
    expect(bindingShapeBreaks(from, grants(shape({ permissions: ['desk:a', 'desk:b', 'desk:c'] })))).toEqual([]);
    expect(bindingShapeBreaks(from, grants(shape({ permissions: ['desk:a', 'desk:c'], retired: ['desk:b'] })))).toEqual([]);
  });

  it('names only the keys left unretired', () => {
    const from = grants(shape({ permissions: ['desk:read-own', 'desk:write-own'] }));
    expect(bindingShapeBreaks(from, grants(shape({ permissions: [], retired: ['desk:read-own'], holder: moved })))).toEqual([
      { entityType: 'contact', change: 'holder', unretired: ['desk:write-own'] },
    ]);
  });

  it.each([
    ['the same shape', grants(shape())],
    ['the shape without its bind (its holder stays recorded, and it can still be retired)', grants(shape({ bind: undefined }))],
    ['a version retiring every key, holder moved', grants(shape({ permissions: [], retired: ['desk:read-own'], holder: moved }))],
    ['a shape with more keys', grants(shape({ permissions: ['desk:read-own', 'desk:write-own'] }))],
  ])('passes %s', (_name, to) => {
    expect(bindingShapeBreaks(grants(shape()), to)).toEqual([]);
  });

  it.each([
    ['a shape that does not bind', shape({ bind: undefined })],
    ['a binding shape with no current key', shape({ permissions: [], retired: ['desk:read-own'] })],
    ['a sharing shape', { entityType: 'contact', permissions: ['desk:read-own'] } as EntityGrantShape],
  ])('never judges the drop of %s', (_name, before) => {
    expect(bindingShapeBreaks(grants(before), grants())).toEqual([]);
  });

  describe('over stored manifests', () => {
    const manifest = (...entityGrants: EntityGrantShape[]) => JSON.stringify({ registry: { permissions: [], roles: [], entityGrants } });
    const refused = (from: string | null, to: string | null) => refused2(from, to);
    const refused2 = (from: string | null, to: string | null, opts?: Parameters<typeof assertNoBindingShapeBreak>[2]) => {
      try {
        assertNoBindingShapeBreak(from, to, opts);
        return null;
      } catch (e) {
        return e as Error & { code?: string };
      }
    };

    it('refuses a strand precondition_failed, saying how to get through and that a rollback is refused too', () => {
      const e = refused(manifest(shape()), manifest());
      expect(e?.message).toMatch(/^this version would strand people bound to contact \(drops the shape; bound people keep desk:read-own\)/);
      expect(e?.message).toMatch(/Retire those keys first/);
      expect(e?.message).toMatch(/\(a rollback\) is refused the same way, and no acknowledgement passes it/);
      expect(e).toMatchObject({ code: 'precondition_failed' });
    });

    it('passes a manifest with no registry, or two that keep the shape', () => {
      expect(refused(null, null)).toBeNull();
      expect(refused(JSON.stringify({}), manifest())).toBeNull();
      expect(refused(manifest(shape()), manifest(shape()))).toBeNull();
      // No shape before, so nothing was bound with it.
      expect(refused(null, manifest(shape()))).toBeNull();
    });

    it('judges installs that may not have run a retirement as still holding its keys, and names what it judged from', () => {
      const retiredAll = manifest(shape({ permissions: [], retired: ['desk:read-own'] }));
      expect(refused(retiredAll, manifest())).toBeNull();
      const e = refused2(retiredAll, manifest(), { judgedFrom: '2 install(s) with no reconcile receipt (one is s1)', retiredStillHeld: true });
      expect(e?.message).toMatch(/drops the shape; bound people keep desk:read-own.*Judged from 2 install\(s\) with no reconcile receipt \(one is s1\)$/);
      // A move that strands nobody even so is not refused: the key stays retired in the incoming version.
      expect(refused2(retiredAll, manifest(shape({ permissions: ['desk:other'], retired: ['desk:read-own'] })), { retiredStillHeld: true })).toBeNull();
    });

    it('fails closed on grant shapes it cannot read, on either side', () => {
      const broken = JSON.stringify({ registry: { entityGrants: [{ entityType: 7 }] } });
      expect(refused(broken, manifest())?.message).toMatch(/running version's grant shapes cannot be read/);
      expect(refused(manifest(), broken)?.message).toMatch(/incoming version's grant shapes cannot be read/);
      expect(refused('not json', manifest())).toMatchObject({ code: 'precondition_failed' });
    });
  });
});
