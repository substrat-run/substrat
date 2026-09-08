import { describe, expect, it } from 'vitest';
import {
  signConnectState,
  verifyConnectState,
  ConnectStateError,
  type ConnectStateClaim,
} from '../src/connect-state.js';

const SECRET = 'platform-secret-value-32-bytes-min';
const claim = (over: Partial<ConnectStateClaim> = {}): ConnectStateClaim => ({
  tenantId: '01J000000000000000000TEN',
  scopeId: '01J000000000000000000SCO',
  vertical: 'bureau-books',
  provider: 'fortnox',
  principal: '01J000000000000000000PRI',
  exp: Date.now() + 60_000,
  ...over,
});

describe('connect state — the signed half of a platform-minted consent round', () => {
  it('round-trips every field, optional ones included', async () => {
    const c = claim({ returnUrl: 'https://books.example.com/clients/42', subjectRef: 'client-42' });
    const back = await verifyConnectState(SECRET, await signConnectState(SECRET, c), Date.now());
    expect(back).toEqual(c);
  });

  it('refuses to mint under an unset secret rather than signing with the empty string', async () => {
    await expect(signConnectState('', claim())).rejects.toBeInstanceOf(ConnectStateError);
  });

  it('verifies nothing when this deployment holds no platform secret', async () => {
    const token = await signConnectState(SECRET, claim());
    expect(await verifyConnectState(undefined, token, Date.now())).toBeNull();
    expect(await verifyConnectState('', token, Date.now())).toBeNull();
  });

  it('rejects a token minted under a different platform secret', async () => {
    const token = await signConnectState(SECRET, claim());
    expect(await verifyConnectState('a-different-platform-secret-value', token, Date.now())).toBeNull();
  });

  // The point of HKDF-per-purpose: the platform secret is also compared RAW at
  // /internal/provision and the two relays. A MAC keyed on the raw secret would put every
  // one of those in the same signature family as this.
  it('rejects a signature made with the raw secret as the HMAC key', async () => {
    const c = claim();
    const enc = new TextEncoder();
    const body = Buffer.from(JSON.stringify(c)).toString('base64url');
    const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
    const forged = `${body}.${Buffer.from(sig).toString('base64url')}`;
    expect(await verifyConnectState(SECRET, forged, Date.now())).toBeNull();
  });

  it('rejects a tampered payload — the claim is what is signed, not just its shape', async () => {
    const token = await signConnectState(SECRET, claim());
    const [, sig] = token.split('.');
    const swapped = Buffer.from(JSON.stringify(claim({ scopeId: '01J00000000000000000OTHR' }))).toString('base64url');
    expect(await verifyConnectState(SECRET, `${swapped}.${sig}`, Date.now())).toBeNull();
  });

  it('rejects an expired round', async () => {
    const token = await signConnectState(SECRET, claim({ exp: Date.now() + 1000 }));
    expect(await verifyConnectState(SECRET, token, Date.now() + 2000)).toBeNull();
  });

  it.each(['', 'not-a-token', 'a.b.c', 'onlyonepart', '.', 'x.'])('rejects the malformed token %j', async (token) => {
    expect(await verifyConnectState(SECRET, token, Date.now())).toBeNull();
  });

  // A valid signature proves the platform minted it, not that the shape is whole. A claim
  // missing `scopeId` would reach the connection store as `undefined` — which is how a
  // credential lands under the wrong key rather than failing outright.
  it('rejects a validly-signed claim that is missing a required field', async () => {
    const enc = new TextEncoder();
    const partial = { tenantId: 't', vertical: 'v', provider: 'fortnox', principal: 'p', exp: Date.now() + 60_000 };
    const body = Buffer.from(JSON.stringify(partial)).toString('base64url');
    // Sign it the way the module does, so ONLY the missing field can be what refuses it.
    const ikm = await crypto.subtle.importKey('raw', enc.encode(SECRET), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('substrat-platform'), info: enc.encode('substrat-platform:connect-state:v1') },
      ikm,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
    const token = `${body}.${Buffer.from(sig).toString('base64url')}`;
    expect(await verifyConnectState(SECRET, token, Date.now())).toBeNull();
  });
});
