import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  connectLinkId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ConnectLink,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * A vertical's mailed connect link (connections.md §3.5.4), held by the directory.
 *
 * What the row is FOR is the whole list of cases: a link a bureau mails to a client company's
 * provider administrator is spent exactly once (two racing callbacks, one connection), can be
 * withdrawn before it is opened, lapses on its own, and belongs to one scope — another scope's
 * id answers as an absent one. Restore is the callback's undo when the credential store
 * fails, and must not be a way to resurrect a revocation or a lapsed link.
 *
 * Expiry is asserted with links minted already lapsed rather than by sleeping: the store takes
 * the expiry it is given, and the hosted adapter has no clock a suite could move.
 */
export function connectLinkContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`connect links (connections.md §3.5.4): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const admin = principalId.parse(ulid());
    const t1 = tenantId.parse(ulid());
    const t2 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid()); // same tenant, another install
    const s3 = scopeId.parse(ulid()); // another tenant
    const vertical = 'bureau-books';
    const week = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
    const lapsed = () => new Date(Date.now() - 60_000).toISOString();

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      await host.admin.createTenant(staff, { id: t1, slug: `cl-${t1.slice(-10).toLowerCase()}`, name: 'Bureau' });
      await host.admin.createTenant(staff, { id: t2, slug: `cl-${t2.slice(-10).toLowerCase()}`, name: 'Other' });
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical });
      await host.provisionScope(staff, { tenantId: t1, scopeId: s2, vertical });
      await host.provisionScope(staff, { tenantId: t2, scopeId: s3, vertical });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    const mint = (over: { tenantId?: TenantId; scopeId?: ScopeId; expiresAt?: string; subjectRef?: string } = {}) =>
      host.admin.mintConnectLink(staff, {
        tenantId: over.tenantId ?? t1,
        scopeId: over.scopeId ?? s1,
        vertical,
        provider: 'fortnox',
        createdBy: admin,
        expiresAt: over.expiresAt ?? week(),
        ...(over.subjectRef ? { subjectRef: over.subjectRef } : {}),
        returnUrl: 'https://books.bureau.example/clients/42',
      });
    const keyOf = (l: ConnectLink) => ({ tenantId: l.tenantId, scopeId: l.scopeId, id: l.id });
    const consume = (l: ConnectLink, accountRef = '123456') =>
      host.admin.consumeConnectLink(staff, { ...keyOf(l), provider: 'fortnox', accountRef, accountLabel: 'Testbolaget AB' });

    it('mints an outstanding row carrying who authorized it and what it is for', async () => {
      const link = await mint({ subjectRef: 'client-42' });
      expect(link).toMatchObject({
        tenantId: t1,
        scopeId: s1,
        vertical,
        provider: 'fortnox',
        status: 'outstanding',
        createdBy: admin,
        subjectRef: 'client-42',
        returnUrl: 'https://books.bureau.example/clients/42',
        usedAt: null,
        accountRef: null,
        accountLabel: null,
      });
      expect(await host.admin.getConnectLink(staff, keyOf(link))).toEqual(link);
      const listed = await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: s1, outstandingOnly: true });
      expect(listed.map((l) => l.id)).toContain(link.id);
    });

    it('is spent exactly once, recording what the consent attached', async () => {
      const link = await mint();
      const first = await consume(link);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.link).toMatchObject({ status: 'used', accountRef: '123456', accountLabel: 'Testbolaget AB' });
        expect(first.link.usedAt).not.toBeNull();
      }
      // A forwarded mail, a reloaded callback: the second spend answers `used`, changes nothing.
      expect(await consume(link, '999999')).toEqual({ ok: false, reason: 'used' });
      expect((await host.admin.getConnectLink(staff, keyOf(link)))?.accountRef).toBe('123456');
    });

    it('settles two racing consumes with exactly one winner', async () => {
      const link = await mint();
      const results = await Promise.all([consume(link, 'a'), consume(link, 'b'), consume(link, 'c')]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([
        { ok: false, reason: 'used' },
        { ok: false, reason: 'used' },
      ]);
    });

    it('refuses a link that has lapsed, and lists it as nothing that still opens', async () => {
      const link = await mint({ expiresAt: lapsed() });
      expect(await consume(link)).toEqual({ ok: false, reason: 'expired' });
      const open = await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: s1, outstandingOnly: true });
      expect(open.map((l) => l.id)).not.toContain(link.id);
      // The unfiltered list is the history, lapsed rows included.
      const all = await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: s1 });
      expect(all.map((l) => l.id)).toContain(link.id);
    });

    it('a revoked link refuses, and revoking is idempotent', async () => {
      const link = await mint();
      expect((await host.admin.revokeConnectLink(staff, keyOf(link)))?.status).toBe('revoked');
      expect(await consume(link)).toEqual({ ok: false, reason: 'revoked' });
      expect((await host.admin.revokeConnectLink(staff, keyOf(link)))?.status).toBe('revoked');
      // A spent link has nothing left to revoke — it answers as it stands.
      const spent = await mint();
      await consume(spent);
      expect((await host.admin.revokeConnectLink(staff, keyOf(spent)))?.status).toBe('used');
    });

    it('belongs to one scope: another scope or tenant naming its id finds nothing', async () => {
      const link = await mint();
      for (const key of [
        { tenantId: t1, scopeId: s2, id: link.id },
        { tenantId: t2, scopeId: s3, id: link.id },
        { tenantId: t2, scopeId: s1, id: link.id },
      ]) {
        expect(await host.admin.getConnectLink(staff, key)).toBeUndefined();
        expect(await host.admin.revokeConnectLink(staff, key)).toBeUndefined();
        expect(
          await host.admin.consumeConnectLink(staff, { ...key, provider: 'fortnox', accountRef: 'x' }),
        ).toEqual({ ok: false, reason: 'unknown' });
        expect(await host.admin.restoreConnectLink(staff, key)).toBe(false);
      }
      expect((await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: s2 })).map((l) => l.id)).not.toContain(
        link.id,
      );
      expect((await host.admin.listConnectLinks(staff, { tenantId: t2 })).map((l) => l.id)).not.toContain(link.id);
      // A round for another provider is not this link's round either.
      expect(
        await host.admin.consumeConnectLink(staff, { ...keyOf(link), provider: 'scrive', accountRef: 'x' }),
      ).toEqual({ ok: false, reason: 'unknown' });
      // And none of the above touched it.
      expect((await host.admin.getConnectLink(staff, keyOf(link)))?.status).toBe('outstanding');
      expect(
        await host.admin.getConnectLink(staff, { tenantId: t1, scopeId: s1, id: connectLinkId.parse(ulid()) }),
      ).toBeUndefined();
    });

    it('restore un-spends a used link after a failed store — and only that', async () => {
      const link = await mint();
      expect((await consume(link)).ok).toBe(true);
      expect(await host.admin.restoreConnectLink(staff, keyOf(link))).toBe(true);
      expect(await host.admin.getConnectLink(staff, keyOf(link))).toMatchObject({
        status: 'outstanding',
        usedAt: null,
        accountRef: null,
        accountLabel: null,
      });
      // Outstanding again, so a fresh consent round can spend it.
      expect((await consume(link)).ok).toBe(true);

      // An outstanding link has nothing to restore; a revocation is never undone by it.
      const outstanding = await mint();
      expect(await host.admin.restoreConnectLink(staff, keyOf(outstanding))).toBe(false);
      await host.admin.revokeConnectLink(staff, keyOf(outstanding));
      expect(await host.admin.restoreConnectLink(staff, keyOf(outstanding))).toBe(false);
      expect((await host.admin.getConnectLink(staff, keyOf(outstanding)))?.status).toBe('revoked');
    });

    it('audits mint, revoke, consume and restore — and not a revoke that changed nothing', async () => {
      const link = await mint();
      await host.admin.revokeConnectLink(staff, keyOf(link));
      await host.admin.revokeConnectLink(staff, keyOf(link));
      const spent = await mint();
      await consume(spent);
      await host.admin.restoreConnectLink(staff, keyOf(spent));
      const ids: string[] = [link.id, spent.id];
      const rows = (await host.admin.auditLog(staff, { tenantId: t1 })).filter((r) =>
        ids.includes((r.after as { id?: string } | null)?.id ?? ''),
      );
      expect(rows.map((r) => r.action).sort()).toEqual(
        ['consumeConnectLink', 'mintConnectLink', 'mintConnectLink', 'restoreConnectLink', 'revokeConnectLink'].sort(),
      );
      expect(rows.every((r) => r.scopeId === s1)).toBe(true);
    });
  });
}
