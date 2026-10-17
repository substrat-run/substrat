/**
 * Contract suite for replaying an upload-link redemption (#2315): a redeemer whose reply was lost
 * retries with the same `Idempotency-Key` and gets the stored file back, while single use holds for
 * everyone else.
 *
 * What it pins:
 *
 * 1. **The replay.** A redemption carrying a key records it; a retry of the same link with the same
 *    key and the same bytes answers the same record with `replayed: true`, and writes nothing: no
 *    bytes, no row, no event. A link redeemed without a key, or a fresh redemption with one, has no
 *    `replayed` flag.
 * 2. **The bytes are judged.** A replay whose bytes differ, in content or size, is
 *    `upload_link_replay_mismatch`, and stores nothing.
 * 3. **Nobody else gets in.** No key, another key, the right key on another link, and the right
 *    key after the attachment was removed: each is the same `upload_link_gone`, the same error
 *    down to its message, so a holder of the secret without the key learns nothing. A key is not
 *    an authority on a link it did not spend: on a pending link it is an ordinary redemption. A
 *    wrong path is still the wrong-target 404, key or not.
 * 4. **The race.** A retry that inspects the link while the first request is between its bytes
 *    and its row, then loses the spend, has ITS bytes removed, not the first's, and is answered
 *    as the replay. A retry under another key in the same interleaving is gone, and the first's
 *    bytes survive that too.
 * 5. **The sweep (#2314).** A redemption whose id the orphan sweep condemned commits nothing and
 *    spends nothing, so a retry with its key stores the file anew under a new id: nothing comes back
 *    from the condemned id.
 * 6. **The window.** A spent link is replayed past its own expiry. (The far end of the window, the
 *    expiry plus `UPLOAD_LINK_REPLAY_GRACE_SECONDS`, needs a clock a Durable Object does not take
 *    (#956); the kernel's `upload-link.test.ts` and the route's test hold it on SQLite.)
 * 7. **The key's shape.** A malformed key is `validation_failed`, before the link is looked up.
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
  type MintedUploadLink,
  type PrincipalId,
} from '@substrat-run/contracts';
import {
  ATTACHMENT_CONDEMNED,
  ORPHAN_SWEEP_GRACE_MS,
  UPLOAD_LINK_GONE,
  UPLOAD_LINK_REPLAY_MISMATCH,
  UPLOAD_LINK_WRONG_TARGET,
  attachmentBlobKey,
  ulid,
  type RedeemedUploadLink,
  type ScopeHost,
  type TenantBlobStore,
  type UploadLinkRedeemInput,
} from '@substrat-run/kernel';
import type { OrphanSweepFixture } from './orphan-sweep-suite.js';
import { UPL_READ, UPL_WRITE, uploadLinkMod } from './upload-link-module.js';

const DAY = 86_400_000;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const refusal = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
const reasonOf = (e: unknown): string | undefined => {
  const r = (e as { extensions?: { reason?: unknown } } | undefined)?.extensions?.reason;
  return typeof r === 'string' ? r : undefined;
};
/** Everything a caller can read off a refusal. */
const shapeOf = (e: unknown) => ({
  code: errorCodeOf(e),
  message: (e as Error).message,
  extensions: (e as { extensions?: unknown }).extensions,
});

export function uploadLinkReplayContractSuite(
  adapterName: string,
  makeFixture: () => Promise<OrphanSweepFixture>,
): void {
  describe(`upload-link replay (#2315): ${adapterName}`, () => {
    let fixture: OrphanSweepFixture;
    let host: ScopeHost;
    let store: TenantBlobStore;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    let n = 0;
    const udoc = (): EntityRef => ({ entityType: 'udoc', entityId: `doc-${++n}` });
    const key = (): string => `key-${ulid()}`;
    const as = () => host.getScope(alice, t1, s1);
    const mint = async (input: Record<string, unknown>): Promise<MintedUploadLink> =>
      (await as()).invoke<MintedUploadLink>('upl/mint', input);
    const redeem = (
      m: Pick<MintedUploadLink, 'secret'>,
      entity: EntityRef,
      over: Partial<UploadLinkRedeemInput> = {},
    ): Promise<RedeemedUploadLink> => {
      if (!host.redeemUploadLink) throw new Error('host has no redeemUploadLink');
      return host.redeemUploadLink(t1, s1, m.secret, {
        entity,
        filename: 'a.txt',
        contentType: 'text/plain',
        body: bytes('hello'),
        ...over,
      });
    };
    const files = () => host.attachments(alice, t1, s1);
    const filesOf = async (entity: EntityRef): Promise<AttachmentRecord[]> => (await files()).list(entity);
    const keys = async (): Promise<string[]> =>
      (await store.list(`scope/${s1}/att/`)).filter((k) => k.startsWith(`scope/${s1}/att/`)).sort();
    const eventCount = async (): Promise<number> => (await (await as()).invoke<unknown[]>('upl/events')).length;

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(uploadLinkMod);
      await host.admin.createTenant(staff, { id: t1, slug: `uplr-${t1.toLowerCase()}`, name: 'Upload-link replay' });
      await host.admin.grantEntitlement(staff, t1, 'upl');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'uplr-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.provisionBlobStore(staff, { tenantId: t1, vertical: 'uplr-vertical', binding: 'ATTACHMENTS' });
      await host.admin.defineRole(staff, t1, { key: 'owner', permissions: [UPL_READ, UPL_WRITE], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t1, scopeId: null } });
      await files();
      store = await fixture.blobs(t1);
    });

    afterAll(async () => {
      fixture.afterPut(null);
      await fixture.cleanup();
    });

    describe('the replay', () => {
      it('the same key and the same bytes answer the stored record, replayed, and write nothing', async () => {
        const target = udoc();
        const k = key();
        const minted = await mint({ entity: target });
        const first = await redeem(minted, target, { idempotencyKey: k });
        expect(first.replayed).toBeUndefined();
        const before = { keys: await keys(), events: await eventCount() };

        const again = await redeem(minted, target, { idempotencyKey: k });
        expect(again).toEqual({ ...first, replayed: true });
        // A third time is the same answer: a replay spends nothing either.
        expect(await redeem(minted, target, { idempotencyKey: k })).toEqual({ ...first, replayed: true });
        expect({ keys: await keys(), events: await eventCount() }).toEqual(before);
        expect((await filesOf(target)).map((r) => r.id)).toEqual([first.id]);
        const opened = await (await files()).open(first.id);
        expect(text(opened!.body)).toBe('hello');
      });

      it('a link redeemed without a key answers no replayed flag, and nothing can replay it', async () => {
        const target = udoc();
        const minted = await mint({ entity: target });
        const first = await redeem(minted, target);
        expect(first.replayed).toBeUndefined();
        expect(reasonOf(await refusal(redeem(minted, target, { idempotencyKey: key() })))).toBe(UPLOAD_LINK_GONE);
      });

      it('other bytes under the same key are a mismatch, by content and by size, and store nothing', async () => {
        const target = udoc();
        const k = key();
        const minted = await mint({ entity: target });
        await redeem(minted, target, { idempotencyKey: k });
        const before = await keys();
        for (const body of [bytes('hellp'), bytes('hello!')]) {
          const err = await refusal(redeem(minted, target, { idempotencyKey: k, body }));
          expect(errorCodeOf(err)).toBe('conflict');
          expect(reasonOf(err)).toBe(UPLOAD_LINK_REPLAY_MISMATCH);
        }
        expect(await keys()).toEqual(before);
        expect(await filesOf(target)).toHaveLength(1);
      });

      it('replays past the link’s own expiry', async () => {
        const target = udoc();
        const k = key();
        const minted = await mint({ entity: target, ttlSeconds: 1 });
        const first = await redeem(minted, target, { idempotencyKey: k });
        await sleep(1300);
        expect(await redeem(minted, target, { idempotencyKey: k })).toEqual({ ...first, replayed: true });
        // ...and without the key, the expired, spent link is gone as ever.
        expect(reasonOf(await refusal(redeem(minted, target)))).toBe(UPLOAD_LINK_GONE);
      });
    });

    describe('nobody else gets in', () => {
      it('no key, another key, the key on another link, and the key after removal are the same refusal', async () => {
        const target = udoc();
        const k = key();
        const minted = await mint({ entity: target });
        const first = await redeem(minted, target, { idempotencyKey: k });
        const other = await mint({ entity: target });
        await redeem(other, target, { idempotencyKey: key(), body: bytes('other') });

        const noKey = await refusal(redeem(minted, target));
        const wrongKey = await refusal(redeem(minted, target, { idempotencyKey: key() }));
        const otherLink = await refusal(redeem(other, target, { idempotencyKey: k, body: bytes('other') }));
        // The inspect the route makes first answers alike.
        const inspected = await refusal(host.inspectUploadLink!(t1, s1, minted.secret, target, key()));
        await (await files()).remove(first.id);
        const removed = await refusal(redeem(minted, target, { idempotencyKey: k }));

        expect(reasonOf(noKey)).toBe(UPLOAD_LINK_GONE);
        for (const e of [wrongKey, otherLink, inspected, removed]) expect(shapeOf(e)).toEqual(shapeOf(noKey));
      });

      it('a key is no authority on a link it did not spend: on a pending link it is an ordinary redemption', async () => {
        const target = udoc();
        const k = key();
        const spent = await mint({ entity: target });
        const first = await redeem(spent, target, { idempotencyKey: k });
        const pending = await mint({ entity: target });
        const second = await redeem(pending, target, { idempotencyKey: k });
        expect(second.replayed).toBeUndefined();
        expect(second.id).not.toBe(first.id);
        expect(await filesOf(target)).toHaveLength(2);
      });

      it('a wrong path is the wrong-target refusal, with the right key or without', async () => {
        const target = udoc();
        const k = key();
        const minted = await mint({ entity: target });
        await redeem(minted, target, { idempotencyKey: k });
        const elsewhere = udoc();
        const withKey = await refusal(redeem(minted, elsewhere, { idempotencyKey: k }));
        expect(errorCodeOf(withKey)).toBe('not_found');
        expect(reasonOf(withKey)).toBe(UPLOAD_LINK_WRONG_TARGET);
        expect(shapeOf(withKey)).toEqual(shapeOf(await refusal(redeem(minted, elsewhere))));
      });

      it('a malformed key is validation_failed, before the link is looked up', async () => {
        const target = udoc();
        const minted = await mint({ entity: target });
        for (const bad of ['short', 'has a space in it ok', 'x'.repeat(256), 'tab\there-and-more']) {
          expect(errorCodeOf(await refusal(redeem(minted, target, { idempotencyKey: bad })))).toBe('validation_failed');
        }
        // Nothing was spent by any of them.
        expect((await redeem(minted, target, { idempotencyKey: key() })).replayed).toBeUndefined();
      });
    });

    describe('the race', () => {
      /** Hold every put to this scope until released, in the order they land. */
      const holdPuts = () => {
        const landed: string[] = [];
        const gates = new Map<string, () => void>();
        const waiters: (() => void)[] = [];
        fixture.afterPut(async (k) => {
          if (!k.startsWith(`scope/${s1}/att/`)) return;
          landed.push(k);
          for (const w of waiters.splice(0)) w();
          await new Promise<void>((r) => gates.set(k, r));
        });
        const landedCount = async (count: number): Promise<string[]> => {
          while (landed.length < count) await new Promise<void>((r) => waiters.push(r));
          return [...landed];
        };
        return { landedCount, release: (k: string) => gates.get(k)!() };
      };

      it.each([
        ['the same key', true],
        ['another key', false],
      ] as const)('a retry under %s that lost the spend removes only its own bytes', async (_label, sameKey) => {
        const target = udoc();
        const k = key();
        const minted = await mint({ entity: target });
        const hold = holdPuts();
        try {
          const firstCall = redeem(minted, target, { idempotencyKey: k });
          const [firstKey] = await hold.landedCount(1);
          // The retry inspects the link while the first request is still between its bytes and its row.
          const secondCall = redeem(minted, target, { idempotencyKey: sameKey ? k : key() }).then(
            (r) => r,
            (e: unknown) => e,
          );
          const [, secondKey] = await hold.landedCount(2);
          expect(secondKey).not.toBe(firstKey);
          hold.release(firstKey!);
          const first = await firstCall;
          hold.release(secondKey!);
          const second = await secondCall;
          if (sameKey) expect(second).toEqual({ ...first, replayed: true });
          else expect(reasonOf(second)).toBe(UPLOAD_LINK_GONE);
          // The property: the first request's bytes survive, the loser's are gone.
          expect(text((await store.get(firstKey!))!.body)).toBe('hello');
          expect(await store.get(secondKey!)).toBeNull();
          expect((await filesOf(target)).map((r) => r.id)).toEqual([first.id]);
        } finally {
          fixture.afterPut(null);
        }
      });
    });

    describe('the orphan sweep (#2314)', () => {
      it('a condemned redemption spends nothing, and a retry with its key stores the file anew', async () => {
        const target = udoc();
        const k = key();
        const minted = await mint({ entity: target });
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let landed!: (key: string) => void;
        const putLanded = new Promise<string>((r) => (landed = r));
        fixture.afterPut(async (put) => {
          if (!put.startsWith(`scope/${s1}/att/`)) return;
          fixture.afterPut(null);
          landed(put);
          await held;
        });
        const redeeming = refusal(redeem(minted, target, { idempotencyKey: k }));
        const condemnedKey = await putLanded;
        if (!host.sweepOrphanAttachments) throw new Error('host has no sweepOrphanAttachments');
        fixture.clockAhead(ORPHAN_SWEEP_GRACE_MS + DAY);
        try {
          const report = await host.sweepOrphanAttachments(t1, s1, { copiesSettled: true });
          expect(report.keys).toContain(condemnedKey);
        } finally {
          fixture.clockAhead(0);
        }
        release();
        expect(reasonOf(await redeeming)).toBe(ATTACHMENT_CONDEMNED);

        const retried = await redeem(minted, target, { idempotencyKey: k });
        expect(retried.replayed).toBeUndefined();
        expect(attachmentBlobKey(s1, retried.id)).not.toBe(condemnedKey);
        expect((await filesOf(target)).map((r) => r.id)).toEqual([retried.id]);
        expect(await store.get(attachmentBlobKey(s1, retried.id))).not.toBeNull();
        expect(await redeem(minted, target, { idempotencyKey: k })).toEqual({ ...retried, replayed: true });
      });
    });
  });
}
