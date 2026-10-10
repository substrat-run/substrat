/**
 * #1686: a binding shape's `bind` — who may hand a record's shape to the person it names. What the
 * registry refuses where it is built and where a push carries it, that a registry binding nothing
 * keeps the permission digest it had, and how a version-to-version diff states a bind change.
 */
import { describe, expect, it } from 'vitest';
import {
  bindShapeProblems,
  buildPermissionRegistry,
  pushedPermissionRegistry,
  type EntityGrantShape,
  type ModuleManifest,
} from '../src/index.js';
import { diffRegistries, grantShapeHolderNotes, registryDirection } from '../src/registry-diff.js';

const holder = { table: 'desk_contacts', idColumn: 'id', principalColumn: 'principal' };
const shape = (over: Partial<EntityGrantShape> = {}) =>
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
