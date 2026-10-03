import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIST_PAGE_MAX, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ControlPlaneError as SharedControlPlaneError } from '@substrat-run/control-plane-client';
import { ulid } from '@substrat-run/kernel';
import { TenantNarrowedControlPlane, ControlPlaneError } from '../src/authority.js';

/**
 * What `TenantNarrowedControlPlane` puts on the wire and how it reads what comes back,
 * pinned per method family (#971) — the evidence that moving its transport onto the shared
 * `@substrat-run/control-plane-client` changed nothing a caller can see. Written against
 * `fetch` and the public methods only, so it reads the same against the hand-rolled
 * transport it replaced.
 *
 * The one deliberate difference is the header set: the seam now sends exactly ONE
 * credential, the tenant token, and no `x-platform-actor` beside it. The plane reads the
 * tenant token first and never consults the actor header when one is presented, and the
 * shared client refuses a request carrying both.
 */

const T = tenantId.parse(ulid());
const S = scopeId.parse(ulid());
const P = principalId.parse(ulid());
const TOKEN = 'stt1.tenant-token';
const BASE = 'https://cp/api';

/** Every request on this seam carries exactly these headers, and nothing else. */
const WIRE_HEADERS = {
  'content-type': 'application/json',
  'x-service-token': TOKEN,
  'x-substrat-tenant': T,
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Answer = Response | Error | (() => Response);

/** A plane that answers from a script, one entry per request (the last one repeats). */
function plane(answers: Answer[] = [Response.json({})], credential?: ConstructorParameters<typeof TenantNarrowedControlPlane>[0]['credential']) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body === undefined || init.body === null ? undefined : String(init.body),
    });
    const a = answers[Math.min(sent.length - 1, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a() : a.clone();
  }) as typeof globalThis.fetch;
  const cp = new TenantNarrowedControlPlane({ baseUrl: BASE, credential: credential ?? TOKEN, tenantId: T, fetch });
  return { cp, sent };
}

const json = (body: unknown, status = 200, statusText = '') =>
  new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } });

describe('TenantNarrowedControlPlane on the wire (#971)', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('requests: URL, verb, headers and body per method family', () => {
    const cases: Array<{
      name: string;
      run: (cp: TenantNarrowedControlPlane) => Promise<unknown>;
      method: string;
      path: string;
      body?: unknown;
    }> = [
      { name: 'idempotent create (POST)', run: (cp) => cp.ensureTenant('acme', 'Acme'), method: 'POST', path: '/tenants', body: { id: T, slug: 'acme', name: 'Acme' } },
      { name: 'idempotent PUT, no body, key encoded', run: (cp) => cp.grantEntitlement('acme/crm'), method: 'PUT', path: `/tenants/${T}/entitlements/acme%2Fcrm` },
      {
        name: 'plain POST',
        run: (cp) => cp.provisionScope({ scopeId: S, slug: 'hr', name: 'HR', vertical: 'callout', jurisdiction: 'global' }),
        method: 'POST',
        path: '/scopes',
        body: { tenantId: T, scopeId: S, slug: 'hr', name: 'HR', vertical: 'callout', jurisdiction: 'global' },
      },
      { name: 'bodyless POST', run: (cp) => cp.verifyHostname('a.example.com'), method: 'POST', path: '/hostnames/a.example.com/verify' },
      {
        name: 'idempotent PUT with a body',
        run: (cp) => cp.linkIdentity({ provider: 'p', externalId: 'sub-1', principal: P }),
        method: 'PUT',
        path: `/tenants/${T}/identities`,
        body: { provider: 'p', externalId: 'sub-1', principal: P },
      },
      {
        name: 'idempotent DELETE with a body',
        run: (cp) => cp.unassignRole({ principalId: P, roleKey: 'admin' }),
        method: 'DELETE',
        path: `/tenants/${T}/role-assignments`,
        body: { principalId: P, roleKey: 'admin' },
      },
      { name: 'idempotent DELETE, no body', run: (cp) => cp.unlinkIdentity(P), method: 'DELETE', path: `/tenants/${T}/identities/${P}` },
      { name: 'PATCH', run: (cp) => cp.setHostnameStatus('a.example.com', 'active'), method: 'PATCH', path: '/hostnames/a.example.com/status', body: { status: 'active' } },
      { name: 'GET', run: (cp) => cp.listOrgs(), method: 'GET', path: `/tenants/${T}/orgs` },
      {
        name: 'GET with a query',
        run: (cp) => cp.connectionActivity('c/1', { live: true, source: 'ledger' as never }),
        method: 'GET',
        path: `/tenants/${T}/connections/c%2F1/activity?live=1&source=ledger`,
      },
      {
        name: 'one page, the page params appended to an existing query',
        run: (cp) => cp.listTenantHostnamesPage({ limit: 5, cursor: 'c1', order: 'desc' }),
        method: 'GET',
        path: `/hostnames?tenantId=${T}&limit=5&cursor=c1&order=desc`,
      },
      { name: 'one page, no page params', run: (cp) => cp.listTenantHostnamesPage({}), method: 'GET', path: `/hostnames?tenantId=${T}` },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const { cp, sent } = plane();
        await c.run(cp);
        expect(sent).toHaveLength(1);
        const [req] = sent;
        expect(req!.url).toBe(`${BASE}${c.path}`);
        expect(req!.method).toBe(c.method);
        expect(req!.headers).toEqual(WIRE_HEADERS);
        if (c.body === undefined) expect(req!.body).toBeUndefined();
        else expect(JSON.parse(req!.body!)).toEqual(c.body);
      });
    }

    it('a trailing slash on the base URL is not doubled', async () => {
      const sent: string[] = [];
      const cp = new TenantNarrowedControlPlane({
        baseUrl: `${BASE}/`,
        credential: TOKEN,
        tenantId: T,
        fetch: (async (url: string | URL | Request) => {
          sent.push(String(url));
          return json([]);
        }) as typeof globalThis.fetch,
      });
      await cp.listOrgs();
      expect(sent).toEqual([`${BASE}/tenants/${T}/orgs`]);
    });

    it('with no fetch injected, the global one is used', async () => {
      const seen: string[] = [];
      vi.stubGlobal('fetch', async (url: string | URL | Request) => {
        seen.push(String(url));
        return json([]);
      });
      const cp = new TenantNarrowedControlPlane({ baseUrl: BASE, credential: TOKEN, tenantId: T });
      await cp.listOrgs();
      expect(seen).toEqual([`${BASE}/tenants/${T}/orgs`]);
    });
  });

  describe('answers', () => {
    it('a JSON body comes back as it was sent', async () => {
      const { cp } = plane([json([{ id: 'o1', slug: 'o', name: 'O' }])]);
      expect(await cp.listOrgs()).toEqual([{ id: 'o1', slug: 'o', name: 'O' }]);
    });

    it('a 204 is undefined', async () => {
      const { cp } = plane([() => new Response(null, { status: 204 })]);
      expect(await cp.listOrgs()).toBeUndefined();
    });

    it('a 2xx whose body is empty or not JSON is undefined, never a throw', async () => {
      for (const body of ['', '<html>not json</html>']) {
        const { cp } = plane([() => new Response(body, { status: 200 })]);
        expect(await cp.listOrgs()).toBeUndefined();
      }
    });
  });

  describe('refusals', () => {
    it('reads the RFC 9457 `detail`', async () => {
      const { cp } = plane([json({ type: 'about:blank', title: 'Conflict', status: 409, detail: "slug 'hr' is taken", code: 'conflict' }, 409, 'Conflict')]);
      const e = await cp.provisionScope({ scopeId: S, slug: 'hr', name: 'HR', vertical: 'callout', jurisdiction: 'global' }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ControlPlaneError);
      expect(e).toMatchObject({ status: 409, message: "slug 'hr' is taken" });
    });

    it('falls back to the legacy `error` duplicate', async () => {
      const { cp } = plane([json({ error: 'scope not found' }, 404, 'Not Found')]);
      await expect(cp.listOrgs()).rejects.toMatchObject({ status: 404, message: 'scope not found' });
    });

    it('falls back to the status line when the body says nothing readable', async () => {
      for (const body of ['<html>gateway</html>', '', '{}']) {
        const { cp } = plane([() => new Response(body, { status: 502, statusText: 'Bad Gateway' })]);
        await expect(cp.listOrgs()).rejects.toMatchObject({ status: 502, message: '502 Bad Gateway' });
      }
    });

    it('carries the provider probe of a refused connect (#605)', async () => {
      const probe = { ok: false, provider: 'scrive', detail: 'No valid access credentials were provided' };
      const { cp } = plane([json({ detail: 'the provider refused the credential', probe }, 422, 'Unprocessable Entity')]);
      const e = await cp
        .upsertConnection({ scopeId: S, provider: 'scrive', secret: { token: 'x' }, createdBy: 'me' })
        .catch((x: unknown) => x);
      expect(e).toMatchObject({ status: 422, message: 'the provider refused the credential', probe });
    });

    it('carries no probe when the refusal has none', async () => {
      const { cp } = plane([json({ detail: 'no' }, 422)]);
      const e = (await cp.listOrgs().catch((x: unknown) => x)) as ControlPlaneError;
      expect(e.probe).toBeUndefined();
    });

    it('is the one shared ControlPlaneError class', async () => {
      const { cp } = plane([json({ detail: 'no' }, 403)]);
      const e = await cp.listOrgs().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SharedControlPlaneError);
      expect(ControlPlaneError).toBe(SharedControlPlaneError);
    });
  });

  describe('idempotent steps tolerate 409 and 422', () => {
    const idempotent: Array<[string, (cp: TenantNarrowedControlPlane) => Promise<unknown>]> = [
      ['ensureTenant', (cp) => cp.ensureTenant('acme', 'Acme')],
      ['grantEntitlement', (cp) => cp.grantEntitlement('crm')],
      ['linkIdentity', (cp) => cp.linkIdentity({ provider: 'p', externalId: 's', principal: P })],
      ['unassignRole', (cp) => cp.unassignRole({ principalId: P, roleKey: 'admin' })],
      ['unlinkIdentity', (cp) => cp.unlinkIdentity(P)],
    ];
    for (const [name, run] of idempotent) {
      for (const status of [409, 422]) {
        it(`${name} answers undefined on a ${status}, in one request`, async () => {
          const { cp, sent } = plane([json({ detail: 'already there' }, status)]);
          expect(await run(cp)).toBeUndefined();
          expect(sent).toHaveLength(1);
        });
      }
      it(`${name} still throws on any other refusal`, async () => {
        const { cp } = plane([json({ detail: 'boom' }, 500)]);
        await expect(run(cp)).rejects.toMatchObject({ status: 500, message: 'boom' });
      });
    }

    it('a step that is not idempotent throws on a 409', async () => {
      const { cp } = plane([json({ detail: 'taken' }, 409)]);
      await expect(cp.createOrg({ id: 'o', slug: 'o', name: 'O' })).rejects.toMatchObject({ status: 409, message: 'taken' });
    });
  });

  describe('the credential', () => {
    it('re-mints once on a 401 and presents the fresh token', async () => {
      const asked: Array<boolean | undefined> = [];
      const { cp, sent } = plane([json({ detail: 'expired' }, 401), json([])], async (opts) => {
        asked.push(opts?.fresh);
        return opts?.fresh ? 'stt1.fresh' : TOKEN;
      });
      expect(await cp.listOrgs()).toEqual([]);
      expect(asked).toEqual([undefined, true]);
      expect(sent.map((s) => s.headers['x-service-token'])).toEqual([TOKEN, 'stt1.fresh']);
      expect(sent[1]!.headers).toEqual({ ...WIRE_HEADERS, 'x-service-token': 'stt1.fresh' });
      // The replay is the same request: verb, URL and body.
      expect(sent[1]!.url).toBe(sent[0]!.url);
    });

    it('replays the body on the re-minted attempt', async () => {
      const { cp, sent } = plane([json({}, 401), json({})], async (o) => (o?.fresh ? 'stt1.fresh' : TOKEN));
      await cp.createOrg({ id: 'o', slug: 'o', name: 'O' });
      expect(sent.map((s) => [s.method, s.body])).toEqual([
        ['POST', JSON.stringify({ id: 'o', slug: 'o', name: 'O' })],
        ['POST', JSON.stringify({ id: 'o', slug: 'o', name: 'O' })],
      ]);
    });

    it('a second 401 is the answer', async () => {
      const { cp, sent } = plane([json({ detail: 'refused' }, 401)]);
      await expect(cp.listOrgs()).rejects.toMatchObject({ status: 401, message: 'refused' });
      expect(sent).toHaveLength(2);
    });

    it('an idempotent step re-minted into a 409 is still tolerated', async () => {
      const { cp, sent } = plane([json({}, 401), json({ detail: 'exists' }, 409)]);
      expect(await cp.ensureTenant('acme', 'Acme')).toBeUndefined();
      expect(sent).toHaveLength(2);
    });

    it('a 403 is not retried', async () => {
      const { cp, sent } = plane([json({ detail: 'not yours' }, 403)]);
      await expect(cp.listOrgs()).rejects.toMatchObject({ status: 403 });
      expect(sent).toHaveLength(1);
    });

    it("a provider that cannot resolve a credential fails with its own error, and nothing is sent", async () => {
      class NotConfigured extends Error {}
      const { cp, sent } = plane([json([])], () => Promise.reject(new NotConfigured('no tenant credential')));
      await expect(cp.listOrgs()).rejects.toBeInstanceOf(NotConfigured);
      expect(sent).toHaveLength(0);
    });
  });

  describe('a transport failure', () => {
    it('is a status-0 ControlPlaneError naming what fetch threw', async () => {
      const { cp } = plane([new TypeError('fetch failed')]);
      const e = await cp.listOrgs().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ControlPlaneError);
      expect(e).toMatchObject({ status: 0, message: 'control plane unreachable: fetch failed' });
    });

    it('is not tolerated by an idempotent step, and not retried', async () => {
      const { cp, sent } = plane([new TypeError('fetch failed')]);
      await expect(cp.ensureTenant('acme', 'Acme')).rejects.toMatchObject({ status: 0 });
      expect(sent).toHaveLength(1);
    });
  });

  describe('list reads', () => {
    it('a page envelope comes back verbatim', async () => {
      const { cp } = plane([json({ entries: [{ hostname: 'a' }], nextCursor: 'n1' })]);
      expect(await cp.listTenantHostnamesPage({})).toEqual({ entries: [{ hostname: 'a' }], nextCursor: 'n1' });
    });

    it('a bare array (a pre-envelope plane) is one exhausted page', async () => {
      const { cp } = plane([json([{ hostname: 'a' }])]);
      expect(await cp.listTenantHostnamesPage({})).toEqual({ entries: [{ hostname: 'a' }], nextCursor: null });
    });

    it('an empty answer is an empty page', async () => {
      const { cp } = plane([() => new Response(null, { status: 204 })]);
      expect(await cp.listTenantHostnamesPage({})).toEqual({ entries: [], nextCursor: null });
    });

    it('a complete read walks the cursor at the page cap', async () => {
      const { cp, sent } = plane([
        json({ entries: [{ hostname: 'a' }], nextCursor: 'n1' }),
        json({ entries: [{ hostname: 'b' }], nextCursor: null }),
      ]);
      expect((await cp.listTenantHostnames()).map((h) => h.hostname)).toEqual(['a', 'b']);
      expect(sent.map((s) => s.url)).toEqual([
        `${BASE}/hostnames?tenantId=${T}&limit=${LIST_PAGE_MAX}`,
        `${BASE}/hostnames?tenantId=${T}&limit=${LIST_PAGE_MAX}&cursor=n1`,
      ]);
    });

    it('a filtered walk states a window and a failure apart from the record', async () => {
      const window = plane([json({ entries: [{ id: 1 }, { id: 2 }], nextCursor: 'n1' })]);
      expect(await window.cp.readOpsFailures({ vertical: 'v', limit: 2 })).toEqual({
        entries: [{ id: 1 }, { id: 2 }],
        complete: false,
        failed: false,
      });
      expect(window.sent[0]!.url).toBe(`${BASE}/ops-failures?tenantId=${T}&vertical=v&limit=2`);
      expect(window.sent[0]!.headers).toEqual(WIRE_HEADERS);

      const bare = plane([json([{ id: 1 }])]);
      expect(await bare.cp.readOpsFailures({})).toEqual({ entries: [{ id: 1 }], complete: true, failed: false });

      const failed = plane([json({ detail: 'no such route' }, 404)]);
      expect(await failed.cp.readOpsFailures({})).toEqual({ entries: [], complete: false, failed: true });
    });
  });
});
