import { describe, expect, it } from 'vitest';
import { connectionCertificate } from '../src/index.js';

/**
 * The public certificate a connection signs in with (#2100), and the successor a rotation adds.
 * `next` is additive: the shape a plane served before rotation still parses, the top-level fields
 * keep describing the certificate in use, and a `next` that is there survives the parse, which the
 * control plane's route runs on the way out (a parse that dropped it would hide the rotation).
 */
describe('connectionCertificate', () => {
  const current = {
    pem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
    thumbprint: 'ABCDEF',
    notAfter: '2027-10-07T12:00:00.000Z',
  };
  const next = { ...current, thumbprint: '123456', notAfter: '2028-09-07T12:00:00.000Z' };

  it('parses the shape served before rotation existed, with no next', () => {
    expect(connectionCertificate.parse(current)).toEqual(current);
  });

  it('keeps a successor through the parse', () => {
    expect(connectionCertificate.parse({ ...current, next })).toEqual({ ...current, next });
  });

  it('refuses a successor missing its certificate or with an end that is not an instant', () => {
    expect(connectionCertificate.safeParse({ ...current, next: { ...next, pem: '' } }).success).toBe(false);
    expect(connectionCertificate.safeParse({ ...current, next: { ...next, notAfter: 'soon' } }).success).toBe(false);
  });
});
