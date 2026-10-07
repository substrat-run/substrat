/**
 * #2082: a bootstrap shape's `retired` keys — the reviewed removal. What the registry refuses
 * where it is built and where a push carries it, and that a registry retiring nothing keeps the
 * permission digest it had.
 */
import { describe, expect, it } from 'vitest';
import { buildPermissionRegistry, pushedPermissionRegistry, retiredShapeProblems, type EntityGrantShape } from '../src/deploy.js';

const shape = (over: Partial<EntityGrantShape> = {}) =>
  ({ entityType: 'employee', permissions: ['emp:read'], bootstrap: true, retired: ['emp:cancel'], ...over }) as EntityGrantShape;
const build = (entityGrants: EntityGrantShape[]) => buildPermissionRegistry({ modules: [], roles: [], entityGrants });

describe('a shape’s `retired` (#2082)', () => {
  it('is accepted on a bootstrap shape, sorted into the registry', () => {
    expect(build([shape({ retired: ['emp:z', 'emp:cancel'] })]).entityGrants).toEqual([
      { entityType: 'employee', permissions: ['emp:read'], bootstrap: true, retired: ['emp:cancel', 'emp:z'] },
    ]);
  });

  it('is omitted when empty, so a registry retiring nothing is the registry it was', () => {
    const before = build([shape({ retired: undefined })]);
    expect(build([shape({ retired: [] })])).toEqual(before);
    expect(before.entityGrants[0]).not.toHaveProperty('retired');
  });

  it.each([
    ['on a sharing shape', shape({ bootstrap: undefined }), /only for a bootstrap shape/],
    ['a key the shape still grants', shape({ permissions: ['emp:read', 'emp:cancel'] }), /retires emp:cancel, which it still grants/],
    ['a key twice', shape({ retired: ['emp:cancel', 'emp:cancel'] }), /more than once/],
  ])('refuses %s, where the registry is built and where a push carries it', (_name, bad, message) => {
    expect(retiredShapeProblems(bad)).toEqual([expect.stringMatching(message)]);
    expect(() => build([bad])).toThrow(message);
    const pushed = pushedPermissionRegistry.safeParse({ permissions: [], roles: [], entityGrants: [bad] });
    expect(pushed.success).toBe(false);
    expect(pushed.error?.issues.map((i) => i.message)).toEqual([expect.stringMatching(message)]);
  });

  it('a push carrying a sound retirement parses', () => {
    expect(pushedPermissionRegistry.parse({ permissions: [], roles: [], entityGrants: [shape()] }).entityGrants[0]?.retired).toEqual([
      'emp:cancel',
    ]);
  });
});
