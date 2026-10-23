import { describe, expect, it } from 'vitest';
import { provisionTenantPayload } from '../src/platform-request.js';

/** The tenant-provisioner payload names its first scope's vertical in the registry's grammar. */
describe('provisionTenantPayload.instance.vertical', () => {
  const payload = (vertical: unknown) => ({
    tenant: { id: 't', slug: 'acme', name: 'Acme' },
    instance: { vertical, scopeId: 's', slug: 'main', name: 'Main', owner: 'p' },
    entitlements: [],
  });

  it.each(['', '   ', 'Crm', 'a/b/c', 'crm/'])('refuses %j', (vertical) => {
    const r = provisionTenantPayload.safeParse(payload(vertical));
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toContain('instance.vertical');
  });

  it.each(['crm', 'ticket0', 'acme/crm'])('accepts %j', (vertical) => {
    expect(provisionTenantPayload.parse(payload(vertical)).instance.vertical).toBe(vertical);
  });
});
