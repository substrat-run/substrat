import { describe, expect, it } from 'vitest';
import { scopeText } from '../src/ids.js';
import { provisionSiblingPayload, provisionTenantPayload } from '../src/platform-request.js';

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

/** `scopeText`: one rule for a scope's kind or name, wherever provisioning takes one. */
describe('scopeText, and the provisioning payloads that name a scope', () => {
  it.each(['', '   ', '\t', '\n'])('refuses %j', (value) => {
    expect(scopeText.safeParse(value).success).toBe(false);
  });

  it.each(['Main', ' Main ', 'x'])('accepts %j as given, untrimmed', (value) => {
    expect(scopeText.parse(value)).toBe(value);
  });

  it.each(['   ', ''])('refuses a provision-tenant instance name %j', (name) => {
    const r = provisionTenantPayload.safeParse({
      tenant: { id: 't', slug: 'acme', name: 'Acme' },
      instance: { vertical: 'crm', scopeId: 's', slug: 'main', name, owner: 'p' },
      entitlements: [],
    });
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['instance.name']);
  });

  it.each(['   ', ''])('refuses a provision-sibling name %j', (name) => {
    const r = provisionSiblingPayload.safeParse({ slug: 'courts', name, owner: 'p' });
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['name']);
  });

  it('accepts a sibling with a name', () => {
    expect(provisionSiblingPayload.parse({ slug: 'courts', name: 'Courts', owner: 'p' }).name).toBe('Courts');
  });
});
