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
  retiredKeysOf,
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
    const refused = (from: string | null, to: string | null, opts?: Parameters<typeof assertNoBindingShapeBreak>[2]) => {
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
      const e = refused(retiredAll, manifest(), { judgedFrom: '2 install(s) with no reconcile receipt (one is s1)', retiredStillHeld: true });
      expect(e?.message).toMatch(/drops the shape; bound people keep desk:read-own.*Judged from 2 install\(s\) with no reconcile receipt \(one is s1\)$/);
      // A move that strands nobody even so is not refused: the key stays retired in the incoming version.
      expect(refused(retiredAll, manifest(shape({ permissions: ['desk:other'], retired: ['desk:read-own'] })), { retiredStillHeld: true })).toBeNull();
    });

    /**
     * #2185: an install whose reconcile of a version did NOT finish its retirements is judged from
     * that version with its retired keys still held (`retiredStillHeld`), and one whose retirements
     * finished from the version as it is. The adapters choose between the two per group; these are
     * the two judgments, over the strand and the evolutions #2181 holds.
     */
    describe('from a version whose retirements did or did not finish (#2185)', () => {
      const unfinished = { judgedFrom: '1 install(s) that reconciled v3 with its retirements not finished (one is s1)', retiredStillHeld: true };
      const v1 = manifest(shape({ permissions: ['desk:a', 'desk:b'] }));
      const v2ok = manifest(shape({ permissions: ['desk:a'], retired: ['desk:b'] }));
      const v3ok = manifest(shape({ permissions: [], retired: ['desk:a', 'desk:b'] }));
      const v4 = manifest();

      it('refuses the drop from a retire-all version whose retirements did not finish, naming what it waits for', () => {
        const e = refused(v3ok, v4, unfinished);
        expect(e?.message).toMatch(/drops the shape; bound people keep desk:a, desk:b/);
        expect(e?.message).toMatch(/Judged from 1 install\(s\) that reconciled v3 with its retirements not finished \(one is s1\)$/);
        expect(e).toMatchObject({ code: 'precondition_failed' });
      });

      it('passes the same drop once they finished (retire-all, then drop)', () => {
        expect(refused(v3ok, v4)).toBeNull();
      });

      it('holds the v1..v4 strand at every step either way, and its twin path only where the retirements finished', () => {
        const v2 = manifest(shape({ permissions: ['desk:a'] }));
        const v3 = manifest(shape({ permissions: [], retired: ['desk:a'] }));
        for (const opts of [{}, unfinished]) {
          expect(refused(v1, v2, opts)?.message).toMatch(/bound people keep desk:b/);
          expect(refused(v1, v3, opts)?.message).toMatch(/bound people keep desk:b/);
        }
        // The twin path: b retired as it is dropped, then a, then the drop.
        expect(refused(v1, v2ok)).toBeNull();
        expect(refused(v2ok, v3ok)).toBeNull();
        expect(refused(v3ok, v4)).toBeNull();
        // With v2's retirement of b unfinished, moving on to v3 (which still retires b) strands no one…
        expect(refused(v2ok, v3ok, unfinished)).toBeNull();
        // …but dropping the shape straight from it does.
        expect(refused(v2ok, v4, unfinished)?.message).toMatch(/bound people keep desk:a, desk:b/);
      });

      it('passes a legitimate evolution from an unfinished version: a key added, a key dropped and retired', () => {
        expect(refused(v2ok, manifest(shape({ permissions: ['desk:a', 'desk:c'], retired: ['desk:b'] })), unfinished)).toBeNull();
        expect(refused(v2ok, manifest(shape({ permissions: ['desk:c'], retired: ['desk:a', 'desk:b'] })), unfinished)).toBeNull();
      });

      it('judges a version that retires nothing the same whether or not its retirements are said to have finished', () => {
        const plain = manifest(shape({ permissions: ['desk:a'] }));
        expect(refused(plain, manifest(shape({ permissions: ['desk:a', 'desk:c'] })), unfinished)).toBeNull();
        expect(refused(plain, v4, unfinished)?.message).toBe(refused(plain, v4)?.message + `. Judged from ${unfinished.judgedFrom}`);
      });
    });

    it('passes the types bound through to the gate (#2184): a drop after `bind` was dropped', () => {
      const unbound = manifest(shape({ bind: undefined }));
      expect(refused(unbound, manifest())).toBeNull();
      const judgedFrom = '1 install(s) that last reconciled v2, where links have bound people to contact (one is s1)';
      const e = refused(unbound, manifest(), { judgedFrom, boundEver: ['contact'] });
      expect(e?.message).toMatch(/^this version would strand people bound to contact \(drops the shape; bound people keep desk:read-own\)/);
      expect(e?.message).toMatch(/Judged from 1 install\(s\) that last reconciled v2, where links have bound people to contact \(one is s1\)$/);
      expect(e).toMatchObject({ code: 'precondition_failed' });
      expect(refused(unbound, manifest(), { boundEver: 'unknown' })).toMatchObject({ code: 'precondition_failed' });
      expect(refused(unbound, manifest(), { boundEver: [] })).toBeNull();
    });

    it('fails closed on grant shapes it cannot read, on either side', () => {
      const broken = JSON.stringify({ registry: { entityGrants: [{ entityType: 7 }] } });
      expect(refused(broken, manifest())?.message).toMatch(/running version's grant shapes cannot be read/);
      expect(refused(manifest(), broken)?.message).toMatch(/incoming version's grant shapes cannot be read/);
      expect(refused('not json', manifest())).toMatchObject({ code: 'precondition_failed' });
    });
  });
});

/**
 * #2184: dropping `bind` stops new links and leaves the people already bound holding the shape
 * (#2174). Judged from the registry alone, a later version could then strand them, since no shape
 * binds any more. The gate also counts a shape as binding where a scope reported it bound
 * (`boundEver`), or did not report (`'unknown'`).
 */
describe('a shape a scope has bound, after its `bind` is dropped (#2184)', () => {
  const grants = (...entityGrants: EntityGrantShape[]) => ({ entityGrants });
  const moved = { ...holder, principalColumn: 'owner' };
  const v1 = grants(shape({ permissions: ['desk:a', 'desk:b'] }));
  const v2 = grants(shape({ permissions: ['desk:a', 'desk:b'], bind: undefined }));

  it('lets `bind` be dropped, which strands no one', () => {
    for (const bound of [[], ['contact'], 'unknown'] as const) expect(bindingShapeBreaks(v1, v2, bound)).toEqual([]);
  });

  it('refuses the shape removed after `bind` was dropped where a scope bound it, or did not say; not judged by the registry alone', () => {
    // The bypass #2184 closes: judged from the registry, nothing binds in v2.
    expect(bindingShapeBreaks(v2, grants())).toEqual([]);
    const strand = [{ entityType: 'contact', change: 'removed', unretired: ['desk:a', 'desk:b'] }];
    expect(bindingShapeBreaks(v2, grants(), ['contact'])).toEqual(strand);
    expect(bindingShapeBreaks(v2, grants(), 'unknown')).toEqual(strand);
    // Another type bound there says nothing about this one.
    expect(bindingShapeBreaks(v2, grants(), ['ticket'])).toEqual([]);
  });

  it.each([
    ['moves its holder', grants(shape({ permissions: ['desk:a', 'desk:b'], bind: undefined, holder: moved })), 'holder', ['desk:a', 'desk:b']],
    ['makes it a sharing shape', grants({ entityType: 'contact', permissions: ['desk:a', 'desk:b'] } as EntityGrantShape), 'sharing', ['desk:a', 'desk:b']],
    ['drops a key unretired', grants(shape({ permissions: ['desk:a'], bind: undefined })), 'kept', ['desk:b']],
  ])('refuses a version that %s after `bind` was dropped, where a scope bound it', (_name, to, change, unretired) => {
    expect(bindingShapeBreaks(v2, to)).toEqual([]);
    expect(bindingShapeBreaks(v2, to, ['contact'])).toEqual([{ entityType: 'contact', change, unretired }]);
  });

  it('holds the v1..v4 strand with `bind` dropped at v2, and passes its twin path', () => {
    const v3 = grants(shape({ permissions: ['desk:a'], bind: undefined }));
    const v4 = grants(shape({ permissions: [], retired: ['desk:a'], bind: undefined }));
    expect(bindingShapeBreaks(v2, v3, ['contact'])).toEqual([{ entityType: 'contact', change: 'kept', unretired: ['desk:b'] }]);
    expect(bindingShapeBreaks(v2, v4, ['contact'])).toEqual([{ entityType: 'contact', change: 'kept', unretired: ['desk:b'] }]);
    // The twin: b retired as it is dropped, then a, then the shape goes.
    const v3ok = grants(shape({ permissions: ['desk:a'], retired: ['desk:b'], bind: undefined }));
    const v4ok = grants(shape({ permissions: [], retired: ['desk:a', 'desk:b'], bind: undefined }));
    for (const bound of [['contact'], 'unknown'] as const) {
      expect(bindingShapeBreaks(v2, v3ok, bound)).toEqual([]);
      expect(bindingShapeBreaks(v3ok, v4ok, bound)).toEqual([]);
      expect(bindingShapeBreaks(v4ok, grants(), bound)).toEqual([]);
    }
  });

  it('passes a legitimate evolution of a bound shape: a key added, a key dropped and retired', () => {
    expect(bindingShapeBreaks(v2, grants(shape({ permissions: ['desk:a', 'desk:b', 'desk:c'], bind: undefined })), ['contact'])).toEqual([]);
    expect(bindingShapeBreaks(v2, grants(shape({ permissions: ['desk:a'], retired: ['desk:b'], bind: undefined })), ['contact'])).toEqual([]);
  });

  it('passes a vertical whose table-held shape never bound: refused only while unknown, then free once the scope says []', () => {
    const plain = grants(shape({ bind: undefined }));
    expect(bindingShapeBreaks(plain, grants(), 'unknown')).toEqual([{ entityType: 'contact', change: 'removed', unretired: ['desk:read-own'] }]);
    expect(bindingShapeBreaks(plain, grants(), [])).toEqual([]);
  });

  it.each([
    ['a sharing shape', { entityType: 'contact', permissions: ['desk:a'] } as EntityGrantShape],
    ["a 'grantee' shape", shape({ permissions: ['desk:a'], holder: 'grantee', bind: undefined })],
    ["a 'self' shape", shape({ permissions: ['desk:a'], holder: 'self', bind: undefined })],
  ])('never counts %s as bound, whatever the scope bound of its type before: no link binds through it', (_name, before) => {
    expect(bindingShapeBreaks(grants(before), grants(), ['contact'])).toEqual([]);
    expect(bindingShapeBreaks(grants(before), grants(), 'unknown')).toEqual([]);
  });
});

describe('the keys a retirement takes back (#2185)', () => {
  it('is the retired keys the shape does not grant again, each once, sorted', () => {
    expect(retiredKeysOf(shape({ permissions: ['desk:a'], retired: ['desk:c', 'desk:b', 'desk:c'] }))).toEqual(['desk:b', 'desk:c']);
    // A key back in `permissions` ends its retirement, so it is not taken back.
    expect(retiredKeysOf(shape({ permissions: ['desk:a', 'desk:b'], retired: ['desk:b'] }))).toEqual([]);
  });

  it('is nothing for a sharing shape, which is never reconciled, or a shape retiring nothing', () => {
    expect(retiredKeysOf(shape({ entityType: 'list', permissions: [], retired: ['list:read'], bootstrap: undefined, bind: undefined }))).toEqual([]);
    expect(retiredKeysOf(shape())).toEqual([]);
  });
});
