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
import type { DirectoryExec } from './findings-atomic-suite.js';

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
 *
 * Every move commits with its audit row or not at all. The audit failure is injected as a
 * trigger on the directory's admin log (`exec`), the one fault both stores raise the same way.
 */
export function connectLinkContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
  exec: DirectoryExec,
): void {
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

    it('lists only the ids it is given, and only those in the named tenant and scope', async () => {
      const a = await mint();
      const b = await mint();
      const elsewhere = await mint({ scopeId: s2 });
      const other = await mint({ tenantId: t2, scopeId: s3 });
      const ids = [a.id, b.id, elsewhere.id, other.id, connectLinkId.parse(ulid())];
      const named = await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: s1, ids });
      expect(named.map((l) => l.id).sort()).toEqual([a.id, b.id].sort());
      expect(await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: s1, ids: [] })).toEqual([]);
    });

    describe('a move commits with its audit row, or not at all', () => {
      /** Fail the admin-log insert for `action` in this suite's tenant until `heal`. */
      const failAudit = async (action: string) => {
        await exec(
          host,
          `CREATE TRIGGER fault_connect_link_audit BEFORE INSERT ON _substrat_admin_log
           WHEN NEW.action = '${action}' AND NEW.tenant_id = '${t1}'
           BEGIN SELECT RAISE(ABORT, 'injected fault'); END`,
        );
        return () => exec(host, 'DROP TRIGGER fault_connect_link_audit');
      };
      const statusOf = async (l: ConnectLink) => (await host.admin.getConnectLink(staff, keyOf(l)))?.status;

      it('a consume whose audit row fails leaves the link outstanding, and the retry spends it', async () => {
        const link = await mint();
        const heal = await failAudit('consumeConnectLink');
        await expect(consume(link)).rejects.toThrow(/injected fault/);
        expect(await statusOf(link)).toBe('outstanding');
        await heal();
        expect((await consume(link)).ok).toBe(true);
      });

      it('a mint, revoke or restore whose audit row fails changes nothing', async () => {
        const before = (await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: s1 })).length;
        let heal = await failAudit('mintConnectLink');
        await expect(mint()).rejects.toThrow(/injected fault/);
        await heal();
        expect(await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: s1 })).toHaveLength(before);

        const open = await mint();
        heal = await failAudit('revokeConnectLink');
        await expect(host.admin.revokeConnectLink(staff, keyOf(open))).rejects.toThrow(/injected fault/);
        await heal();
        expect(await statusOf(open)).toBe('outstanding');

        const spent = await mint();
        expect((await consume(spent)).ok).toBe(true);
        heal = await failAudit('restoreConnectLink');
        await expect(host.admin.restoreConnectLink(staff, keyOf(spent))).rejects.toThrow(/injected fault/);
        await heal();
        expect(await statusOf(spent)).toBe('used');
      });
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
