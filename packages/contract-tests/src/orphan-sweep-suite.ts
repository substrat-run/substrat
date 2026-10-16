/**
 * Contract suite for the orphan-byte sweep (#2314) — `host.sweepOrphanAttachments` over a real
 * scope and a real attachment store, on both adapters.
 *
 * What it pins, in one sentence: **a pass deletes an attachment object only when no row names
 * it, it is older than the grace period and the scope is clear of its restore fence, and a row
 * that commits never loses its bytes — not to a pass racing its upload, not to a pass after a
 * restore took the row away, not to a pass run by a copy of the scope.**
 *
 * Each guard is held by a case where it is the ONLY one that stands between a row and the loss of
 * its bytes, so taking that guard away fails that case:
 *
 * 1. **The tombstone.** An upload is held between its `put` and its row while a pass whose clock
 *    makes the object old enough runs: the pass condemns and deletes the object, and the row is
 *    then refused (`conflict`, `attachment_condemned`), so the upload fails and nothing commits
 *    without its bytes. A dump load that would bring back a row for a condemned id is refused too.
 * 2. **The age floor.** The same held upload, with a pass whose clock leaves the object young: it
 *    is never condemned, and the upload commits with its bytes.
 * 3. **The restore fence.** A restore takes a committed row away; a pass inside the fence deletes
 *    nothing, and restoring the row back finds its bytes. Past the fence the orphan is swept.
 * 4. **The copy.** A pass asked of a fork, or for a tenant the scope was not provisioned for, is
 *    refused and deletes nothing, though every object there looks rowless to it.
 *
 * Plus what every pass must also hold: only this scope's attachment keys are judged (other
 * scopes' keys, other features' keys and malformed keys in the same bucket are untouched), and a
 * dry run deletes and condemns nothing.
 *
 * Time: a pass takes its instant as an argument, so "eight days later" is a pass whose `now` is
 * eight days ahead of the ids the uploads minted. Nothing sleeps.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type AttachmentRecord,
  type EntityRef,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  ATTACHMENT_CONDEMNED,
  ORPHAN_SWEEP_FENCE_MS,
  ORPHAN_SWEEP_GRACE_MS,
  attachmentBlobKey,
  attachmentSweepFenceKey,
  ulid,
  type ScopeHost,
  type TenantBlobStore,
} from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { UPL_READ, UPL_WRITE, uploadLinkMod } from './upload-link-module.js';

/** What the suite needs beyond a host: the tenant's raw attachment store, and a hold on its puts. */
export interface OrphanSweepFixture extends ScopeHostFixture {
  /** The attachment store the host writes `tenant`'s bytes to, unwrapped. */
  blobs(tenant: TenantId): Promise<TenantBlobStore>;
  /**
   * Run `hook` after each attachment-store `put` has landed and before the put returns to the
   * host, so a test can hold an upload between its bytes and its row. `null` removes it.
   */
  afterPut(hook: ((key: string) => Promise<void>) | null): void;
}

const DAY = 86_400_000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const at = (ms: number): string => new Date(ms).toISOString();

/** A ULID minted at `ms`, as an upload at that instant would have minted it. */
const idAt = (ms: number): string => {
  let t = ms;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  return time + Array.from({ length: 16 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join('');
};

const refusal = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
const reasonOf = (e: unknown): string | undefined => {
  const r = (e as { extensions?: { reason?: unknown } } | undefined)?.extensions?.reason;
  return typeof r === 'string' ? r : undefined;
};

export function orphanSweepContractSuite(adapterName: string, makeFixture: () => Promise<OrphanSweepFixture>): void {
  describe(`orphan attachment sweep: ${adapterName}`, () => {
    let fixture: OrphanSweepFixture;
    let host: ScopeHost;
    let store: TenantBlobStore;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid());
    const t2 = tenantId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    let n = 0;
    const udoc = (): EntityRef => ({ entityType: 'udoc', entityId: `doc-${++n}` });
    const files = async (scope: ScopeId) => host.attachments(alice, t1, scope);
    const upload = async (entity: EntityRef, body: string, scope: ScopeId = s1): Promise<AttachmentRecord> =>
      (await files(scope)).upload({ entity, filename: 'a.txt', contentType: 'text/plain', visibility: 'internal', body: bytes(body) });
    const sweep = (now: number, opts: { dryRun?: boolean; tenant?: TenantId; scope?: ScopeId } = {}) => {
      if (!host.sweepOrphanAttachments) throw new Error('host has no sweepOrphanAttachments');
      return host.sweepOrphanAttachments(opts.tenant ?? t1, opts.scope ?? s1, {
        now: at(now),
        ...(opts.dryRun ? { dryRun: true } : {}),
      });
    };
    /** Plant an object no row names, minted at `ms`. */
    const plant = async (ms: number, scope: ScopeId = s1): Promise<string> => {
      const id = idAt(ms);
      await store.put(attachmentBlobKey(scope, id), bytes('orphan'), { contentType: 'text/plain' });
      return id;
    };
    const present = async (key: string): Promise<boolean> => (await store.get(key)) !== null;
    /** A scope of its own: a restore fences the scope it lands in, which would hold later cases. */
    const freshScope = async (): Promise<ScopeId> => {
      const id = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t1, scopeId: id, vertical: 'osw-vertical' });
      await host.admin.activateScope(staff, t1, id);
      return id;
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(uploadLinkMod);
      await host.admin.createTenant(staff, { id: t1, slug: `osw-${t1.toLowerCase()}`, name: 'Orphan sweep' });
      await host.admin.grantEntitlement(staff, t1, 'upl');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'osw-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.provisionScope(staff, { tenantId: t1, scopeId: s2, vertical: 'osw-vertical' });
      await host.admin.activateScope(staff, t1, s2);
      await host.provisionBlobStore(staff, { tenantId: t1, vertical: 'osw-vertical', binding: 'ATTACHMENTS' });
      await host.admin.defineRole(staff, t1, { key: 'owner', permissions: [UPL_READ, UPL_WRITE], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t1, scopeId: null } });
      await host.admin.createTenant(staff, { id: t2, slug: `osw-${t2.toLowerCase()}`, name: 'Orphan sweep, elsewhere' });
      // Opening the attachment surface opens the tenant's store, which a fixture may need first.
      await files(s1);
      store = await fixture.blobs(t1);
    });

    afterAll(async () => {
      fixture.afterPut(null);
      await fixture.cleanup();
    });

    it('deletes an aged object no row names, and keeps the committed file, the young object and every foreign key', async () => {
      const doc = udoc();
      const kept = await upload(doc, 'committed');
      const now = Date.now();
      const orphan = await plant(now);
      const young = await plant(now + ORPHAN_SWEEP_GRACE_MS + DAY / 2);
      const foreign = [
        attachmentBlobKey(s2, idAt(now)), // another scope of the tenant
        `scope/${s1}/exports/${idAt(now)}`, // another feature's key, same scope
        `scope/${s1}/att/not-a-ulid`,
        `scope/${s1}/att/${idAt(now)}/nested`,
        `elsewhere/${idAt(now)}`,
      ];
      for (const key of foreign) await store.put(key, bytes('not mine'));

      const report = await sweep(now + ORPHAN_SWEEP_GRACE_MS + DAY);
      expect(report).toMatchObject({ deleted: 1, orphans: 1, dryRun: false });
      expect(report.keys).toEqual([attachmentBlobKey(s1, orphan)]);
      expect(await present(attachmentBlobKey(s1, orphan))).toBe(false);
      expect(await present(attachmentBlobKey(s1, young))).toBe(true);
      for (const key of foreign) expect(await present(key)).toBe(true);
      const opened = await (await files(s1)).open(kept.id);
      expect(text(opened!.body)).toBe('committed');

      // Idempotent: a second pass over the same state deletes nothing more.
      const again = await sweep(now + ORPHAN_SWEEP_GRACE_MS + DAY);
      expect(again.deleted).toBe(0);
      await store.delete(attachmentBlobKey(s1, young));
      for (const key of foreign) await store.delete(key);
    });

    it('a dry run deletes nothing and condemns nothing, and names what a pass would delete', async () => {
      const now = Date.now();
      const orphan = await plant(now);
      const report = await sweep(now + ORPHAN_SWEEP_GRACE_MS + DAY, { dryRun: true });
      expect(report).toMatchObject({ dryRun: true, deleted: 0 });
      expect(report.keys).toContain(attachmentBlobKey(s1, orphan));
      expect(await present(attachmentBlobKey(s1, orphan))).toBe(true);
      // Nothing was condemned: a dump that names the id still loads (the tombstone would refuse it).
      const real = await sweep(now + ORPHAN_SWEEP_GRACE_MS + DAY);
      expect(real.keys).toContain(attachmentBlobKey(s1, orphan));
    });

    describe('guard 1, the tombstone: an upload racing a pass never commits without its bytes', () => {
      it('a pass that condemns an in-flight object refuses the row, and the upload fails', async () => {
        const doc = udoc();
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let landed!: (key: string) => void;
        const putLanded = new Promise<string>((r) => (landed = r));
        fixture.afterPut(async (key) => {
          if (!key.startsWith(`scope/${s1}/att/`)) return;
          fixture.afterPut(null);
          landed(key);
          await held;
        });
        const uploading = refusal(upload(doc, 'in flight'));
        const key = await putLanded;
        // A clock far enough ahead that the age floor does not protect it: only the tombstone does.
        const report = await sweep(Date.now() + ORPHAN_SWEEP_GRACE_MS + DAY);
        expect(report.keys).toContain(key);
        expect(await present(key)).toBe(false);
        release();
        const err = await uploading;
        expect(errorCodeOf(err)).toBe('conflict');
        expect(reasonOf(err)).toBe(ATTACHMENT_CONDEMNED);
        // The property: no row names bytes that are gone.
        expect(await (await files(s1)).list(doc)).toEqual([]);
      });

      it('a dump load that would bring back a row for a condemned id is refused, and leaves the scope as it was', async () => {
        const s4 = await freshScope();
        const doc = udoc();
        const record = await upload(doc, 'template', s4);
        const now = Date.now();
        const orphan = await plant(now, s4);
        const swept = await sweep(now + ORPHAN_SWEEP_GRACE_MS + DAY, { scope: s4 });
        expect(swept.keys).toContain(attachmentBlobKey(s4, orphan));
        // A dump of this scope, with a row for the condemned id written in beside the real one.
        const dump = await host.admin.exportScope(staff, t1, s4);
        const table = dump.tables.find((t) => t.name === '_substrat_attachments')!;
        const row = table.rows.find((r) => r[table.columns.indexOf('id')] === record.id)!;
        const forged = [...row];
        forged[table.columns.indexOf('id')] = orphan;
        table.rows.push(forged);
        const err = await refusal(host.restoreScope(staff, t1, s4, dump));
        // The admin restore's refusal reaches the caller as its message on the hosted adapter (a
        // throw over the DO's RPC keeps little else), so the words are what is held here.
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('orphan sweep condemned');
        expect((err as Error).message).toContain(orphan);
        expect((await (await files(s4)).list(doc)).map((r) => r.id)).toEqual([record.id]);
        // The positive twin: the same dump without the forged row loads.
        table.rows.pop();
        await host.restoreScope(staff, t1, s4, dump);
        expect((await (await files(s4)).list(doc)).map((r) => r.id)).toEqual([record.id]);
      });
    });

    describe('guard 2, the age floor: an in-flight upload is never condemned', () => {
      it('a pass whose clock leaves the object young does not touch it, and the upload commits with its bytes', async () => {
        const doc = udoc();
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let landed!: (key: string) => void;
        const putLanded = new Promise<string>((r) => (landed = r));
        fixture.afterPut(async (key) => {
          if (!key.startsWith(`scope/${s1}/att/`)) return;
          fixture.afterPut(null);
          landed(key);
          await held;
        });
        const uploading = upload(doc, 'young and in flight');
        const key = await putLanded;
        const report = await sweep(Date.now() + ORPHAN_SWEEP_GRACE_MS - DAY);
        expect(report.keys).not.toContain(key);
        release();
        const record = await uploading;
        const opened = await (await files(s1)).open(record.id);
        expect(text(opened!.body)).toBe('young and in flight');
      });
    });

    describe('guard 3, the restore fence: a row a restore took away keeps its bytes', () => {
      it('inside the fence nothing is deleted, the row comes back with its bytes, and past it the orphan goes', async () => {
        // A scope of its own, so no fence another case wrote is in play.
        const s3 = await freshScope();
        const before = await host.admin.exportScope(staff, t1, s3);
        const doc = udoc();
        const record = await upload(doc, 'restorable', s3);
        const after = await host.admin.exportScope(staff, t1, s3);
        // The restore takes the row away; its bytes stay, now an orphan to any pass.
        await host.restoreScope(staff, t1, s3, before);
        expect(await (await files(s3)).list(doc)).toEqual([]);
        expect(await present(attachmentSweepFenceKey(s3))).toBe(true);
        const key = attachmentBlobKey(s3, record.id);

        const inside = await sweep(Date.now() + ORPHAN_SWEEP_GRACE_MS + DAY, { scope: s3 });
        expect(inside.deleted).toBe(0);
        expect(inside.fencedUntil).toEqual(expect.any(String));
        expect(await present(key)).toBe(true);

        // Undo the restore: the row is back, and so are its bytes.
        await host.restoreScope(staff, t1, s3, after);
        const opened = await (await files(s3)).open(record.id);
        expect(text(opened!.body)).toBe('restorable');

        // The positive twin: rewound again, a pass past the fence sweeps the orphan.
        await host.restoreScope(staff, t1, s3, before);
        const past = await sweep(Date.now() + ORPHAN_SWEEP_FENCE_MS + DAY, { scope: s3 });
        expect(past.keys).toEqual([key]);
        expect(await present(key)).toBe(false);
      });
    });

    describe('guard 4, the copy: only the scope itself judges its bytes', () => {
      it('a pass for a tenant the scope was not provisioned for is refused and deletes nothing', async () => {
        const now = Date.now();
        const orphan = await plant(now);
        const err = await refusal(sweep(now + ORPHAN_SWEEP_GRACE_MS + DAY, { tenant: t2 }));
        expect(err).toBeInstanceOf(Error);
        expect(['conflict', 'not_found']).toContain(errorCodeOf(err));
        expect(await present(attachmentBlobKey(s1, orphan))).toBe(true);
        await sweep(now + ORPHAN_SWEEP_GRACE_MS + DAY);
      });

      it('a pass asked of a fork is refused and deletes nothing, though every object there is rowless to it', async () => {
        const fork = await host.snapshotScope(staff, t1, s1);
        const now = Date.now();
        const orphan = await plant(now, fork);
        const err = await refusal(sweep(now + ORPHAN_SWEEP_GRACE_MS + DAY, { scope: fork }));
        expect(errorCodeOf(err)).toBe('conflict');
        expect(await present(attachmentBlobKey(fork, orphan))).toBe(true);
        // The positive twin: the scope it was copied from sweeps its own orphan.
        const mine = await plant(now);
        const report = await sweep(now + ORPHAN_SWEEP_GRACE_MS + DAY);
        expect(report.keys).toContain(attachmentBlobKey(s1, mine));
      });
    });
  });
}
