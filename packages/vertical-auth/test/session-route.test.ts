import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import type { OwnerSeat } from '../src/owner-seat.js';
import type { AuthSubject } from '../src/provider.js';
import { mountSession, type ResolvedCaller, type SessionRouteDeps } from '../src/session-route.js';

/**
 * The session route's own branches, over stand-ins. The place report itself is `observePlace`'s
 * (`places.test.ts`), and each deployed vertical holds it end to end on workerd
 * (`demos/*\/test/workerd/places.test.ts`); this holds WHEN the route asks for one.
 */

const NODE = { tenantId: tenantId.parse('01J00000000000000000000TEN'), scopeId: scopeId.parse('01J00000000000000000000SCP') };
const ADA = principalId.parse('01J00000000000000000000ADA');
const SUBJECT: AuthSubject = { sub: 'sub-ada', email: 'ada@example.com', name: 'Ada Lovelace' };
const seat = (state: OwnerSeat['state'], open = false): OwnerSeat => ({
  state,
  owner: null,
  firstSignIn: state === 'unclaimed' ? { open, until: null } : null,
  claimLink: null,
});

function harness(caller: Partial<ResolvedCaller<typeof NODE>>, opts: { seat?: OwnerSeat; extra?: SessionRouteDeps<object, typeof NODE>['extra'] } = {}) {
  const asked: string[] = [];
  const app = new Hono<{ Bindings: object }>();
  mountSession(app, {
    caller: async () => ({ node: NODE, subject: null, principal: null, identity: null, ...caller }),
    directory: () => ({
      ownerSeat: async () => {
        asked.push('seat');
        return opts.seat ?? seat('claimed');
      },
    }),
    ...(opts.extra ? { extra: opts.extra } : {}),
  });
  app.onError((err, c) => (err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500)));
  const get = () =>
    app.request('/api/me', {}, {}, { waitUntil: () => asked.push('place'), passThroughOnException: () => {}, props: {} });
  return { asked, get };
}

describe('mountSession', () => {
  it('signed in: the standard fields, the vertical\'s beside them, and a place report', async () => {
    const { asked, get } = harness(
      { subject: SUBJECT, principal: ADA },
      { extra: async (_c, { principal }) => ({ role: 'admin', principal: `not-${principal}` }) },
    );
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: 'admin', principal: ADA, display: 'Ada Lovelace', email: 'ada@example.com' });
    expect(asked).toEqual(['place']);
  });

  it.each([
    [{ name: null, email: 'ada@example.com' }, { display: 'ada@example.com', email: 'ada@example.com' }],
    [{ name: '', email: null }, { display: 'You' }],
  ])('display falls back from name to email to "You" (%o)', async (claims, shown) => {
    const { get } = harness({ subject: { sub: 'sub-ada', ...claims }, principal: ADA });
    expect(await (await get()).json()).toEqual({ principal: ADA, ...shown });
  });

  it.each([
    ['an unclaimed seat is needs-setup', seat('unclaimed', true), 200, { status: 'needs-setup', firstSignInOpen: true }],
    ['a claimed seat is 401', seat('claimed'), 401, { error: 'unauthorized' }],
    ['a scope this directory never provisioned is 401', seat('unknown'), 401, { error: 'unauthorized' }],
  ])('nobody bound: %s', async (_name, s, status, body) => {
    const { asked, get } = harness({ subject: SUBJECT }, { seat: s });
    const res = await get();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    // An unbound login is reported too: absent, so the pool stops listing this place.
    expect(asked).toEqual(['place', 'seat']);
  });

  it('reports no place for a signed-out request, or for a resolve the vertical says is not one', async () => {
    const signedOut = harness({});
    await signedOut.get();
    expect(signedOut.asked).toEqual(['seat']);
    const notAPlace = harness({ subject: SUBJECT, principal: ADA, place: false });
    await notAPlace.get();
    expect(notAPlace.asked).toEqual([]);
  });
});
