import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalScopeStoreEnvelope,
  issueScopeStoreEnvelope,
  parseScopeStoreEnvelope,
  scopeStoreBodyDigest,
  scopeStoreEnvelopeFresh,
  verifyScopeStoreEnvelope,
} from '../src/scope-store-envelope.js';

const vector = JSON.parse(readFileSync(new URL('./vectors/scope-store-envelope.json', import.meta.url), 'utf8')) as {
  privateKeyPkcs8: string;
  publicKey: string;
  body: string;
  canonical: string;
  signature: string;
  header: string;
  staleCanonical: string;
  staleSignature: string;
  windowSeconds: number;
};

describe('scope store envelope (#2287)', () => {
  it('reproduces the shared vector, which is what another language verifies against', async () => {
    const issued = await issueScopeStoreEnvelope({
      privateKey: vector.privateKeyPkcs8,
      aud: 'caller',
      name: 'tenant/vertical/scope/graph',
      op: 'substrat.size',
      body: vector.body,
      iat: 1_700_000_000,
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(issued.canonical).toBe(vector.canonical);
    expect(issued.signature).toBe(vector.signature);
    expect(issued.header).toBe(vector.header);
    expect(await verifyScopeStoreEnvelope(vector.publicKey, vector.canonical, vector.signature)).toBe(true);
    expect(await verifyScopeStoreEnvelope(vector.publicKey, vector.staleCanonical, vector.staleSignature)).toBe(true);
  });

  it('refuses a signature over different bytes, a bad key, and a field the encoding could split', async () => {
    expect(await verifyScopeStoreEnvelope(vector.publicKey, vector.canonical, vector.staleSignature)).toBe(false);
    expect(await verifyScopeStoreEnvelope(vector.publicKey, vector.canonical, 'not-a-signature')).toBe(false);
    expect(await verifyScopeStoreEnvelope('not-a-key', vector.canonical, vector.signature)).toBe(false);
    expect(() =>
      canonicalScopeStoreEnvelope({
        v: 1,
        aud: 'caller',
        name: 'a\nb',
        op: 'read',
        digest: 'a'.repeat(64),
        iat: 1,
        nonce: 'n',
      }),
    ).toThrow(/newline/);
  });

  it('parses the seven lines back, and a stale issue time is outside the window', async () => {
    expect(parseScopeStoreEnvelope(vector.canonical)).toMatchObject({
      v: 1,
      aud: 'caller',
      name: 'tenant/vertical/scope/graph',
      op: 'substrat.size',
      iat: 1_700_000_000,
    });
    expect(parseScopeStoreEnvelope('nope')).toBeUndefined();
    expect((await scopeStoreBodyDigest(vector.body))).toBe(vector.canonical.split('\n')[4]);
    expect(scopeStoreEnvelopeFresh(1_700_000_000, 1_700_000_000 + vector.windowSeconds)).toBe(true);
    expect(scopeStoreEnvelopeFresh(1_700_000_000, 1_700_000_000 + vector.windowSeconds + 1)).toBe(false);
    const stale = parseScopeStoreEnvelope(vector.staleCanonical);
    expect(scopeStoreEnvelopeFresh(stale?.iat ?? 0, 1_700_000_000, vector.windowSeconds)).toBe(false);
  });
});
