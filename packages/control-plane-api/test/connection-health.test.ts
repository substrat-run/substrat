import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox, type ScopeHost } from '@substrat-run/kernel';
import {
  connectionHealthEntry,
  connectionId,
  platformActorId,
  tenantId,
  type Connection,
  type ConnectionHealthPage,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  firstBuilderAuth,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';
import { CONNECTOR_DEAD_LETTER_CAP } from '../src/api.js';

/**
 * `GET /connections/health` (#1690) — the staff console's fleet-wide connection health.
 *
 * Three properties, each with its positive twin: the response never carries a credential
 * (and projects an allow-list, so a widened row upstream cannot leak through it); the
 * derived-status filter pages correctly; and the read is staff/service only.
 */
const TENANT_SECRET = 'test-tenant-token-secret';
const PUSH_SECRET = 'test-push-token-secret';

/** Every value and key a stored credential carries — none may appear in any response. */
const SECRET = { apiToken: 'tok-LIVE-do-not-return', apiSecret: 'sec-LIVE-do-not-return' };

describe('GET /connections/health (#1690)', () => {
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const acme = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff };
  let asTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const apiFor = (h: ScopeHost) =>
    createControlPlaneApi({
      host: h,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
    });

  /** The same host with `admin.listConnections` swapped — every other member untouched. */
  const withListConnections = (list: ScopeHost['admin']['listConnections']): ScopeHost => {
    const admin = new Proxy(host.admin, {
      get: (target, p) => (p === 'listConnections' ? list : Reflect.get(target, p)),
    });
    return new Proxy(host, { get: (target, p) => (p === 'admin' ? admin : Reflect.get(target, p)) }) as ScopeHost;
  };

  const read = async (a: ReturnType<typeof createControlPlaneApi>, path = '/connections/health') => {
    const res = await a.request(path, { headers: asStaff });
    expect(res.status).toBe(200);
    const text = await res.text();
    return { text, body: JSON.parse(text) as ConnectionHealthPage };
  };

  const ids: Record<string, string> = {};
  const connect = async (key: string, tenant: typeof acme, provider: string, account: string) => {
    const id = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id,
      tenantId: tenant,
      vertical: 'callout',
      provider,
      label: `${key} (${provider})`,
      externalAccountRef: account,
      scopes: ['doc:send'],
      secret: SECRET,
    });
    ids[key] = id;
    return id;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-connection-health-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k1', new Uint8Array(32).fill(7)) });
    app = apiFor(host);
    await host.admin.createTenant(staff, { id: acme, slug: 'acme', name: 'Acme' });
    await host.admin.createTenant(staff, { id: other, slug: 'other', name: 'Other' });

    await host.admin.recordConnectionUse(await connect('ok', acme, 'scrive', 'a1'), { ok: true });
    await host.admin.recordConnectionUse(await connect('bad', acme, 'scrive', 'a2'), {
      ok: false,
      error: 'HTTP 401 from scrive',
    });
    await connect('fresh', other, 'fortnox', 'f1'); // stored, never used

    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: { ...asStaff, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: acme }),
    });
    expect(minted.status).toBe(201);
    asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token };
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(acme), tenantId: acme, tenantSlug: 'acme' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('secrets', () => {
    it('no credential key or value appears anywhere in the response', async () => {
      const { text, body } = await read(app);
      expect(body.entries).toHaveLength(3);
      for (const [k, v] of Object.entries(SECRET)) {
        expect(text).not.toContain(k);
        expect(text).not.toContain(v);
      }
      expect(text).not.toMatch(/ciphertext|key_id|keyId|sealed|"secret"/);
    });

    it('each row is exactly the allow-list — no createdBy, scopes or revokedAt', async () => {
      const { body } = await read(app);
      for (const e of body.entries) {
        expect(Object.keys(e).sort()).toEqual(Object.keys(connectionHealthEntry.shape).sort());
        expect(connectionHealthEntry.parse(e)).toEqual(e);
      }
      expect(JSON.stringify(body)).not.toContain(staff); // the createdBy principal
    });

    it('a row widened upstream (an adapter returning its raw row) does not leak through', async () => {
      // The shape a `SELECT *` joined to the secrets table would hand back. Against a
      // spread projection this fails; against the allow-list it cannot.
      const widened = withListConnections(async (actor, filter) =>
        (await host.admin.listConnections(actor, filter)).map(
          (r) => ({ ...r, secret: SECRET, key_id: 'k1', ciphertext: 'SEALED-BLOB' }) as unknown as Connection,
        ),
      );
      const { text } = await read(apiFor(widened));
      expect(text).not.toContain(SECRET.apiToken);
      expect(text).not.toContain('SEALED-BLOB');
      expect(text).not.toContain('key_id');
    });
  });

  describe('health and filters', () => {
    it('derives healthy / erroring / never-used from what the runtime recorded', async () => {
      const { body } = await read(app);
      const by = Object.fromEntries(body.entries.map((e) => [e.id, e]));
      expect(by[ids.ok!]!.health).toBe('healthy');
      expect(by[ids.bad!]!.health).toBe('erroring');
      expect(by[ids.bad!]!.lastError).toBe('HTTP 401 from scrive');
      expect(by[ids.fresh!]!.health).toBe('never-used');
      expect(body.summary).toEqual({ total: 3, healthy: 1, erroring: 1, stale: 0, 'never-used': 1, expiring: 0, expired: 0 });
      expect(body.staleAfterDays).toBe(7);
      expect(body.expiryWarningDays).toBe(7);
    });

    it('filters by status, provider and tenant', async () => {
      const erroring = (await read(app, '/connections/health?status=erroring')).body;
      expect(erroring.entries.map((e) => e.id)).toEqual([ids.bad]);
      // The summary counts the set BEFORE the health filter — the chips' numbers.
      expect(erroring.summary.total).toBe(3);

      const fortnox = (await read(app, '/connections/health?provider=fortnox')).body;
      expect(fortnox.entries.map((e) => e.id)).toEqual([ids.fresh]);

      const theirs = (await read(app, `/connections/health?tenantId=${other}`)).body;
      expect(theirs.entries.map((e) => e.tenantId)).toEqual([other]);
    });

    it('refuses an unknown status rather than answering unfiltered', async () => {
      const res = await app.request('/connections/health?status=fine', { headers: asStaff });
      expect(res.status).toBe(400);
    });

    it('refuses order=desc rather than handing back ascending pages under that name', async () => {
      expect((await app.request('/connections/health?order=desc', { headers: asStaff })).status).toBe(400);
      // Its twin: the one order the walk has is accepted when spelled out.
      expect((await app.request('/connections/health?order=asc', { headers: asStaff })).status).toBe(200);
    });

    it('q matches account, label and error text, case-insensitively', async () => {
      expect((await read(app, '/connections/health?q=A2')).body.entries.map((e) => e.id)).toEqual([ids.bad]);
      expect((await read(app, '/connections/health?q=http%20401')).body.entries.map((e) => e.id)).toEqual([ids.bad]);
      expect((await read(app, '/connections/health?q=nothing-matches')).body.entries).toEqual([]);
    });
  });

  describe('paging a derived-status filter', () => {
    // Nine rows alternating erroring / healthy by id order, so erroring rows straddle
    // every page boundary of the unfiltered list. Paging BEFORE filtering would hand
    // back short (or empty) pages while a cursor still existed.
    const NOW = Date.now();
    const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
    const rows: Connection[] = Array.from({ length: 9 }, (_, i) => ({
      id: connectionId.parse(`01JZ00000000000000000000${String(i).padStart(2, '0')}`),
      tenantId: acme,
      vertical: 'callout',
      provider: 'scrive',
      label: `row ${i}`,
      status: i % 2 === 0 ? 'error' : 'active',
      externalAccountRef: `acct-${i}`,
      scopes: [],
      expiresAt: null,
      lastOkAt: i % 2 === 0 ? null : iso(60_000),
      lastError: i % 2 === 0 ? 'boom' : null,
      lastErrorAt: i % 2 === 0 ? iso(60_000) : null,
      createdBy: staff,
      createdAt: iso(86_400_000),
      revokedAt: null,
    }));
    const paged = () => apiFor(withListConnections(async () => [...rows].reverse()));

    it('every page is full until the last, and the walk returns exactly the matching rows', async () => {
      const a = paged();
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const { body } = await read(a, `/connections/health?status=erroring&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        pages += 1;
        if (body.nextCursor) expect(body.entries).toHaveLength(2);
        seen.push(...body.entries.map((e) => e.id));
        cursor = body.nextCursor;
      } while (cursor && pages < 10);
      const erroring = rows.filter((_, i) => i % 2 === 0).map((r) => r.id);
      expect(seen).toEqual(erroring); // 5 rows: pages of 2, 2, 1
      expect(pages).toBe(3);
    });

    it('q finds a row that sits on a later page of the unfiltered walk', async () => {
      // Row 7 is on page 4 at limit 2. A search applied to loaded pages only would miss it.
      const { body } = await read(paged(), '/connections/health?q=ROW%207&limit=2');
      expect(body.entries.map((e) => e.id)).toEqual([rows[7]!.id]);
      expect(body.nextCursor).toBeNull();
    });

    it('summary counts an upcoming expiry and a passed one separately', async () => {
      const day = 86_400_000;
      const withExpiry = rows.slice(0, 3).map((r, i) => ({
        ...r,
        expiresAt: [iso(-2 * day), iso(day), null][i] as Connection['expiresAt'],
      }));
      const { body } = await read(apiFor(withListConnections(async () => withExpiry)));
      expect(body.summary.expiring).toBe(1);
      expect(body.summary.expired).toBe(1);
      // iso() counts back from now: the first grant ends in two days, the second ended a day ago.
      expect(body.entries.map((e) => e.expiryWarning)).toEqual(['soon', 'expired', null]);
    });

    it('its positive twin: the unfiltered walk returns every row in id order', async () => {
      const { body } = await read(paged(), '/connections/health?limit=200');
      expect(body.entries.map((e) => e.id)).toEqual(rows.map((r) => r.id));
      expect(body.nextCursor).toBeNull();
    });
  });

  describe('connector dead letters', () => {
    const deadLetter = (provider: string, tenant: typeof acme) =>
      host.admin.recordOpsFailure({
        actor: staff,
        operation: `intent.connector:${provider}`,
        stage: 'terminal',
        tenantId: tenant,
        scopeId: null,
        vertical: 'callout',
        status: 422,
        message: 'platform intent x failed: refused',
        reference: null,
      });

    beforeAll(async () => {
      for (let i = 0; i < CONNECTOR_DEAD_LETTER_CAP + 1; i++) await deadLetter('scrive', acme);
      await deadLetter('fortnox', other);
      await deadLetter('fortnox', other);
      // Not a connector dead letter: another intent kind, and a non-intent operation.
      await host.admin.recordOpsFailure({
        actor: staff, operation: 'intent.provision-sibling', stage: 'terminal', tenantId: acme,
        scopeId: null, vertical: 'callout', status: 422, message: 'no', reference: null,
      });
    });

    it('counts per provider, bounded, and says when the bound was hit', async () => {
      const { body } = await read(app);
      expect(body.deadLetters).toEqual([
        { provider: 'fortnox', count: 2, capped: false },
        { provider: 'scrive', count: CONNECTOR_DEAD_LETTER_CAP, capped: true },
      ]);
      expect(Date.parse(body.deadLettersSince)).toBeLessThan(Date.parse(body.asOf));
    });

    it('narrows with the tenant and provider filters', async () => {
      expect((await read(app, `/connections/health?tenantId=${other}`)).body.deadLetters).toEqual([
        { provider: 'fortnox', count: 2, capped: false },
      ]);
      expect((await read(app, '/connections/health?provider=fortnox&tenantId=' + acme)).body.deadLetters).toEqual([
        { provider: 'fortnox', count: 0, capped: false },
      ]);
    });
  });

  describe('authority — staff/service only', () => {
    it('staff reads it (the positive twin)', async () => {
      expect((await app.request('/connections/health', { headers: asStaff })).status).toBe(200);
    });

    it('a tenant token is refused — with or without naming its own tenant', async () => {
      expect((await app.request('/connections/health', { headers: asTenant })).status).toBe(403);
      expect((await app.request(`/connections/health?tenantId=${acme}`, { headers: asTenant })).status).toBe(403);
      // …while the same token still reaches a route on its allowlist, so the 403 is this route's.
      expect((await app.request(`/tenants/${acme}/connections`, { headers: asTenant })).status).toBe(200);
    });

    it('a builder token is refused — with or without naming its own tenant', async () => {
      expect((await app.request('/connections/health', { headers: asBuilder })).status).toBe(403);
      expect((await app.request(`/connections/health?tenantId=${acme}`, { headers: asBuilder })).status).toBe(403);
      // …while the same token still reaches a builder route, so the 403 is this route's.
      expect((await app.request('/sweep-runs', { headers: asBuilder })).status).toBe(200);
    });

    it('no credential at all is 401', async () => {
      expect((await app.request('/connections/health')).status).toBe(401);
    });
  });
});
