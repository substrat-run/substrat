import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox, undeclaredOperations, type OperationHandler } from '@substrat-run/kernel';
import {
  dataSubjectId,
  defineEntities,
  manifestEntities,
  moduleManifest,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type SubjectAccessReceipt,
  z,
} from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, VerticalClient } from '../src/index.js';
import type { SubjectAccessPackage } from '../src/subject-access.js';

/**
 * Subject access end to end (D-74): the route assembles one person's package from the read, masks
 * the other people in it, and records a receipt that holds counts and the reference, never content.
 * That the read reaches what erasure reaches is the adapters' contract suite; this is the route.
 */
describe('subject access (D-74)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const colleague = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const who = dataSubjectId.parse(ulid());
  const other = dataSubjectId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const app = () => createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
  const ask = (body: unknown, subject: string = who) =>
    app().request(`/tenants/${t}/scopes/${s}/subjects/${subject}/access`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

  const entities = defineEntities({
    visit: {
      table: 'sa_visits',
      fields: z.object({ id: z.string(), guest: z.string(), host: z.string().nullable(), note: z.string().nullable() }),
      erasable: ['note'],
      erasure: { subjects: ['guest', 'host'] },
    },
    loose: { table: 'sa_loose', fields: z.object({ id: z.string(), memo: z.string().nullable() }), erasable: ['memo'] },
  });

  let answer: { package: SubjectAccessPackage; receipt: SubjectAccessReceipt; html: string };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-access-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(9)) });
    host.registerModule({
      manifest: moduleManifest.parse({
        id: '@test/visits',
        version: '1.0.0',
        kernelContract: '^0.0.1',
        permissions: [],
        events: { emits: [{ type: 'visits.noted', schemaVersion: 1 }], consumes: [] },
        migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
        entitlementKey: 'visits',
        ...manifestEntities(entities, {}),
      }),
      migrations: [
        {
          version: '0001-init',
          sql: 'CREATE TABLE sa_visits (id TEXT PRIMARY KEY, guest TEXT NOT NULL, host TEXT, note TEXT); CREATE TABLE sa_loose (id TEXT PRIMARY KEY, memo TEXT);',
        },
      ],
      ...undeclaredOperations('a test fixture, built to drive the host rather than declared', {
        'visits/put': ((ctx, input: { sql: string; params: string[] }) => {
          ctx.sql.exec(input.sql, input.params);
        }) as OperationHandler<never, unknown>,
        'visits/note': ((ctx, input: { subject: string; said: string }) => {
          ctx.emit({
            type: 'visits.noted',
            schemaVersion: 1,
            entity: { entityType: 'visit', entityId: input.subject },
            piiClass: 'direct',
            subjectId: dataSubjectId.parse(input.subject),
            payload: { said: input.said },
          });
        }) as OperationHandler<never, unknown>,
      }),
    });
    await host.admin.createTenant(staff, { id: t, slug: `access-${t.toLowerCase()}`, name: 'Access' });
    await host.admin.grantEntitlement(staff, t, 'visits');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'visits' });
    await host.admin.activateScope(staff, t, s);
    const stub = await host.getScope(colleague, t, s);
    const put = (sql: string, params: string[]) => stub.invoke('visits/put', { sql, params });
    await put('INSERT INTO sa_visits (id, guest, host, note) VALUES (?, ?, ?, ?)', [ulid(), who, other, 'asked about parking']);
    await put('INSERT INTO sa_visits (id, guest, host, note) VALUES (?, ?, ?, ?)', [ulid(), other, who, 'hosted them']);
    await put('INSERT INTO sa_visits (id, guest, host, note) VALUES (?, ?, ?, ?)', [ulid(), other, other, 'not theirs']);
    await stub.invoke('visits/note', { subject: who, said: 'their words' });
    await stub.invoke('visits/note', { subject: other, said: 'someone else' });

    const res = await ask({ reference: 'DSAR-2026-014', requesterVerified: true });
    expect(res.status).toBe(200);
    answer = (await res.json()) as typeof answer;
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands the controller the subject's rows and events, with everyone else in them masked", () => {
    const pkg = answer.package;
    expect(pkg).toMatchObject({ kind: 'substrat.subject-access/v1', subjectId: who, reference: 'DSAR-2026-014', jurisdiction: 'global' });
    const visits = pkg.records.find((r) => r.entityType === 'visit')!;
    expect(visits.rows.map((r) => r.note).sort()).toEqual(['asked about parking', 'hosted them']);
    expect(visits.maskedColumns).toEqual(['guest', 'host']);
    // The other person's id never appears; the subject's own does, where it is theirs.
    expect(JSON.stringify(pkg)).not.toContain(other);
    expect(visits.rows.flatMap((r) => [r.guest, r.host])).toContain(who);
    expect(pkg.events).toHaveLength(1);
    expect(pkg.events[0]).toMatchObject({ payload: { said: 'their words' }, erased: false, actor: { kind: 'person' } });
    expect(pkg.events[0]!.actor.ref).not.toBe(colleague);
    expect(pkg.categories).toEqual({ entities: [{ entityType: 'visit', fields: ['note'] }], events: ['direct'] });
    expect(pkg.recipients.status).toBe('not-available');
    expect(pkg.unreached.entities).toEqual([{ module: '@test/visits', entityType: 'loose' }]);
    expect(answer.html).toContain('asked about parking');
    expect(answer.html).not.toContain('<script');
  });

  it('records a receipt of counts and the reference under subjectAccess, and the read in the access log', async () => {
    const [row] = await host.admin.auditLog(staff, { tenantId: t, action: 'subjectAccess' });
    expect(row?.after).toEqual(answer.receipt);
    expect(answer.receipt).toMatchObject({
      subjectId: who,
      reference: 'DSAR-2026-014',
      requesterVerified: true,
      residencyExempt: false,
      events: 1,
      erasedEvents: 0,
      records: [{ module: '@test/visits', entityType: 'visit', rows: 2 }],
      recipients: 'not-available',
    });
    expect(JSON.stringify(row?.after)).not.toContain('parking');
    expect(await host.admin.accessLog(staff, { tenantId: t, method: 'subjectAccess' })).toHaveLength(1);
  });

  it('refuses a reaped scope before reading, even when its deployment still resolves, and records nothing', async () => {
    const gone = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: gone, vertical: 'visits' });
    await host.admin.activateScope(staff, t, gone);
    await host.admin.archiveScope(staff, t, gone);
    await host.admin.reapScope(staff, t, gone, { force: true });
    // A deployment that still answers for the slug: the read must never reach it.
    let reached = 0;
    const deployed = new VerticalClient({
      fetch: (async () => {
        reached += 1;
        return new Response(JSON.stringify({ events: [], records: [], unreachedEntities: [], hookEntities: [], nextCursor: null }));
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const res = await createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), verticals: { visits: deployed } }).request(
      `/tenants/${t}/scopes/${gone}/subjects/${who}/access`,
      { method: 'POST', headers: auth, body: JSON.stringify({ reference: 'DSAR-2026-015', requesterVerified: true }) },
    );
    expect(res.status).toBe(409);
    expect(reached).toBe(0);
    expect(await host.admin.auditLog(staff, { tenantId: t, action: 'subjectAccess' })).toHaveLength(1);
  });

  it('refuses a request without a one-line reference and the identity confirmation, and records nothing', async () => {
    for (const body of [{ reference: 'x' }, { reference: 'a\nb', requesterVerified: true }, { reference: '', requesterVerified: true }]) {
      expect((await ask(body)).status).toBe(400);
    }
    expect(await host.admin.auditLog(staff, { tenantId: t, action: 'subjectAccess' })).toHaveLength(1);
  });
});
