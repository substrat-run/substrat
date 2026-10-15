import { describe, expect, it } from 'vitest';
import { isExpiredSignIn, restartUrl, signInDeadline } from '../app/src/auth/sign-in-window.js';

const MINUTE = 60_000;
const WINDOW_S = 30 * 60;
/** The issuer's clock when it signed the query. */
const ISSUED = Date.UTC(2026, 9, 14, 12, 0, 0, 123);

/** A signed query exactly as `signParams` stamps it: `exp` in seconds, `ba_iat` in ms. */
function signedQuery(issuedAt = ISSUED, windowS = WINDOW_S): string {
  return new URLSearchParams({
    client_id: 'client-a', response_type: 'code', redirect_uri: 'https://app.example.test/cb', state: 's',
    exp: String(Math.floor(issuedAt / 1000) + windowS), ba_iat: String(issuedAt),
    ba_param: 'client_id', ba_pl: 'x', sig: 'signature',
  }).toString();
}

/** The page loads on a device whose clock is `skew` ms off the issuer's; is the sign-in over
 *  after `elapsed` ms by that same device clock? */
function expiredAfter(skew: number, elapsed: number): boolean {
  const loadedAt = ISSUED + skew;
  const deadline = signInDeadline(signedQuery(), loadedAt);
  expect(deadline).not.toBeNull();
  return loadedAt + elapsed >= deadline!;
}

describe('the SMS step judges the sign-in window without the device clock', () => {
  it.each([
    ['in step with the issuer', 0],
    ['40 minutes fast', 40 * MINUTE],
    ['40 minutes slow', -40 * MINUTE],
    ['a day fast', 24 * 60 * MINUTE],
  ])('on a device %s, a fresh sign-in is open and closes after the issued window', (_, skew) => {
    expect(expiredAfter(skew, 0)).toBe(false);
    expect(expiredAfter(skew, 29 * MINUTE)).toBe(false);
    expect(expiredAfter(skew, 30 * MINUTE + 1)).toBe(true);
  });

  it('reads the window in the units the issuer writes (exp seconds, ba_iat milliseconds)', () => {
    // `exp` is floored to the second, so the window is at most a second short of the full one.
    const window = signInDeadline(signedQuery(), 0)!;
    expect(window).toBeLessThanOrEqual(WINDOW_S * 1000);
    expect(window).toBeGreaterThan(WINDOW_S * 1000 - 1000);
  });

  it('a query already past its window is expired at load', () => {
    expect(signInDeadline(signedQuery(ISSUED, 0), ISSUED)!).toBeLessThanOrEqual(ISSUED);
  });

  it('decides nothing without a signed query, or with one it cannot read', () => {
    expect(signInDeadline(null, ISSUED)).toBeNull();
    const params = new URLSearchParams(signedQuery());
    params.delete('ba_iat');
    // Without the issue time only `exp` against the device clock would remain — the very
    // comparison this exists to avoid — so the screen leaves the decision to the server.
    expect(signInDeadline(params.toString(), ISSUED)).toBeNull();
    params.set('ba_iat', 'soon');
    expect(signInDeadline(params.toString(), ISSUED)).toBeNull();
  });

  it('recognises the issuer refusing the query, and nothing else', () => {
    expect(isExpiredSignIn('invalid_signature')).toBe(true);
    expect(isExpiredSignIn('Wait a minute before requesting another code')).toBe(false);
  });

  it('starts again at the same-origin authorize path, with the signature material removed', () => {
    const url = restartUrl(signedQuery());
    expect(url.startsWith('/api/auth/oauth2/authorize?')).toBe(true);
    const params = new URL(url, 'https://issuer.example.test').searchParams;
    for (const key of ['sig', 'exp', 'ba_iat', 'ba_param', 'ba_pl']) expect(params.has(key)).toBe(false);
    expect(params.get('client_id')).toBe('client-a');
    expect(params.get('redirect_uri')).toBe('https://app.example.test/cb');
  });
});
