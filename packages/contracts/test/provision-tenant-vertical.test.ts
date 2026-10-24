import { describe, expect, it } from 'vitest';
import { scopeText } from '../src/ids.js';
import { provisionSiblingPayload, provisionTenantPayload } from '../src/platform-request.js';

/** A principal id, as both payloads now require of their owner. */
const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** The tenant-provisioner payload names its first scope's vertical in the registry's grammar. */
describe('provisionTenantPayload.instance.vertical', () => {
  const payload = (vertical: unknown) => ({
    tenant: { id: 't', slug: 'acme', name: 'Acme' },
    instance: { vertical, scopeId: 's', slug: 'main', name: 'Main', owner: OWNER },
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
      instance: { vertical: 'crm', scopeId: 's', slug: 'main', name, owner: OWNER },
      entitlements: [],
    });
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['instance.name']);
  });

  it.each(['   ', ''])('refuses a provision-sibling name %j', (name) => {
    const r = provisionSiblingPayload.safeParse({ slug: 'courts', name, owner: OWNER });
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['name']);
  });

  it('accepts a sibling with a name', () => {
    expect(provisionSiblingPayload.parse({ slug: 'courts', name: 'Courts', owner: OWNER }).name).toBe('Courts');
  });
});

/** Both provisioning payloads name their owner as a principal id, the id provisioning seats. */
describe('the provisioning payloads name a principal as owner', () => {
  it.each(['not-a-principal', '', 'p'])('refuses a provision-tenant owner %j', (owner) => {
    const r = provisionTenantPayload.safeParse({
      tenant: { id: 't', slug: 'acme', name: 'Acme' },
      instance: { vertical: 'crm', scopeId: 's', slug: 'main', name: 'Main', owner },
      entitlements: [],
    });
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['instance.owner']);
  });

  it.each(['not-a-principal', '', 'p'])('refuses a provision-sibling owner %j', (owner) => {
    const r = provisionSiblingPayload.safeParse({ slug: 'courts', name: 'Courts', owner });
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['owner']);
  });

  it('accepts a principal id as owner in both', () => {
    expect(provisionSiblingPayload.parse({ slug: 'courts', name: 'Courts', owner: OWNER }).owner).toBe(OWNER);
  });
});
