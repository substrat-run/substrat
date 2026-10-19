/**
 * #2430: a key reserved to a system principal (`holder: 'system'` on its declaration) is carried on
 * the registry row and refused in a person's role or grant shape where the registry is built and
 * where a push carries it. A registry that reserves nothing is the registry it was.
 */
import { describe, expect, it } from 'vitest';
import { buildPermissionRegistry, pushedPermissionRegistry, type PermissionsInput } from '../src/deploy.js';
import { permissionKey } from '../src/ids.js';
import { moduleManifest } from '../src/manifest.js';
import { reservedKeyOffences, reservedKeysOf } from '../src/reserved-keys.js';

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
      "role member → assistant:run: declared `holder: 'system'` by @acme/engine-assistant (drive a run)",
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

describe('the rule itself', () => {
  it('reads a Set as well as the map reservedKeysOf returns', () => {
    const surface = { roles: [role('member', ['assistant:run'])], grants: [] };
    expect(reservedKeyOffences(surface, new Set(['assistant:run']))).toEqual(reservedKeyOffences(surface, reservedKeysOf([engine])));
  });
});
