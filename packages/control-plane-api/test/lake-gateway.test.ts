import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { lakeEventsInput, platformActorId, scopeId, tenantId, type LakeEventsPage } from '@substrat-run/contracts';
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
import {
  LakeTenantMismatchError,
  compileLakeEvents,
  queryLakeEvents,
  type LakeQueryEngine,
} from '../src/lake-gateway.js';
import { LakeQueryError, createR2SqlEngine } from '../src/r2-sql-engine.js';

/**
 * The Tier-2 lake's query gateway (#1334): one tenant's events, and never another's.
 *
 * The compiled SQL runs on a real SQLite table built from the stream schema the lake is
 * provisioned with (`scripts/lake/outbox-stream-schema.generated.json`), so a column the
 * gateway names and the lake does not have fails here. What this does NOT prove is R2 SQL's
 * dialect: `occurred_at` is held as ISO text below, where the lake holds an Iceberg
 * timestamp, and the gateway's window filters lean on the engine coercing a string literal.
 * That half is the smoke test the PR asks a human for.
 */

const SCHEMA = JSON.parse(
  readFileSync(new URL('../../../scripts/lake/outbox-stream-schema.generated.json', import.meta.url), 'utf8'),
) as { fields: { name: string; type: string }[] };

const SQL_TYPE: Record<string, string> = { string: 'TEXT', int64: 'INTEGER', timestamp: 'TEXT', json: 'TEXT' };

/** A lake with the provisioned columns, in SQLite, and every statement it was asked. */
function sqliteLake() {
  const db = new Database(':memory:');
  db.exec(`ATTACH DATABASE ':memory:' AS kernel`);
  db.exec(
    `CREATE TABLE kernel.events (${SCHEMA.fields.map((f) => `${f.name} ${SQL_TYPE[f.type] ?? 'TEXT'}`).join(', ')})`,
  );
  const asked: string[] = [];
  const engine: LakeQueryEngine = {
    async query(sql) {
      asked.push(sql);
      return db.prepare(sql).all() as Record<string, unknown>[];
    },
  };
  const insert = (row: Record<string, unknown>) => {
    const cols = SCHEMA.fields.map((f) => f.name);
    db.prepare(`INSERT INTO kernel.events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
      ...cols.map((c) => {
        const v = row[c] ?? null;
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      }),
    );
  };
  return { db, engine, asked, insert };
}

const A = tenantId.parse(ulid());
const B = tenantId.parse(ulid());
const scopeA1 = scopeId.parse(ulid());
const scopeA2 = scopeId.parse(ulid());
const scopeB = scopeId.parse(ulid());
const alice = ulid();
const bob = ulid();

/** Ids ascending by construction, so "newest first" has an answer. */
const ids = Array.from({ length: 12 }, () => ulid()).sort();
const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();

function event(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ids[i],
    type: 'todo.item-created',
    schema_version: 1,
    occurred_at: at(i),
    tenant_id: A,
    scope_id: scopeA1,
    actor: alice,
    entity_type: 'item',
    entity_id: `item-${i}`,
    pii_class: 'personal',
    subject_id: 'subject-1',
    payload: { title: `secret title ${i}` },
    authorization: { via: 'role' },
    impersonation: null,
    operation: 'todo/create-item',
    version: 'v1',
    caused_by: null,
    invocation_id: null,
    bytes: 100,
    ...over,
  };
}

/** Tenant A: ids 0–7, across two scopes. Tenant B: ids 8–11, sharing every value A has. */
function seed(insert: (row: Record<string, unknown>) => void) {
  insert(event(0));
  insert(event(0)); // the drain is at-least-once: the same row twice
  insert(event(1, { type: 'todo.item-completed', operation: 'todo/complete-item' }));
  insert(event(2, { scope_id: scopeA2 }));
  insert(event(3, { actor: bob, version: 'v2' }));
  insert(event(4, { impersonation: { staff: ulid(), session: ulid() } }));
  insert(event(5, { entity_type: 'list', entity_id: 'list-1' }));
  insert(event(6, { actor: { system: 'engine-workorder' } }));
  insert(event(7));
  for (const i of [8, 9, 10, 11]) insert(event(i, { tenant_id: B, scope_id: scopeB }));
}

const input = (raw: Record<string, unknown> = {}) => lakeEventsInput.parse(raw);
const idsOf = (page: LakeEventsPage) => page.events.map((e) => e.id);

describe('compileLakeEvents (#1334)', () => {
  it('writes the tenant predicate first, before any filter, in every query', () => {
    for (const raw of [{}, { scopeId: scopeB }, { type: 'x.y', cursor: ids[3], impersonated: 'true' }]) {
      expect(compileLakeEvents(A, input(raw))).toMatch(new RegExp(`WHERE tenant_id = '${A}'( AND |\\s+ORDER BY)`));
    }
  });

  it('refuses to write a literal outside the lake alphabet, even when a schema let it through', () => {
    for (const bad of ["x' OR '1'='1", 'a b', 'a;--', 'a\\b', '']) {
      expect(() => compileLakeEvents(A, { ...input(), entityType: bad })).toThrow(/lake alphabet/);
      expect(() => compileLakeEvents(A, { ...input(), operation: bad })).toThrow(/lake alphabet/);
    }
    // …and the tenant goes through the same guard, so a forged id cannot open the predicate.
    expect(() => compileLakeEvents("x' OR '1'='1" as never, input())).toThrow(/lake alphabet/);
  });
});

describe('lakeEventsInput (#1334)', () => {
  it('has no tenant field, and refuses one rather than ignoring it', () => {
    expect(lakeEventsInput.safeParse({ tenantId: B }).success).toBe(false);
    expect(lakeEventsInput.safeParse({ tenant_id: B }).success).toBe(false);
    expect(lakeEventsInput.safeParse({ sql: 'SELECT 1' }).success).toBe(false);
    expect(lakeEventsInput.safeParse({}).success).toBe(true);
  });

  it('refuses a value that could end the literal it sits in, in every free-text filter', () => {
    for (const key of ['entityType', 'entityId', 'operation', 'version']) {
      for (const bad of ["x' OR tenant_id <> 'y", 'a b', 'a;--', 'a\\b', '"a"']) {
        const raw = key === 'entityId' ? { entityType: 'item', entityId: bad } : { [key]: bad };
        expect(lakeEventsInput.safeParse(raw).success, `${key}=${bad}`).toBe(false);
      }
      // The positive twin: an ordinary value of each kind is accepted.
      const good = key === 'entityId' ? { entityType: 'item', entityId: 'item-01J:x/y' } : { [key]: 'todo/create-item' };
      expect(lakeEventsInput.safeParse(good).success, key).toBe(true);
    }
  });

  it('takes ids, instants and the event type through their own schemas', () => {
    expect(lakeEventsInput.safeParse({ scopeId: 'not-a-ulid' }).success).toBe(false);
    expect(lakeEventsInput.safeParse({ actor: "x' OR '1'='1" }).success).toBe(false);
    expect(lakeEventsInput.safeParse({ cursor: 'zzz' }).success).toBe(false);
    expect(lakeEventsInput.safeParse({ since: 'yesterday' }).success).toBe(false);
    expect(lakeEventsInput.safeParse({ type: "a.b' --" }).success).toBe(false);
    expect(lakeEventsInput.safeParse({ impersonated: 'false' }).success).toBe(false);
    expect(lakeEventsInput.safeParse({ limit: '201' }).success).toBe(false);
    expect(lakeEventsInput.safeParse({ entityId: 'item-1' }).success).toBe(false);
  });
});

describe('queryLakeEvents over a real table (#1334)', () => {
  const lake = sqliteLake();
  beforeAll(() => seed(lake.insert));
  afterAll(() => lake.db.close());

  it("answers with the tenant's own events only, newest first, each duplicate once", async () => {
    const page = await queryLakeEvents(lake.engine, A, input());
    expect(idsOf(page)).toEqual([7, 6, 5, 4, 3, 2, 1, 0].map((i) => ids[i]));
    expect(page.consistency).toBe('eventual');
    expect(page.nextCursor).toBeNull();
    expect(idsOf(await queryLakeEvents(lake.engine, B, input()))).toEqual([11, 10, 9, 8].map((i) => ids[i]));
  });

  it("returns nothing for another tenant's scope, rather than that scope's events", async () => {
    expect((await queryLakeEvents(lake.engine, A, input({ scopeId: scopeB }))).events).toEqual([]);
    // The positive twin: the tenant's own scope narrows to exactly its events.
    expect(idsOf(await queryLakeEvents(lake.engine, A, input({ scopeId: scopeA2 })))).toEqual([ids[2]]);
  });

  it('narrows by each filter, and each narrows within the tenant', async () => {
    const only = async (raw: Record<string, unknown>) => idsOf(await queryLakeEvents(lake.engine, A, input(raw)));
    expect(await only({ type: 'todo.item-completed' })).toEqual([ids[1]]);
    expect(await only({ operation: 'todo/complete-item' })).toEqual([ids[1]]);
    expect(await only({ entityType: 'list', entityId: 'list-1' })).toEqual([ids[5]]);
    expect(await only({ entityType: 'list' })).toEqual([ids[5]]);
    expect(await only({ actor: bob })).toEqual([ids[3]]);
    expect(await only({ version: 'v2' })).toEqual([ids[3]]);
    expect(await only({ impersonated: 'true' })).toEqual([ids[4]]);
    expect(await only({ since: at(6) })).toEqual([ids[7], ids[6]]);
    expect(await only({ until: at(1) })).toEqual([ids[0]]);
    expect(await only({ since: at(2), until: at(4) })).toEqual([ids[3], ids[2]]);
    // B holds a row for every one of these values; none of them comes back to A.
    expect(await only({ entityType: 'item', entityId: 'item-9' })).toEqual([]);
  });

  it('pages by cursor without repeating or skipping an event', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await queryLakeEvents(lake.engine, A, input({ limit: '3', ...(cursor ? { cursor } : {}) }));
      seen.push(...idsOf(page));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1, 0].map((i) => ids[i]));
  });

  it('answers with the envelope only: no payload, subject, authorization or impersonation detail', async () => {
    const page = await queryLakeEvents(lake.engine, A, input());
    const text = JSON.stringify(page);
    expect(text).not.toContain('secret title');
    expect(text).not.toContain('subject-1');
    for (const e of page.events) {
      expect(Object.keys(e).sort()).toEqual(
        [
          'actor', 'causedBy', 'entityId', 'entityType', 'id', 'impersonated', 'invocationId',
          'occurredAt', 'operation', 'piiClass', 'schemaVersion', 'scopeId', 'type', 'version',
        ].sort(),
      );
    }
    // The fact of a staff session is there; the session is not.
    expect(page.events.find((e) => e.id === ids[4])?.impersonated).toBe(true);
    expect(page.events.find((e) => e.id === ids[0])?.impersonated).toBe(false);
    // A system actor stored as JSON text comes back as the actor it was.
    expect(page.events.find((e) => e.id === ids[6])?.actor).toEqual({ system: 'engine-workorder' });
  });
});

describe('the cross-tenant check (#1334)', () => {
  const rowOf = (tenant: string, i: number) => ({ ...event(i, { tenant_id: tenant }), impersonated: 0 });

  it('refuses the whole read when the engine hands back any row of another tenant', async () => {
    const engine: LakeQueryEngine = { query: async () => [rowOf(A, 0), rowOf(B, 8), rowOf(A, 1)] };
    await expect(queryLakeEvents(engine, A, input())).rejects.toBeInstanceOf(LakeTenantMismatchError);
  });

  it('refuses a row that names no tenant at all', async () => {
    const { tenant_id: _gone, ...headless } = rowOf(A, 0);
    const engine: LakeQueryEngine = { query: async () => [headless] };
    await expect(queryLakeEvents(engine, A, input())).rejects.toBeInstanceOf(LakeTenantMismatchError);
  });

  it("passes a page that is wholly the tenant's own", async () => {
    const engine: LakeQueryEngine = { query: async () => [rowOf(A, 1), rowOf(A, 0)] };
    expect(idsOf(await queryLakeEvents(engine, A, input()))).toEqual([ids[1], ids[0]]);
  });
});

describe('GET /tenants/:tenantId/lake/events (#1334)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const asStaff = { [DEV_ACTOR_HEADER]: staff };
  const lake = sqliteLake();
  let dir: string;
  let host: SqliteScopeHost;
  let failAccess = false;

  /** The host, with the K-24 write made to fail on demand. */
  const hostView = () =>
    new Proxy(host, {
      get(target, prop) {
        if (prop === 'admin') {
          return new Proxy(target.admin, {
            get(admin, key) {
              const v = Reflect.get(admin, key);
              if (key === 'recordDelegatedRead' && failAccess) return async () => { throw new Error('access log down'); };
              return typeof v === 'function' ? v.bind(admin) : v;
            },
          });
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as unknown as ScopeHost;

  const apiWith = (lakeQuery?: LakeQueryEngine) =>
    createControlPlaneApi({
      host: hostView(),
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
      ...(lakeQuery ? { lakeQuery } : {}),
    });
  let app: ReturnType<typeof createControlPlaneApi>;
  const lakeRows = async () =>
    (await host.admin.accessLog(staff, { method: 'lakeEvents' })).filter((r) => r.method === 'lakeEvents');

  beforeAll(async () => {
    seed(lake.insert);
    dir = mkdtempSync(join(tmpdir(), 'cp-lake-'));
    host = new SqliteScopeHost({ dir });
    for (const [tenant, slug] of [[A, 'acme'], [B, 'tenant-b']] as const) {
      await host.admin.createTenant(staff, { id: tenant, slug, name: slug });
    }
    app = apiWith(lake.engine);
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
    lake.db.close();
  });

  it('answers 501 when no engine is configured, and asks nothing of anything', async () => {
    const res = await apiWith().request(`/tenants/${A}/lake/events`, { headers: asStaff });
    expect(res.status).toBe(501);
  });

  it("serves staff the path tenant's events, and writes one K-24 row naming the filters", async () => {
    const before = (await lakeRows()).length;
    const res = await app.request(`/tenants/${A}/lake/events?scopeId=${scopeA1}&limit=2`, { headers: asStaff });
    expect(res.status).toBe(200);
    const page = (await res.json()) as LakeEventsPage;
    expect(idsOf(page)).toEqual([ids[7], ids[6]]);
    const rows = await lakeRows();
    expect(rows.length).toBe(before + 1);
    const row = rows.find((r) => r.tenantId === A)!;
    expect(row).toMatchObject({ actor: staff, tenantId: A, scopeId: scopeA1, resultCount: 2 });
    expect(JSON.parse(row.params!)).toEqual({ scopeId: scopeA1 });
  });

  it('records a tenant-wide read with no scope', async () => {
    const res = await app.request(`/tenants/${B}/lake/events`, { headers: asStaff });
    expect(res.status).toBe(200);
    expect((await lakeRows()).filter((r) => r.tenantId === B)).toMatchObject([{ scopeId: null, resultCount: 4 }]);
  });

  it('returns no rows when the access row cannot be written', async () => {
    failAccess = true;
    try {
      const res = await app.request(`/tenants/${A}/lake/events`, { headers: asStaff });
      expect(res.status).toBe(500);
      const text = await res.text();
      for (const id of ids) expect(text).not.toContain(id);
    } finally {
      failAccess = false;
    }
  });

  it('refuses a query naming a tenant, or any key it does not know, before the engine is asked', async () => {
    const asked = lake.asked.length;
    for (const q of [`tenantId=${B}`, `tenant_id=${B}`, 'sql=SELECT%201', `entityType=x'%20OR%20'1'='1`]) {
      const res = await app.request(`/tenants/${A}/lake/events?${q}`, { headers: asStaff });
      expect(res.status, q).toBe(400);
    }
    expect(lake.asked.length).toBe(asked);
  });

  it('answers 502 for an engine failure, and records no read that disclosed nothing', async () => {
    const before = (await lakeRows()).length;
    const failing = apiWith({ query: async () => { throw new LakeQueryError('R2 SQL query failed (500): boom'); } });
    const res = await failing.request(`/tenants/${A}/lake/events`, { headers: asStaff });
    expect(res.status).toBe(502);
    expect((await lakeRows()).length).toBe(before);
  });

  it('answers 500 with nothing in it when the engine crosses tenants', async () => {
    const leaking = apiWith({ query: async () => [{ ...event(8, { tenant_id: B }), impersonated: 0 }] });
    const res = await leaking.request(`/tenants/${A}/lake/events`, { headers: asStaff });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(ids[8]);
  });

  it("is staff only: a tenant's own credential and a builder's push token are refused, even for their own tenant", async () => {
    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: { ...asStaff, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: A }),
    });
    expect(minted.status).toBe(201);
    const asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token };
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(A), tenantId: A, tenantSlug: 'acme' });
    const asBuilder = { [SERVICE_TOKEN_HEADER]: push };
    const asked = lake.asked.length;
    for (const headers of [asTenant, asBuilder]) {
      const res = await app.request(`/tenants/${A}/lake/events`, { headers });
      expect(res.status).toBe(403);
    }
    expect(lake.asked.length).toBe(asked);
  });
});

describe('createR2SqlEngine (#1334)', () => {
  const opts = { accountId: 'acct', bucket: 'substrat-lake', token: 'read-only-token' };
  const fake = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('posts the statement to the bucket with the read-only token, and returns the rows', async () => {
    const { calls, fetchImpl } = fake(200, { success: true, errors: [], result: { rows: [{ id: 'x', tenant_id: A }] } });
    const rows = await createR2SqlEngine({ ...opts, fetchImpl }).query('SELECT 1');
    expect(rows).toEqual([{ id: 'x', tenant_id: A }]);
    expect(calls[0]!.url).toBe('https://api.sql.cloudflarestorage.com/api/v1/accounts/acct/r2-sql/query/substrat-lake');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer read-only-token');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ query: 'SELECT 1' });
  });

  it("throws Cloudflare's reason for a refused query", async () => {
    const { fetchImpl } = fake(400, { success: false, errors: [{ message: 'parse error' }] });
    await expect(createR2SqlEngine({ ...opts, fetchImpl }).query('SELECT')).rejects.toThrow(/parse error/);
  });

  it('refuses an answer whose shape it does not know rather than guessing at rows', async () => {
    for (const result of [{}, { rows: 'no' }, { rows: [[A, 'x']] }]) {
      const { fetchImpl } = fake(200, { success: true, result });
      await expect(createR2SqlEngine({ ...opts, fetchImpl }).query('SELECT 1')).rejects.toBeInstanceOf(LakeQueryError);
    }
  });
});
