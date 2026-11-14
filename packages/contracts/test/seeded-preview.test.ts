import { describe, expect, it } from 'vitest';
import { isPersonaIssuer, personaIssuerUrl } from '../src/seeded-preview.js';

/**
 * #3145: a deployment whose issuer this names sets its cookies for the studio's cross-site frame
 * (`SameSite=None; Partitioned`), so only a persona issuer's exact URL may match — never a
 * production issuer that happens to have a `/persona/…` path.
 */
describe('isPersonaIssuer (#3145)', () => {
  const scope = '01JZ0000000000000000000ABC';
  it.each([
    [personaIssuerUrl('https://console.substrat.net', scope), true],
    [`${personaIssuerUrl('https://console.substrat.net', scope)}/`, true],
    ['https://auth.acme.test/persona/login', false],
    [`https://auth.acme.test/persona/${scope}/extra`, false],
    [`https://auth.acme.test/tenants/persona/${scope}`, false],
    ['https://auth.acme.test', false],
    ['not a url', false],
  ])('%s → %s', (issuer, expected) => {
    expect(isPersonaIssuer(issuer)).toBe(expected);
  });
});
