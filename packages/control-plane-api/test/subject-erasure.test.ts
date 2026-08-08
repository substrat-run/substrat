import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox, type OperationHandler } from '@substrat-run/kernel';
import {
  dataSubjectId,
  moduleManifest,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ScopeBackup,
  type ScopeDump,
  type SubjectShredReceipt,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
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
      operations: {
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
      },
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
});
