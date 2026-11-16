import { substratError } from '@substrat-run/contracts';
import { describe, expect, it } from 'vitest';
import { landingRefusalSaid } from '../src/landing-refusal.js';

/** The hosted hop's error, as the control-plane client throws it: a status and the raw body. */
const hosted = (status: number, body: unknown) =>
  Object.assign(new Error(`vertical refused connector-invoke (${status}): ${JSON.stringify(body)}`), {
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('landingRefusalSaid (#3235)', () => {
  it("reads the vertical's own refusal over the hosted hop: its code and its detail, on one line", () => {
    const err = hosted(409, { type: 'https://substrat.net/errors/conflict', code: 'conflict', status: 409, detail: 'UNIQUE constraint failed:\n  products.sku', requestId: 'r1' });
    expect(landingRefusalSaid('shop/land-change', err)).toBe("the app's 'shop/land-change' refused it (conflict): UNIQUE constraint failed: products.sku");
  });

  it("reads an uncoded throw the vertical's surface answered as the caller's 400", () => {
    const err = hosted(400, { type: 'about:blank', status: 400, title: 'Bad Request', detail: 'UNIQUE constraint failed: products.sku' });
    expect(landingRefusalSaid('shop/land-change', err)).toBe("the app's 'shop/land-change' refused it: UNIQUE constraint failed: products.sku");
  });

  it('reads a coded refusal in process', () => {
    expect(landingRefusalSaid('shop/land-change', substratError('validation_failed', 'price must be a decimal'))).toBe(
      "the app's 'shop/land-change' refused it (validation_failed): price must be a decimal",
    );
  });

  it('cuts a long detail to a line', () => {
    const said = landingRefusalSaid('op', hosted(400, { detail: 'x'.repeat(1000) }))!;
    expect(said.length).toBeLessThan(220);
    expect(said.endsWith('…')).toBe(true);
  });

  it.each([
    ['a platform fault (502)', hosted(502, { status: 502, detail: 'internal error; reference = 0123abcd' })],
    ['a 5xx code on a 4xx line', hosted(409, { code: 'internal', detail: 'stack at host.ts:12' })],
    ["the platform's credential check (401)", hosted(401, { code: 'unauthenticated', detail: 'platform secret header mismatch' })],
    ['an unauthenticated code on another status', hosted(400, { code: 'unauthenticated', detail: 'platform secret header mismatch' })],
    ["a router's plain-text miss", hosted(404, '404 Not Found')],
    ['a body that is not an object', hosted(400, '"just a string"')],
    ['an uncoded in-process throw', new Error('UNIQUE constraint failed: _substrat_outbox.id')],
    ['an in-process 5xx code', substratError('unavailable', 'scope DO overloaded')],
    ['a non-error', 'boom'],
  ])('withholds %s', (_, err) => {
    expect(landingRefusalSaid('op', err)).toBeUndefined();
  });
});
