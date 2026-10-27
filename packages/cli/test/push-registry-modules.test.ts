import { describe, expect, it } from 'vitest';
import { built, pushed, vertical } from './push-harness.js';

describe.runIf(built)('push carries its loaded module permission declarations (#2446)', () => {
  it('ships each module beside the registry derived from it', () => {
    const manifest = pushed(vertical([
      { id: '@acme/engine-work', reserved: true },
      { id: 'helpdesk', ownerGrants: ['helpdesk:read'] },
    ]));
    expect(manifest.modules).toEqual([
      { id: '@acme/engine-work', permissions: [{ key: 'engine-work:read', description: 'Read', holder: 'system' }] },
      { id: 'helpdesk', permissions: [{ key: 'helpdesk:read', description: 'Read' }], ownerGrants: ['helpdesk:read'] },
    ]);
    expect(manifest.registry.permissions.map(({ key, declaredBy }) => ({ key, declaredBy }))).toEqual([
      { key: 'engine-work:read', declaredBy: ['@acme/engine-work'] },
      { key: 'helpdesk:read', declaredBy: ['helpdesk'] },
    ]);
  });
});

describe.runIf(built)("push carries a vertical's connectors (vertical-connectors.md §7.1)", () => {
  const DECL = {
    provider: 'acme.docbox',
    label: 'docbox',
    description: 'A document box.',
    fields: [{ key: 'password', label: 'Password', secret: true }],
    grants: ['helpdesk:read'],
    events: [],
    sweeps: true,
    binds: false,
    dispatches: false,
  };

  it('sends the declarations, and their standing grants in the registry the digest covers', () => {
    const without = pushed(vertical([{ id: 'helpdesk' }]));
    expect(without).not.toHaveProperty('connectors');
    expect(without.registry).not.toHaveProperty('connectors');
    const manifest = pushed(vertical([{ id: 'helpdesk' }], undefined, { connectors: [DECL] }));
    expect(manifest.connectors).toEqual([DECL]);
    expect(manifest.registry.connectors).toEqual([{ provider: 'acme.docbox', grants: ['helpdesk:read'] }]);
    expect(manifest.digests.permission).not.toBe(without.digests.permission);
  });
});
