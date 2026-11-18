import { describe, expect, it } from 'vitest';
import { PROVIDERS, parseProviderSecret } from '../src/integrations.js';

/**
 * #2100: a door may declare an optional field — Microsoft 365's client secret, left empty when
 * the platform generates a certificate instead. Optional means "may be absent", not "may be
 * anything": a required field is still refused when empty, and an empty optional is left out
 * rather than stored as ''.
 */
describe('parseProviderSecret with an optional field (#2100)', () => {
  const m365 = PROVIDERS.microsoft365!;
  const filled = {
    tenantId: 't',
    clientId: 'c',
    senders: 'noreply@acme.example',
    siteUrl: 'https://acme.sharepoint.com/sites/Team',
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

  it("a toggle is stored as 'yes' when ticked and left out otherwise, never as typed", () => {
    expect(parseProviderSecret(m365, { ...filled, rotateCertificate: 'yes' }).rotateCertificate).toBe('yes');
    for (const v of ['', 'no', 'true', ' yes', 1, true]) {
      expect(parseProviderSecret(m365, { ...filled, rotateCertificate: v })).toEqual(filled);
    }
    // A toggle is never required.
    expect(parseProviderSecret(m365, filled)).toEqual(filled);
  });

  it('a choice is one of its values or left out; a field its choice hides is dropped (#3281)', () => {
    const own = { ...filled, signInWith: 'own-certificate', ownPrivateKey: 'KEY', ownCertificate: 'CERT' };
    expect(parseProviderSecret(m365, { ...own, clientSecret: 'S', rotateCertificate: 'yes' })).toEqual(own);
    expect(parseProviderSecret(m365, { ...filled, signInWith: 'certificate', ownPrivateKey: 'KEY', rotateCertificate: 'yes' })).toEqual({
      ...filled,
      signInWith: 'certificate',
      rotateCertificate: 'yes',
    });
    // Left out ("keep how it signs in now"), the client secret and the rotate flag are what they were before the choice.
    expect(parseProviderSecret(m365, { ...filled, clientSecret: 'S', ownPrivateKey: 'KEY' })).toEqual({ ...filled, clientSecret: 'S' });
    for (const v of ['password', '', 1]) expect(parseProviderSecret(m365, { ...filled, signInWith: v, ownPrivateKey: 'KEY' })).toEqual(filled);
  });

  it('a client secret is required only when it is the chosen method (#3281)', () => {
    expect(() => parseProviderSecret(m365, { ...filled, signInWith: 'client-secret' })).toThrow(/clientSecret/);
    expect(parseProviderSecret(m365, { ...filled, signInWith: 'client-secret', clientSecret: 'S' }).clientSecret).toBe('S');
  });

  it('the door says the connection sends mail and carries a certificate', () => {
    expect(m365).toMatchObject({ sendsMail: true, certificate: true, grants: [] });
  });
});
