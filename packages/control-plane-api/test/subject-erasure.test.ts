import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox, type OperationHandler, undeclaredOperations } from '@substrat-run/kernel';
import {
  dataSubjectId,
  moduleManifest,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ScopeBackup,
  type ScopeId,
  type ScopeDump,
  type SubjectShredReceipt,
  RESERVED_STORE_OPERATIONS,
  type StoreKindRegistration,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  unreachablePlatformScopeStores,
  type PlatformScopeStores,
  type ScopeBackupStore,
} from '../src/index.js';

/**
 * Subject erasure end to end (#37) — the claim as a round trip rather than a claim.
 *
 * The adapter suite (`contract-tests`) already proves the primitives: a shred redacts the
 * live spine, keeps the envelope, destroys the key, and tombstones the id. What only this
 * layer can prove is the part the whole mechanism exists for:
 *
 *   take a backup → shred a subject → read the backup back → THAT subject's payloads are
 *   unrecoverable, and everybody else's restore intact.
 *
 * A backup is full-fidelity and immutable by design, so a redaction cannot reach one. This
 * test is what stands between "we support erasure" and a copy in a bucket that still names
 * someone we told a regulator we had forgotten.
 */
describe('subject erasure (#37)', () => {
  let dir: string;
  let host: SqliteScopeHost;

  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };

  // Two people in one scope. The whole point of a per-subject key is that erasing one is
  // not erasing the other, so every assertion below is paired.
  const erased = dataSubjectId.parse(ulid());
  const spared = dataSubjectId.parse(ulid());

  /** An in-memory `ScopeBackupStore` that keeps the dump EXACTLY as it was handed over. */
  const held = new Map<string, ScopeDump>();
  const store: ScopeBackupStore = {
    put: async ({ dump }) => {
      held.set(dump.capturedAt, dump);
      return {
        tenantId: dump.tenantId,
        scopeId: dump.scopeId,
        vertical: null,
        capturedAt: dump.capturedAt,
        size: JSON.stringify(dump).length,
        tables: dump.tables.length,
      } satisfies ScopeBackup;
    },
    list: async () => [...held.values()].map((d) => ({
      tenantId: d.tenantId,
      scopeId: d.scopeId,
      vertical: null,
      capturedAt: d.capturedAt,
      size: JSON.stringify(d).length,
      tables: d.tables.length,
    })),
    get: async ({ capturedAt }) => held.get(capturedAt) ?? null,
  };

  const app = () =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      scopeBackups: store,
    });

  /** The spine as the store holds it — ciphertext included, nothing opened on the way. */
  const storedSpine = (capturedAt: string) => {
    const dump = held.get(capturedAt)!;
    const table = dump.tables.find((x) => x.name === '_substrat_outbox')!;
    const subject = table.columns.indexOf('subject_id');
    const payload = table.columns.indexOf('payload');
    return table.rows.map((r) => ({ subjectId: r[subject], payload: r[payload] }));
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-shred-'));
    // A SecretBox is required, not optional: without one the key store fails closed and
    // no backup can be sealed at all. That is the same posture connections take — an
    // unset secret is a failure, never a silent downgrade to plaintext.
    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(9)),
    });

    host.registerModule({
      manifest: moduleManifest.parse({
        id: '@test/people',
        version: '1.0.0',
        kernelContract: '^0.0.1',
        permissions: [],
        events: { emits: [{ type: 'people.noted', schemaVersion: 1 }], consumes: [] },
        migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
        attachmentTargets: [],
        entitlementKey: 'people',
      }),
      migrations: [{ version: '0001-init', sql: 'CREATE TABLE people_notes (id TEXT PRIMARY KEY)' }],
      ...undeclaredOperations('a test fixture, built to drive the host rather than declared', {
        'people/note': ((ctx, input: { subject: string; secret: string }) => {
          ctx.emit({
            type: 'people.noted',
            schemaVersion: 1,
            entity: { entityType: 'person', entityId: input.subject },
            // 'direct' — the class the HR demo's national_id is annotated with, and the
            // one an Article 17 request is actually about.
            piiClass: 'direct',
            subjectId: dataSubjectId.parse(input.subject),
            payload: { secret: input.secret },
          });
        }) as OperationHandler<never, unknown>,
      }),
    });

    await host.admin.createTenant(staff, { id: t, slug: 'shred-co', name: 'Shred Co' });
    await host.admin.grantEntitlement(staff, t, 'people');
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);

    const stub = await host.getScope(alice, t, s);
    await stub.invoke('people/note', { subject: erased, secret: 'erased-personal-data' });
    await stub.invoke('people/note', { subject: spared, secret: 'spared-personal-data' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('seals classified payloads into the stored copy — the bucket never holds the plaintext', async () => {
    const res = await app().request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth });
    expect(res.status).toBe(201);
    const backup = (await res.json()) as ScopeBackup;

    const raw = JSON.stringify(held.get(backup.capturedAt));
    // The property that makes the erasure possible later: what is at rest in the store is
    // ciphertext. A backup that held plaintext could never be reached by a shred, and
    // "erased" would mean "erased everywhere except the copies we kept".
    expect(raw).not.toContain('erased-personal-data');
    expect(raw).not.toContain('spared-personal-data');
    expect(raw).toContain('__sealed');

    // The ENVELOPE is still legible. A sealed backup must stay navigable — which row, which
    // subject, which time — or an operator cannot reason about a copy they may have to
    // restore under pressure.
    const spine = storedSpine(backup.capturedAt);
    expect(spine.map((r) => r.subjectId)).toEqual(expect.arrayContaining([erased, spared]));
  });

  it('opens the copy back to plaintext for an authorized read, before any erasure', async () => {
    const [backup] = await store.list({ tenantId: t, scopeId: s });
    const res = await app().request(
      `/tenants/${t}/scopes/${s}/backups/${encodeURIComponent(backup!.capturedAt)}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Sealing must be lossless while the keys exist, or the backup is not a backup.
    expect(body).toContain('erased-personal-data');
    expect(body).toContain('spared-personal-data');
  });

  it('shreds one subject: live spine redacted, receipt audited', async () => {
    const res = await app().request(
      `/tenants/${t}/scopes/${s}/subjects/${erased}/shred`,
      { method: 'POST', headers: auth },
    );
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as SubjectShredReceipt;
    expect(receipt).toMatchObject({ subjectId: erased, eventsRedacted: 1, tombstoned: true });
    // A key existed because the backup above minted one — so the erasure had something to
    // destroy, which is exactly the state a real DSAR arrives in.
    expect(receipt.keyDestroyed).toBe(true);

    const audit = await host.admin.auditLog(staff, { tenantId: t });
    expect(audit.some((e) => e.action === 'shredSubject')).toBe(true);
  });

  it('THE property: the copy taken BEFORE the shred can no longer name that subject', async () => {
    const [backup] = await store.list({ tenantId: t, scopeId: s });

    // The bytes never moved. Nothing rewrote the stored object; it still holds the same
    // ciphertext it held five minutes ago.
    const stillSealed = JSON.stringify(held.get(backup!.capturedAt));
    expect(stillSealed).toContain('__sealed');

    const res = await app().request(
      `/tenants/${t}/scopes/${s}/backups/${encodeURIComponent(backup!.capturedAt)}`,
      { headers: auth },
    );
    const dump = (await res.json()) as ScopeDump;
    const table = dump.tables.find((x) => x.name === '_substrat_outbox')!;
    const subject = table.columns.indexOf('subject_id');
    const payload = table.columns.indexOf('payload');

    const shredded = table.rows.filter((r) => r[subject] === erased);
    const kept = table.rows.filter((r) => r[subject] === spared);

    // Unreadable, permanently — the key that opened it is gone. This is the only mechanism
    // that reaches into an immutable store, and it is why the mechanism exists.
    expect(shredded).toHaveLength(1);
    expect(shredded[0]![payload]).toBeNull();

    // And the same copy still restores everyone else. An erasure that cost the backup its
    // other subjects would be a different failure wearing compliance as a disguise.
    expect(kept).toHaveLength(1);
    expect(String(kept[0]![payload])).toContain('spared-personal-data');
  });

  it('a copy taken AFTER the shred cannot re-seal the tombstoned subject', async () => {
    const res = await app().request(`/tenants/${t}/scopes/${s}/backups`, { method: 'POST', headers: auth });
    const backup = (await res.json()) as ScopeBackup;

    const spine = storedSpine(backup.capturedAt);
    // Two independent reasons this row is empty, and both must hold: the live payload was
    // redacted, and the sealer refuses to mint a key for a tombstoned subject. Either one
    // failing alone would put that person back into the next backup.
    expect(spine.find((r) => r.subjectId === erased)!.payload).toBeNull();
    expect(String(spine.find((r) => r.subjectId === spared)!.payload)).toContain('__sealed');
  });

  it('restores a sealed copy into a DIFFERENT scope by opening it with the origin\'s keys', async () => {
    // Subject keys are keyed by (scope, subject), so a copy of scope A landing in scope B
    // has to be opened with A's keys. Opening with the destination's would find no key,
    // null every payload, and report a successful restore — the quietest possible data
    // loss, and the reason the route reads the dump's own provenance rather than the URL.
    const dest = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: dest });
    await host.admin.activateScope(staff, t, dest);

    // The sealed bytes as the store holds them — deliberately NOT the opened GET.
    const [backup] = await store.list({ tenantId: t, scopeId: s });
    const sealedDump = held.get(backup!.capturedAt)!;
    expect(JSON.stringify(sealedDump)).toContain('__sealed');

    const res = await app().request(`/tenants/${t}/scopes/${dest}/restore`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(sealedDump),
    });
    expect(res.status).toBe(200);

    // The spared subject's payload survived the move intact; the shredded one is still
    // gone, because a key destroyed in the origin scope stays destroyed wherever the copy
    // is carried.
    const landed = (await host.admin.exportScope(staff, t, dest)).tables.find(
      (x) => x.name === '_substrat_outbox',
    )!;
    const subject = landed.columns.indexOf('subject_id');
    const payload = landed.columns.indexOf('payload');
    const keptRow = landed.rows.find((r) => r[subject] === spared)!;
    const shreddedRow = landed.rows.find((r) => r[subject] === erased)!;
    expect(String(keptRow[payload])).toContain('spared-personal-data');
    expect(shreddedRow[payload]).toBeNull();
  });

  it('restores from a source this host does not know, and says the store replay is incomplete (#2207)', async () => {
    // The erasure replay lists the source's tombstones. A source that is not a scope of this
    // tenant here (another host's backup, an upload, a deleted snapshot) has none to read: the
    // restore still lands, and the answer says so rather than refusing it.
    const erasedHere: string[] = [];
    const storeDir = mkdtempSync(join(tmpdir(), 'cp-replay-'));
    const storeHost = new SqliteScopeHost({
      dir: storeDir,
      scopeStores: {
        runners: [{
          binding: 'GRAPH',
          runner: {
            kind: 'counter',
            async start() {},
            async stop() {},
            async invoke(_address, request) {
              if (request.operation === 'substrat.erase') {
                erasedHere.push(String(Reflect.get(request.input ?? {}, 'subjectId')));
                return { result: { erased: 1 } };
              }
              if (request.operation === 'substrat.export') return { result: { tables: [] } };
              if (request.operation === 'substrat.import') return { result: { tables: 0 } };
              return { result: {} };
            },
          },
        }],
      },
    });
    try {
      const target = scopeId.parse(ulid());
      await storeHost.admin.createTenant(staff, { id: t, slug: 'replay-co', name: 'Replay Co' });
      await storeHost.provisionScope(staff, { tenantId: t, scopeId: target, vertical: 'docs' });
      await storeHost.admin.activateScope(staff, t, target);
      const own = ulid();
      await storeHost.admin.shredSubject(staff, t, target, own);
      const dump = { ...(await storeHost.admin.exportScope(staff, t, target)), scopeId: scopeId.parse(ulid()) };
      const api = createControlPlaneApi({ host: storeHost, authenticate: UNSAFE_devPlatformActorAuth() });
      const res = await api.request(`/tenants/${t}/scopes/${target}/restore`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(dump),
      });
      const body = await res.json();
      expect(body, JSON.stringify(body)).toMatchObject({ restored: target, storeErasuresReplayed: 1, incomplete: true, sourceUnknown: true });
      expect(erasedHere).toContain(own);
    } finally {
      await storeHost.close();
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('a restore on a host with no stores answers as it always did', async () => {
    const dest = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: dest });
    await host.admin.activateScope(staff, t, dest);
    const dump = { ...(await host.admin.exportScope(staff, t, dest)), scopeId: scopeId.parse(ulid()) };
    const res = await app().request(`/tenants/${t}/scopes/${dest}/restore`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(dump),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: dest, tables: dump.tables.length });
  });

  it('refuses a subject id that is not a ULID, before it reaches the UPDATE', async () => {
    const res = await app().request(`/tenants/${t}/scopes/${s}/subjects/%25/shred`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(400);
  });

  it('fails closed on an unknown scope', async () => {
    const ghost = scopeId.parse(ulid());
    const res = await app().request(`/tenants/${t}/scopes/${ghost}/subjects/${erased}/shred`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it('does not ask the stores to erase when the version declares none, with a kind registered', async () => {
    if (!docsRegistered) {
      await host.admin.registerVertical(staff, { slug: 'docs', name: 'docs', source: 'cli' });
      docsRegistered = true;
    }
    const versionId = ulid();
    await host.admin.publishVersion(staff, {
      id: versionId, verticalSlug: 'docs', version: `1.0.${versionId.slice(-4).toLowerCase()}`, manifestDigest: `m-${versionId}`,
      permissionDigest: 'p', migrationDigest: 'g', deploymentRef: `docs-${versionId.toLowerCase()}`,
      manifestJson: JSON.stringify({
        version: '1.0.0', entry: 'worker.js', compatibilityDate: '2025-01-01',
        digests: { manifest: 'm', permission: 'p', migration: 'g' },
      }),
    });
    await host.admin.admitVersion(staff, versionId);
    const scoped = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: scoped, vertical: 'docs' });
    await host.admin.activateScope(staff, t, scoped);
    await host.admin.bindScopeVersion(staff, t, scoped, versionId);
    const asked: string[] = [];
    const refuse = unreachablePlatformScopeStores();
    const api = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeKinds: [graphKind],
      resolveVerticalRef: async () => ({
        redactSubject: async () => ({
          events: 0, intents: 0, jobRuns: 0, idempotencyResults: 0, intentIds: [],
          vertical: { verticalRows: [], hookRows: [], unreachedEntities: [] },
        }),
      }) as never,
      platformScopeStores: {
        ...refuse,
        eraseSubject: async (input) => {
          asked.push(`${input.scopeId}/${input.subjectId}`);
          return refuse.eraseSubject(input);
        },
      },
    });
    const res = await api.request(`/tenants/${t}/scopes/${scoped}/subjects/${erased}/shred`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(asked).toEqual([]);
  });

  /** A version of `docs` that declares one graph store, and a scope of `docs` bound to it. */
  let docsRegistered = false;
  const graphScope = async (): Promise<ScopeId> => {
    if (!docsRegistered) {
      await host.admin.registerVertical(staff, { slug: 'docs', name: 'docs', source: 'cli' });
      docsRegistered = true;
    }
    const versionId = ulid();
    await host.admin.publishVersion(staff, {
      id: versionId, verticalSlug: 'docs', version: `1.0.${versionId.slice(-4).toLowerCase()}`, manifestDigest: `m-${versionId}`,
      permissionDigest: 'p', migrationDigest: 'g', deploymentRef: `docs-${versionId.toLowerCase()}`,
      manifestJson: JSON.stringify({
        version: '1.0.0', entry: 'worker.js', compatibilityDate: '2025-01-01',
        digests: { manifest: 'm', permission: 'p', migration: 'g' },
        scopeStores: [{ binding: 'GRAPH', kind: 'graph' }],
      }),
    });
    await host.admin.admitVersion(staff, versionId);
    const scoped = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: scoped, vertical: 'docs' });
    await host.admin.activateScope(staff, t, scoped);
    await host.admin.bindScopeVersion(staff, t, scoped, versionId);
    return scoped;
  };
  const graphTable = { name: 'nodes', ddl: 'CREATE TABLE nodes(id TEXT)', columns: ['id'], rows: [['a']] };
  /** A registered graph kind: with none registered no store can exist (`mayHoldScopeStores`, #2242). */
  const graphKind: StoreKindRegistration = {
    kind: 'graph',
    runtime: 'python',
    className: 'Graph',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
    publishers: 'staff',
  };

  /** The control plane against a hosted `docs`, its stores reached through the platform. */
  const hosted = (calls: { imported: unknown[][]; erased: string[]; failErase?: boolean }, tables: number) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeKinds: [graphKind],
      verticals: {
        docs: {
          restoreScope: async () => ({ tables }),
          snapshotScope: async () => ({}),
        },
      } as never,
      platformScopeStores: {
        exportStores: async () => [{ binding: 'GRAPH', kind: 'graph', tables: [graphTable] }],
        eraseSubject: async ({ subjectId }) => {
          if (calls.failErase) throw new Error('store unavailable');
          calls.erased.push(subjectId);
          return [{ binding: 'GRAPH', erased: 1 }];
        },
        wipeStores: async () => undefined,
        sizeStores: async () => [],
        importStores: async (input) => {
          calls.imported.push(input.stores);
        },
      },
    });

  it('a hosted restore imports the dump stores through the platform, not the vertical', async () => {
    const scoped = await graphScope();
    const dump = await host.admin.exportScope(staff, t, scoped);
    const calls = { imported: [] as unknown[][], erased: [] as string[] };
    const res = await hosted(calls, dump.tables.length).request(`/tenants/${t}/scopes/${scoped}/restore`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...dump, stores: [{ binding: 'GRAPH', kind: 'graph', tables: [graphTable] }] }),
    });
    expect(res.status).toBe(200);
    expect(calls.imported).toEqual([[{ binding: 'GRAPH', kind: 'graph', tables: [graphTable] }]]);
  });

  it("refuses, before any write, a dump store the destination's version does not declare (#2207)", async () => {
    const scoped = await graphScope();
    const dump = await host.admin.exportScope(staff, t, scoped);
    const audited = async () => (await host.admin.auditLog(staff, { tenantId: t, action: 'restoreScope' })).length;
    const before = await audited();
    for (const [store, says] of [
      [{ binding: 'OTHER', kind: 'graph', tables: [graphTable] }, /'OTHER', which this scope's version does not declare/],
      [{ binding: 'GRAPH', kind: 'counter', tables: [graphTable] }, /is a 'counter', and this scope's version declares a 'graph'/],
    ] as const) {
      const calls = { imported: [] as unknown[][], erased: [] as string[] };
      const res = await hosted(calls, dump.tables.length).request(`/tenants/${t}/scopes/${scoped}/restore`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ...dump, stores: [store] }),
      });
      expect(res.status).toBe(422);
      expect((await res.json() as { error: string }).error).toMatch(says);
      expect(calls.imported).toEqual([]);
    }
    expect(await audited()).toBe(before);
  });

  it("a hosted snapshot reports its fork's erasure replay, as a restore does (#2207)", async () => {
    const scoped = await graphScope();
    const gone = ulid();
    await host.admin.shredSubject(staff, t, scoped, gone);
    const done = { imported: [] as unknown[][], erased: [] as string[] };
    const ok = await hosted(done, 0).request(`/tenants/${t}/scopes/${scoped}/snapshots`, { method: 'POST', headers: auth, body: '{}' });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ forkedFrom: scoped, storeErasuresReplayed: 1 });
    expect(done.erased).toContain(gone);

    const failing = { imported: [] as unknown[][], erased: [] as string[], failErase: true };
    const short = await hosted(failing, 0).request(`/tenants/${t}/scopes/${scoped}/snapshots`, { method: 'POST', headers: auth, body: '{}' });
    expect(short.status).toBe(201);
    const body = await short.json();
    expect(body).toMatchObject({ forkedFrom: scoped, storeErasuresReplayed: 0, incomplete: true });
    expect(body).not.toHaveProperty('sourceUnknown');
  });

  /*
   * #2207: an ordinary install rides its vertical's serving pin and has no bound version
   * (provisioning sets `serving_ref`, only a bind sets `vertical_version_id`). The router reads
   * its stores from the serving version, so every control-plane path has to read the same one,
   * or a backup, a reap, a restore and an erasure all skip a store the router writes to.
   */
  describe('a serving-pinned install with a store (#2207)', () => {
    const SERVED = 'served';
    const SERVING_REF = 'served-stable';
    const redaction = {
      events: 0, intents: 0, jobRuns: 0, idempotencyResults: 0, intentIds: [],
      vertical: { verticalRows: [], hookRows: [], unreachedEntities: [] },
    };
    type Calls = { exported: string[]; imported: string[]; erased: string[]; wiped: string[] };
    const recording = (calls: Calls): PlatformScopeStores => ({
      exportStores: async ({ scopeId: s2, stores }) => {
        calls.exported.push(s2);
        return stores.map((store) => ({ ...store, tables: [graphTable] }));
      },
      importStores: async ({ scopeId: s2 }) => {
        calls.imported.push(s2);
      },
      eraseSubject: async ({ subjectId, stores }) => {
        calls.erased.push(subjectId);
        return stores.map((store) => ({ binding: store.binding, erased: 1 }));
      },
      wipeStores: async ({ scopeId: s2 }) => {
        calls.wiped.push(s2);
      },
      sizeStores: async () => [],
    });
    const api = (stores: PlatformScopeStores, kinds: readonly unknown[] = [graphKind]) =>
      createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        scopeBackups: store,
        platformScopeStores: stores,
        storeKinds: kinds as never,
        resolveVerticalRef: async () => ({
          redactSubject: async () => redaction,
          deleteScope: async () => undefined,
          snapshotScope: async () => ({}),
          restoreScope: async (_s: unknown, tables: unknown[]) => ({ tables: tables.length }),
          exportScope: async (s2: ScopeId) => (await host.admin.exportScope(staff, tenantOf.get(s2) ?? t, s2)).tables,
        }) as never,
      });
    const fresh = () => ({ exported: [], imported: [], erased: [], wiped: [] } as Calls);

    beforeAll(async () => {
      await host.admin.registerVertical(staff, { slug: SERVED, name: SERVED, source: 'cli' });
      const versionId = ulid();
      await host.admin.publishVersion(staff, {
        id: versionId, verticalSlug: SERVED, version: '1.0.0', manifestDigest: `m-${versionId}`,
        permissionDigest: 'p', migrationDigest: 'g', deploymentRef: `${SERVED}-${versionId.toLowerCase()}`,
        manifestJson: JSON.stringify({
          version: '1.0.0', entry: 'worker.js', compatibilityDate: '2025-01-01',
          digests: { manifest: 'm', permission: 'p', migration: 'g' },
          scopeStores: [{ binding: 'GRAPH', kind: 'graph' }],
        }),
      });
      await host.admin.admitVersion(staff, versionId);
      await host.admin.setVerticalServing(staff, SERVED, { ref: SERVING_REF, versionId, doClasses: ['ScopeDO'], migrationTag: 'v1' });
    });

    const tenantOf = new Map<ScopeId, typeof t>();
    const install = async (tenant = t): Promise<ScopeId> => {
      const scoped = scopeId.parse(ulid());
      tenantOf.set(scoped, tenant);
      await host.provisionScope(staff, { tenantId: tenant, scopeId: scoped, vertical: SERVED });
      await host.admin.activateScope(staff, tenant, scoped);
      return scoped;
    };

    it('is the shape provisioning leaves: the serving pin, and no bound version', async () => {
      const record = await host.admin.getScopeRecord(staff, t, await install());
      expect(record).toMatchObject({ servingRef: SERVING_REF, verticalVersionId: null });
    });

    it('is backed up WITH its store', async () => {
      const scoped = await install();
      const calls = fresh();
      const res = await api(recording(calls)).request(`/tenants/${t}/scopes/${scoped}/backups`, { method: 'POST', headers: auth });
      expect(res.status).toBeLessThan(300);
      expect(calls.exported).toEqual([scoped]);
      const taken = [...held.values()].find((d) => d.scopeId === scoped);
      expect(taken!.stores).toEqual([{ binding: 'GRAPH', kind: 'graph', tables: [graphTable] }]);
    });

    it('is carried WITH its store in a full tenant export (Art. 20)', async () => {
      // A tenant of its own: the export reads every scope of the tenant.
      const own = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: own, slug: `export-${own.toLowerCase()}`, name: 'Export' });
      const scoped = await install(own);
      const calls = fresh();
      const res = await api(recording(calls)).request(`/tenants/${own}/export?full=true`, { headers: auth });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { data: { scopeId: string; stores: unknown[] }[] };
      expect(calls.exported).toContain(scoped);
      expect(body.data.find((d) => d.scopeId === scoped)?.stores).toEqual([{ binding: 'GRAPH', kind: 'graph', tables: [graphTable] }]);
    });

    it('asks the store on a shred, and the receipt names it', async () => {
      const scoped = await install();
      const calls = fresh();
      const who = ulid();
      const res = await api(recording(calls)).request(`/tenants/${t}/scopes/${scoped}/subjects/${who}/shred`, { method: 'POST', headers: auth });
      expect(res.status).toBe(200);
      expect(calls.erased).toEqual([who]);
      expect((await res.json() as SubjectShredReceipt).storeErasures).toEqual([{ binding: 'GRAPH', erased: 1 }]);
    });

    it('is restored WITH the erasure replay', async () => {
      const scoped = await install();
      const dump = await host.admin.exportScope(staff, t, scoped);
      const who = ulid();
      await host.admin.shredSubject(staff, t, scoped, who);
      const calls = fresh();
      const res = await api(recording(calls)).request(`/tenants/${t}/scopes/${scoped}/restore`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ...dump, stores: [{ binding: 'GRAPH', kind: 'graph', tables: [graphTable] }] }),
      });
      expect(res.status).toBe(200);
      expect(calls.imported).toEqual([scoped]);
      expect(calls.erased).toEqual([who]);
      expect(await res.json()).toMatchObject({ storeErasuresReplayed: 1 });
    });

    it('is reaped WITH the wipe', async () => {
      const scoped = await install();
      await host.admin.archiveScope(staff, t, scoped);
      const calls = fresh();
      const res = await api(recording(calls)).request(`/tenants/${t}/scopes/${scoped}/reap`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ backup: false }),
      });
      expect(res.status, await res.clone().text()).toBeLessThan(300);
      expect(calls.wiped).toEqual([scoped]);
    });

    it('a control plane with no route to the stores refuses the reap and keeps the scope (503)', async () => {
      const scoped = await install();
      await host.admin.archiveScope(staff, t, scoped);
      const res = await api(unreachablePlatformScopeStores()).request(`/tenants/${t}/scopes/${scoped}/reap`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ backup: false }),
      });
      expect(res.status).toBe(503);
      expect((await host.admin.getScopeRecord(staff, t, scoped))?.status).toBe('archived');
    });

    // Every path that reaches the stores refuses when it cannot, rather than carrying on
    // as if the declared store held nothing. Each expectation fails if its 503 is swallowed.
    it('a control plane with no route to the stores refuses on every path, rather than skipping the store', async () => {
      const none = api(unreachablePlatformScopeStores());
      const scoped = await install();
      const backup = await none.request(`/tenants/${t}/scopes/${scoped}/backups`, { method: 'POST', headers: auth });
      expect(backup.status, 'backup').toBe(503);
      const pull = await none.request(`/tenants/${t}/scopes/${scoped}/export?full=true`, { headers: auth });
      expect(pull.status, 'full pull').toBe(503);
      const own = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: own, slug: `none-${own.toLowerCase()}`, name: 'None' });
      await install(own);
      const tenantExport = await none.request(`/tenants/${own}/export?full=true`, { headers: auth });
      expect(tenantExport.status, 'full tenant export').toBe(503);
      const snap = await none.request(`/tenants/${t}/scopes/${scoped}/snapshots`, { method: 'POST', headers: auth, body: '{}' });
      expect(snap.status, 'snapshot').toBe(503);
      const who = ulid();
      const shred = await none.request(`/tenants/${t}/scopes/${scoped}/subjects/${who}/shred`, { method: 'POST', headers: auth });
      expect(shred.status, 'shred').toBe(503);
      expect((await host.admin.listShreddedSubjects(staff, t, scoped)).subjects).not.toContain(who);
      const dump = await host.admin.exportScope(staff, t, scoped);
      const withStore = await none.request(`/tenants/${t}/scopes/${scoped}/restore`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ...dump, stores: [{ binding: 'GRAPH', kind: 'graph', tables: [graphTable] }] }),
      });
      expect(withStore.status, 'restore of a dump store').toBe(503);
      // The replay runs after the data landed, so it reports rather than refuses.
      await host.admin.shredSubject(staff, t, scoped, ulid());
      const replayed = await none.request(`/tenants/${t}/scopes/${scoped}/restore`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(dump),
      });
      expect(replayed.status, 'restore replay').toBe(200);
      expect(await replayed.json(), 'restore replay').toMatchObject({ storeErasuresReplayed: 0, incomplete: true });
      await host.admin.archiveScope(staff, t, scoped);
      const reap = await none.request(`/tenants/${t}/scopes/${scoped}/reap`, { method: 'POST', headers: auth, body: JSON.stringify({ backup: false }) });
      expect(reap.status, 'reap').toBe(503);
      expect((await host.admin.getScopeRecord(staff, t, scoped))?.status).toBe('archived');
    });

    it('a version that cannot be told refuses once a kind is registered, and proceeds while none is', async () => {
      // A scope with a vertical and neither a serving pin nor a bound version: nothing says
      // what it runs. With no kind registered no store can exist, as before stores.
      await host.admin.registerVertical(staff, { slug: 'unserved', name: 'unserved', source: 'cli' });
      const scoped = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: scoped, vertical: 'unserved' });
      await host.admin.activateScope(staff, t, scoped);
      const record = await host.admin.getScopeRecord(staff, t, scoped);
      expect(record?.servingRef ?? null).toBeNull();
      expect(record?.verticalVersionId ?? null).toBeNull();
      const backup = (kinds: readonly unknown[]) =>
        api(recording(fresh()), kinds).request(`/tenants/${t}/scopes/${scoped}/backups`, { method: 'POST', headers: auth });
      expect((await backup([graphKind])).status).toBe(503);
      expect((await backup([])).status).toBeLessThan(300);
      const who = ulid();
      const shred = await api(recording(fresh()), [graphKind]).request(`/tenants/${t}/scopes/${scoped}/subjects/${who}/shred`, { method: 'POST', headers: auth });
      expect(shred.status).toBe(503);
      const marks = await host.admin.listShreddedSubjects(staff, t, scoped);
      expect(marks.subjects).not.toContain(who);
    });

    it("refuses an undeclared dump store before the destination's own data is touched", async () => {
      const scoped = await install();
      const before = await host.admin.exportScope(staff, t, scoped);
      const stub = await host.getScope(alice, t, scoped);
      await stub.invoke('people/note', { subject: ulid(), secret: 'written-after-the-dump' });
      const res = await api(recording(fresh())).request(`/tenants/${t}/scopes/${scoped}/restore`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ...before, stores: [{ binding: 'OTHER', kind: 'graph', tables: [graphTable] }] }),
      });
      expect(res.status).toBe(422);
      // A restore of `before` would have rewound the note away.
      const outbox = (await host.admin.exportScope(staff, t, scoped)).tables.find((x) => x.name === '_substrat_outbox')!;
      expect(JSON.stringify(outbox.rows)).toContain('written-after-the-dump');
    });
  });
});
