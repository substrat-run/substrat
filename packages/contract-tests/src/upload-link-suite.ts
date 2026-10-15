/**
 * Contract suite for upload links — `ctx.attachments.mintUploadUrl` and the host's
 * `inspectUploadLink` / `redeemUploadLink` that spend one.
 *
 * What it pins, in one sentence: **a link admits exactly ONE file to exactly ONE entity,
 * once, within its time box and its policy, written by the same attachment write any upload
 * takes — authored by the principal who minted it, checked against the target's write key as
 * them at redemption — and every failure leaves the link unspent and nothing stored.**
 *
 * Every refusal is paired with the allow beside it, so a surface that refused everything
 * cannot pass:
 *
 * 1. **The mint.** A caller with the write key mints; one without is refused and no row exists.
 *    A target that declares no `uploadLinks`, an undeclared type, a size above the target's,
 *    and a TTL past the hour are refused. An operation's own lock, decided before the mint,
 *    stops it. Defaults: ten minutes.
 * 2. **The redemption.** The file lands as an ordinary attachment — bytes intact, `createdBy`
 *    the minter, listed and opened by the minter, `attachment.added` on the spine — and the
 *    link records the attachment it produced.
 * 3. **Single use.** The second redemption is `upload_link_gone` and adds nothing.
 * 4. **Expiry and revocation.** A link past its time, and a revoked one, are `upload_link_gone`.
 * 5. **One target.** A redemption naming another entity — or another type — than the link was
 *    minted for is refused WITHOUT spending the link.
 * 6. **The policy.** Oversize and a disallowed type are refused without spending the link, and
 *    the same link then takes a conforming file. A fixed file name overrides the uploader's.
 * 7. **The minter, now.** Taking the minter's write key away after the mint refuses the
 *    redemption and leaves the link unspent; giving it back allows it.
 * 8. **The audit trail and the secret.** Minted, added and redeemed are on the spine in that
 *    order, as the minter; the secret is stored nowhere (its hash is) and a module that tries
 *    to persist it is refused.
 * 9. **A probe learns nothing.** An unknown or malformed secret is `not_found`, always.
 * 10. **A copy has no links.** A fork made from a dump never honours the source's link, which
 *     keeps working at the source; a restore into the scope the backup came from keeps it.
 *
 * The expiry TRANSITION runs on a real second here, since a Durable Object takes no injected
 * clock (#956); the shortest TTL is one second.
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
  type UploadLinkRecord,
} from '@substrat-run/contracts';
import {
  UPLOAD_LINK_GONE,
  UPLOAD_LINK_TOO_LARGE,
  UPLOAD_LINK_TYPE_REFUSED,
  UPLOAD_LINK_WRONG_TARGET,
  capabilityTokenHash,
  ulid,
  type ScopeHost,
  type UploadLinkRedeemInput,
} from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { UPL_MAX_BYTES, UPL_READ, UPL_WRITE, uploadLinkMod } from './upload-link-module.js';

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

interface StoredEvent {
  type: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  payload: string | null;
}

export function uploadLinkContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`upload links: ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid()); // owner: read + write, tenant-wide
    const bob: PrincipalId = principalId.parse(ulid()); // reader: read only
    const staff = platformActorId.parse(ulid());

    let n = 0;
    const udoc = (): EntityRef => ({ entityType: 'udoc', entityId: `doc-${++n}` });
    const as = (who: PrincipalId) => host.getScope(who, t1, s1);
    const mint = async (who: PrincipalId, input: Record<string, unknown>, op = 'upl/mint'): Promise<MintedUploadLink> =>
      (await as(who)).invoke<MintedUploadLink>(op, input);
    const links = async (entity?: EntityRef): Promise<UploadLinkRecord[]> =>
      (await as(alice)).invoke<UploadLinkRecord[]>('upl/list', entity ? { entity } : {});
    const linkOf = async (id: string): Promise<UploadLinkRecord> => {
      const found = (await links()).find((l) => l.id === id);
      if (!found) throw new Error(`no upload link ${id}`);
      return found;
    };
    const redeem = (
      m: Pick<MintedUploadLink, 'secret'>,
      entity: EntityRef,
      over: Partial<UploadLinkRedeemInput> = {},
    ): Promise<AttachmentRecord> => {
      if (!host.redeemUploadLink) throw new Error('host has no redeemUploadLink');
      return host.redeemUploadLink(t1, s1, m.secret, {
        entity,
        filename: 'a.txt',
        contentType: 'text/plain',
        body: bytes('hello'),
        ...over,
      });
    };
    const filesOf = async (entity: EntityRef): Promise<AttachmentRecord[]> =>
      (await host.attachments(alice, t1, s1)).list(entity);
    const events = async (): Promise<StoredEvent[]> => (await as(alice)).invoke<StoredEvent[]>('upl/events');

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(uploadLinkMod);
      await host.admin.createTenant(staff, { id: t1, slug: `upl-${t1.toLowerCase()}`, name: 'Upload links' });
      await host.admin.grantEntitlement(staff, t1, 'upl');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'upl-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.provisionBlobStore(staff, { tenantId: t1, vertical: 'upl-vertical', binding: 'ATTACHMENTS' });
      await host.admin.defineRole(staff, t1, { key: 'owner', permissions: [UPL_READ, UPL_WRITE], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'reader', permissions: [UPL_READ], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t1, scopeId: null } });
      await host.admin.assignRole(staff, { principalId: bob, roleKey: 'reader', node: { tenantId: t1, scopeId: null } });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    describe('the mint', () => {
      it('a caller holding the write key mints; one holding only the read key is refused and no link exists', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target });
        expect(minted.secret.startsWith('sbup_')).toBe(true);
        expect(minted.path).toBe(`/api/attachment-uploads/udoc/${target.entityId}/${minted.secret}`);
        expect(minted.maxBytes).toBe(UPL_MAX_BYTES);

        const other = udoc();
        expect(errorCodeOf(await refusal(mint(bob, { entity: other })))).toBe('permission_denied');
        expect(await links(other)).toEqual([]);
      });

      it('lives ten minutes by default, and a TTL past the hour is refused', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target });
        const rec = await linkOf(minted.id);
        expect(Date.parse(rec.expiresAt) - Date.parse(rec.mintedAt)).toBe(600_000);
        expect(rec.state).toBe('pending');

        const hour = await mint(alice, { entity: target, ttlSeconds: 3600 });
        const hourRec = await linkOf(hour.id);
        expect(Date.parse(hourRec.expiresAt) - Date.parse(hourRec.mintedAt)).toBe(3_600_000);
        expect(errorCodeOf(await refusal(mint(alice, { entity: target, ttlSeconds: 3601 })))).toBe('validation_failed');
      });

      it('refuses a target that declares no uploadLinks, an undeclared type, and a size above the target’s', async () => {
        const note = await refusal(mint(alice, { entity: { entityType: 'unote', entityId: 'n1' } }));
        expect(errorCodeOf(note)).toBe('forbidden');
        expect(reasonOf(note)).toBe('upload_links_not_declared');
        expect(errorCodeOf(await refusal(mint(alice, { entity: { entityType: 'ghost', entityId: 'g1' } })))).toBe(
          'validation_failed',
        );
        expect(errorCodeOf(await refusal(mint(alice, { entity: udoc(), maxBytes: UPL_MAX_BYTES + 1 })))).toBe(
          'validation_failed',
        );
        // The twin: a narrower size is accepted and is what the link carries.
        expect((await mint(alice, { entity: udoc(), maxBytes: 8 })).maxBytes).toBe(8);
      });

      it('an operation’s own entity lock, decided before the mint, stops it; the unlocked twin mints', async () => {
        const locked = udoc();
        const free = udoc();
        await (await as(alice)).invoke('upl/lock', { id: locked.entityId });
        expect(errorCodeOf(await refusal(mint(alice, { entity: locked }, 'upl/mint-locked')))).toBe('conflict');
        expect(await links(locked)).toEqual([]);
        expect((await mint(alice, { entity: free }, 'upl/mint-locked')).id).toBeTruthy();
      });
    });

    describe('the redemption', () => {
      it('lands as an ordinary attachment: bytes intact, authored by the minter, listed, opened and on the spine', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target });
        const view = await host.inspectUploadLink!(t1, s1, minted.secret);
        expect(view).toMatchObject({ entity: target, maxBytes: UPL_MAX_BYTES, visibility: 'internal', filename: null });

        const record = await redeem(minted, target, { filename: 'note.txt', body: bytes('the contract') });
        expect(record).toMatchObject({ entity: target, filename: 'note.txt', contentType: 'text/plain', size: 12 });
        expect(record.createdBy).toBe(alice);

        expect((await filesOf(target)).map((r) => r.id)).toEqual([record.id]);
        const opened = await (await host.attachments(alice, t1, s1)).open(record.id);
        expect(text(opened!.body)).toBe('the contract');

        // What a follow-up operation reads to find the file: the link records its attachment.
        const rec = await linkOf(minted.id);
        expect(rec).toMatchObject({ state: 'redeemed', attachmentId: record.id });
        expect(rec.redeemedAt).not.toBeNull();
      });

      it('is single-use: the second redemption is gone, and adds nothing', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target });
        await redeem(minted, target);
        const again = await refusal(redeem(minted, target, { body: bytes('second') }));
        expect(errorCodeOf(again)).toBe('conflict');
        expect(reasonOf(again)).toBe(UPLOAD_LINK_GONE);
        expect(errorCodeOf(await refusal(host.inspectUploadLink!(t1, s1, minted.secret)))).toBe('conflict');
        expect(await filesOf(target)).toHaveLength(1);
      });

      it('a link past its time is gone, and a link minted with a longer one beside it still works', async () => {
        const target = udoc();
        const short = await mint(alice, { entity: target, ttlSeconds: 1 });
        const long = await mint(alice, { entity: target });
        await sleep(1300);
        const late = await refusal(redeem(short, target));
        expect(reasonOf(late)).toBe(UPLOAD_LINK_GONE);
        expect((await linkOf(short.id)).state).toBe('expired');
        expect((await redeem(long, target)).entity).toEqual(target);
        expect(await filesOf(target)).toHaveLength(1);
      });

      it('a revoked link is gone; revoking is the minter’s, not a reader’s; a redeemed link cannot be revoked back', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target });
        expect(errorCodeOf(await refusal((await as(bob)).invoke('upl/revoke', { id: minted.id })))).toBe(
          'permission_denied',
        );
        await (await as(alice)).invoke('upl/revoke', { id: minted.id });
        expect(reasonOf(await refusal(redeem(minted, target)))).toBe(UPLOAD_LINK_GONE);
        expect((await linkOf(minted.id)).state).toBe('revoked');
        expect(await filesOf(target)).toEqual([]);

        const used = await mint(alice, { entity: target });
        await redeem(used, target);
        await (await as(alice)).invoke('upl/revoke', { id: used.id });
        expect((await linkOf(used.id)).state).toBe('redeemed');
      });

      it('a secret that names nothing, or is not one of ours, is not_found — always the same answer', async () => {
        const target = udoc();
        for (const secret of ['sbup_' + 'A'.repeat(43), 'sbup_', 'nonsense', 'sbcap_' + 'A'.repeat(43), 'x'.repeat(500)]) {
          expect(errorCodeOf(await refusal(redeem({ secret }, target)))).toBe('not_found');
          expect(errorCodeOf(await refusal(host.inspectUploadLink!(t1, s1, secret)))).toBe('not_found');
        }
      });
    });

    describe('one target', () => {
      it('a redemption naming another entity, or another type, is refused and spends nothing', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target });
        const elsewhere = await refusal(redeem(minted, udoc()));
        expect(errorCodeOf(elsewhere)).toBe('not_found');
        expect(reasonOf(elsewhere)).toBe(UPLOAD_LINK_WRONG_TARGET);
        expect(errorCodeOf(await refusal(redeem(minted, { entityType: 'unote', entityId: target.entityId })))).toBe('not_found');
        expect((await linkOf(minted.id)).state).toBe('pending');
        // The twin: the link's own target takes it.
        expect((await redeem(minted, target)).entity).toEqual(target);
      });
    });

    describe('the policy', () => {
      it('oversize is refused without spending the link, and the same link then takes a conforming file', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target });
        const big = await refusal(redeem(minted, target, { body: new Uint8Array(UPL_MAX_BYTES + 1) }));
        expect(errorCodeOf(big)).toBe('validation_failed');
        expect(reasonOf(big)).toBe(UPLOAD_LINK_TOO_LARGE);
        expect(await filesOf(target)).toEqual([]);
        expect((await linkOf(minted.id)).state).toBe('pending');
        expect((await redeem(minted, target, { body: new Uint8Array(UPL_MAX_BYTES) })).size).toBe(UPL_MAX_BYTES);

        // A mint-time narrowing is the ceiling the link enforces.
        const small = await mint(alice, { entity: target, maxBytes: 4 });
        expect(reasonOf(await refusal(redeem(small, target, { body: bytes('12345') })))).toBe(UPLOAD_LINK_TOO_LARGE);
        expect((await redeem(small, target, { body: bytes('1234') })).size).toBe(4);
      });

      it('a disallowed type is refused without spending the link; the allowed family and the exact type go through', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target });
        const exe = await refusal(redeem(minted, target, { contentType: 'application/x-msdownload', filename: 'a.exe' }));
        expect(errorCodeOf(exe)).toBe('validation_failed');
        expect(reasonOf(exe)).toBe(UPLOAD_LINK_TYPE_REFUSED);
        expect(await filesOf(target)).toEqual([]);
        expect((await redeem(minted, target, { contentType: 'image/png', filename: 'a.png' })).contentType).toBe('image/png');
        const pdf = await mint(alice, { entity: target });
        expect((await redeem(pdf, target, { contentType: 'application/pdf', filename: 'a.pdf' })).contentType).toBe(
          'application/pdf',
        );
      });

      it('a fixed file name overrides the uploader’s; without one the uploader’s is kept', async () => {
        const target = udoc();
        const fixed = await mint(alice, { entity: target, filename: 'signed.pdf' });
        expect((await host.inspectUploadLink!(t1, s1, fixed.secret)).filename).toBe('signed.pdf');
        expect((await redeem(fixed, target, { filename: 'whatever.txt' })).filename).toBe('signed.pdf');
        const free = await mint(alice, { entity: target });
        expect((await redeem(free, target, { filename: 'mine.txt' })).filename).toBe('mine.txt');
      });

      it('visibility is the link’s: a customer-visible link writes a customer-visible file', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target, visibility: 'customer' });
        expect((await redeem(minted, target)).visibility).toBe('customer');
      });
    });

    describe('the minter, now', () => {
      it('taking the minter’s write key away refuses the redemption and spends nothing; giving it back allows it', async () => {
        const carol = principalId.parse(ulid());
        const role = { principalId: carol, roleKey: 'owner', node: { tenantId: t1, scopeId: s1 } };
        await host.admin.assignRole(staff, role);
        const target = udoc();
        const minted = await mint(carol, { entity: target });

        await host.admin.unassignRole(staff, role);
        expect(errorCodeOf(await refusal(redeem(minted, target)))).toBe('permission_denied');
        expect(await filesOf(target)).toEqual([]);
        expect((await linkOf(minted.id)).state).toBe('pending');

        await host.admin.assignRole(staff, role);
        const record = await redeem(minted, target);
        expect(record.createdBy).toBe(carol);
      });
    });

    describe('copies', () => {
      it('a fork never honours the source’s link, which still works at the source; a same-scope restore keeps it', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target });
        const fork = scopeId.parse(ulid());
        await host.importScope(
          staff,
          { tenantId: t1, scopeId: fork, vertical: 'upl-vertical' },
          await host.admin.exportScope(staff, t1, s1),
        );
        expect(errorCodeOf(await refusal(host.inspectUploadLink!(t1, fork, minted.secret)))).toBe('not_found');
        expect((await host.inspectUploadLink!(t1, s1, minted.secret)).entity).toEqual(target);

        await host.restoreScope(staff, t1, s1, await host.admin.exportScope(staff, t1, s1));
        expect((await host.inspectUploadLink!(t1, s1, minted.secret)).entity).toEqual(target);
        expect((await redeem(minted, target)).entity).toEqual(target);
      });
    });

    describe('the audit trail and the secret', () => {
      it('minted, added and redeemed are on the spine in that order, as the minter; the redeemed event names the attachment', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target, filename: 'trail.txt' });
        const record = await redeem(minted, target);
        const mine = (await events()).filter((e) => e.entity_id === target.entityId);
        expect(mine.map((e) => e.type)).toEqual([
          'attachment.upload-link-minted',
          'attachment.added',
          'attachment.upload-link-redeemed',
        ]);
        for (const e of mine) expect(JSON.parse(e.actor)).toBe(alice);
        const redeemed = JSON.parse(mine[2]!.payload!) as Record<string, unknown>;
        expect(redeemed).toMatchObject({ linkId: minted.id, attachmentId: record.id, size: record.size, sha256: record.sha256 });
        // The mint's event carries what the link is, never the secret.
        expect(JSON.stringify(mine)).not.toContain(minted.secret);
      });

      it('the secret is stored nowhere — its hash is — and a module that persists it is refused, the mint rolling back', async () => {
        const target = udoc();
        const minted = await mint(alice, { entity: target });
        const dump = ((await (await as(alice)).invoke<string[]>('upl/dump')) ?? []).join('\n');
        expect(dump).not.toContain(minted.secret);
        expect(dump).toContain(await capabilityTokenHash(minted.secret));

        const leaky = udoc();
        expect(await refusal(mint(alice, { entity: leaky }, 'upl/mint-and-leak'))).toBeDefined();
        expect(await links(leaky)).toEqual([]);
      });
    });
  });
}
