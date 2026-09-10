/**
 * `definePermissions` keeps the literals, and refuses a restatement that has drifted (#1208).
 *
 * The declared surface is the one place a vertical writes its permission keys, but the
 * manifests inside it are `moduleManifest.parse(…)` output — every `key` is the branded
 * `PermissionKey` by then, so the literal union `defineOperations` needs cannot be read back
 * off `modules`. `keys` is where the literals survive; the assertion is what stops that second
 * description from becoming a lie.
 *
 * The type half of this file is checked by `tsc -p tsconfig.test.json` (the package's
 * `typecheck` script), not by vitest — an `Exact` that resolved to `false` is a compile error
 * before any case runs.
 */
import { describe, expect, it } from 'vitest';
import { definePermissions, type PermissionKeysOf, type PermissionsInput } from '../src/deploy.js';

/** Invariant, not assignable-to: `string` extends nothing useful, so a widened key must fail. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exact = <T extends true>(_: T) => undefined;

/** A manifest's keys are branded, so a fixture builds the shape and casts once. */
const mod = (id: string, perms: [string, string][]) =>
  ({
    manifest: { id, permissions: perms.map(([key, description]) => ({ key, description })) },
  }) as unknown as PermissionsInput['modules'][number];

const MODULES = [mod('@substrat-run/engine-a', [['a:read', 'Read'], ['a:write', 'Write']])];
const ROLES: PermissionsInput['roles'] = [
  { key: 'staff', permissions: ['a:read'] as never, source: 'vertical' },
];

describe('definePermissions — `keys` is checked against the modules', () => {
  it('returns its input unchanged when the sets agree', () => {
    const input = { modules: MODULES, roles: ROLES, keys: ['a:read', 'a:write'] as const };
    expect(definePermissions(input)).toBe(input);
  });

  /** Order is not part of the agreement — the registry sorts, and so does nobody's memory. */
  it('does not care what order the keys are written in', () => {
    expect(() =>
      definePermissions({ modules: MODULES, roles: ROLES, keys: ['a:write', 'a:read'] as const }),
    ).not.toThrow();
  });

  /**
   * The dangerous direction: an operation type-checks against a permission nothing declares,
   * so it compiles and is unreachable at runtime.
   */
  it('throws, naming the key, when `keys` carries one no module declares', () => {
    expect(() =>
      definePermissions({ modules: MODULES, roles: ROLES, keys: ['a:read', 'a:write', 'a:delete'] as const }),
    ).toThrow(/in `keys` but declared by no module: 'a:delete'/);
  });

  /** The other direction: a real permission `defineOperations` would now reject. */
  it('throws, naming the key, when a module declares one `keys` omits', () => {
    expect(() =>
      definePermissions({ modules: MODULES, roles: ROLES, keys: ['a:read'] as const }),
    ).toThrow(/declared by a module but absent from `keys`: 'a:write'/);
  });

  /** Both at once is one throw naming both halves — a reviewer should not need two runs. */
  it('reports both directions in one message', () => {
    expect(() =>
      definePermissions({ modules: MODULES, roles: ROLES, keys: ['a:read', 'a:delete'] as const }),
    ).toThrow(/absent from `keys`: 'a:write'.*declared by no module: 'a:delete'/);
  });

  /** Every vertical on main omits `keys`; none of them may start throwing. */
  it('checks nothing when `keys` is omitted', () => {
    expect(() => definePermissions({ modules: MODULES, roles: ROLES })).not.toThrow();
  });

  /** A vertical with no modules at all (an issuer, say) declares no keys either. */
  it('accepts an empty surface with an empty key list', () => {
    expect(() => definePermissions({ modules: [], roles: [], keys: [] as const })).not.toThrow();
  });
});

describe('PermissionKeysOf — the union `defineOperations` wants', () => {
  it('is the literal union, not `string` and not the brand', () => {
    const permissions = definePermissions({
      modules: MODULES,
      roles: ROLES,
      keys: ['a:read', 'a:write'] as const,
    });
    exact<Exact<PermissionKeysOf<typeof permissions>, 'a:read' | 'a:write'>>(true);
    expect(permissions.keys).toEqual(['a:read', 'a:write']);
  });

  /**
   * Omission is `never`, deliberately. `string` would let `defineOperations` accept any
   * `permission:` at all — the check silently gone rather than loudly missing.
   */
  it('is `never` when the surface declared no keys', () => {
    const permissions = definePermissions({ modules: MODULES, roles: ROLES });
    exact<Exact<PermissionKeysOf<typeof permissions>, never>>(true);
    // Not merely `undefined`: `const T` keeps the property off the type entirely, which is
    // why reading `permissions.keys` here would be a compile error rather than a `null` check.
    expect('keys' in permissions).toBe(false);
  });

  /**
   * The likelier mistake than omission: `keys` written without `as const`. Its element type is
   * `string` already, so passing it through would be the same silent widening by another road —
   * the runtime check still fires, but `defineOperations` would stop rejecting anything.
   */
  it('is `never` when the array was written without `as const`', () => {
    const widened: string[] = ['a:read', 'a:write'];
    const permissions = definePermissions({ modules: MODULES, roles: ROLES, keys: widened });
    exact<Exact<PermissionKeysOf<typeof permissions>, never>>(true);
    // The runtime half is unaffected — a drifted list still throws, `as const` or not.
    expect(() => definePermissions({ modules: MODULES, roles: ROLES, keys: ['a:read'] })).toThrow();
  });
});
