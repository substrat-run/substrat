/**
 * The declared key list reaches `definePermissions` as `keys` (#1208).
 *
 * Its runtime half needs no test of its own: `definePermissions` throws at module load
 * when `keys` and `MODULES` disagree, so every suite in this package that imports
 * `provision.ts` is already the check. What nothing else would notice is `keys` being
 * dropped, or the `as const` being lost — the assertion just stops running, and the union
 * `defineOperations` type-checks a `permission:` against silently becomes `never`. Both
 * mistakes are a compile error on the line below.
 *
 * Manyfold has no `provision.test.ts` of its own, which is the only reason this lives in
 * a file rather than beside the provisioning seam the other five demos put it in.
 */
import { describe, expect, it } from 'vitest';
import { type PermissionKeysOf } from '@substrat-run/contracts';
import { MANYFOLD_PERMISSIONS } from '../src/operations.js';
import { permissions } from '../src/provision.js';

describe("Manyfold's declared permission keys", () => {
  it('survive as a literal union rather than collapsing to `never`', () => {
    const key: PermissionKeysOf<typeof permissions> = 'content:manage-sites';
    expect(MANYFOLD_PERMISSIONS).toContain(key);
  });
});
