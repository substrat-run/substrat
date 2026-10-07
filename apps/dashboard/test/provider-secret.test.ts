import { describe, expect, it } from 'vitest';
import { PROVIDERS, parseProviderSecret } from '../src/integrations.js';

/**
 * #2100: a door may declare an optional field — Microsoft 365's client secret, left empty when
 * the platform generates a certificate instead. Optional means "may be absent", not "may be
 * anything": a required field is still refused when empty, and an empty optional is left out
 * rather than stored as ''.
 */
describe('parseProviderSecret with an optional field (#2100)', () => {
  const m365 = PROVIDERS['microsoft365-mail']!;
  const filled = {
    tenantId: 't',
    clientId: 'c',
    senders: 'noreply@acme.example',
  };

  it('accepts the credential without the optional field, and leaves it out', () => {
    expect(parseProviderSecret(m365, { ...filled, clientSecret: '  ' })).toEqual(filled);
  });

  it('keeps the optional field when it is given', () => {
    expect(parseProviderSecret(m365, { ...filled, clientSecret: 'S' }).clientSecret).toBe('S');
  });

  it('still refuses a missing required field', () => {
    expect(() => parseProviderSecret(m365, { ...filled, senders: '' })).toThrow(/senders/);
  });

  it('the door says the connection sends mail and carries a certificate', () => {
    expect(m365).toMatchObject({ sendsMail: true, certificate: true, grants: [] });
  });
});
