/**
 * Contract suite for download links (#3139) — `ctx.attachments.mintDownloadUrl` and the host's
 * `openDownloadLink` that reads through one.
 *
 * What it pins, in one sentence: **a link reads exactly ONE file, in exactly ONE scope, as the
 * principal who minted it — whose read key is asked again on every read — as often as it is asked
 * until it expires or is revoked, and a copy of the scope never honours it.**
 *
 * 1. **The mint and the read.** A holder of the target's read key mints; the link reads the file, a
 *    byte range of it, and again, since a read spends nothing. A caller with no read key is refused
 *    and no row exists; an attachment the scope does not hold is `not_found`; a life past a day is
 *    refused.
 * 2. **One file, one scope.** The link named with another file's id, an unknown or malformed
 *    secret, and the link at another scope or tenant are all `not_found`.
 * 3. **Expiry and revocation** are `download_link_gone`.
 * 4. **The minter, now.** Taking the minter's read key away refuses the read; giving it back allows it.
 * 5. **A removed file** reads as `null`.
 * 6. **The audit trail and the secret.** Minted and revoked are on the spine as the minter; the
 *    secret is stored nowhere.
 * 7. **A copy has no links.** A fork never honours the source's link, which keeps working at home.
 *
 * Expiry runs on a real second, as in the upload-link suite, since a Durable Object takes no clock.
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
  type MintedDownloadLink,
  type PrincipalId,
} from '@substrat-run/contracts';
import { DOWNLOAD_LINK_GONE, ulid, type ByteStream, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { UPL_READ, UPL_WRITE, uploadLinkMod } from './upload-link-module.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const refusal = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
const reasonOf = (e: unknown): unknown => (e as { extensions?: { reason?: unknown } } | undefined)?.extensions?.reason;

async function textOf(stream: ByteStream): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value!);
  return new TextDecoder().decode(Uint8Array.from(chunks.flatMap((c) => [...c])));
}

export function downloadLinkContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`download links: ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid()); // read + write
    const bob: PrincipalId = principalId.parse(ulid()); // read only
    const nobody: PrincipalId = principalId.parse(ulid()); // no role
    const staff = platformActorId.parse(ulid());

    let n = 0;
    const udoc = (): EntityRef => ({ entityType: 'udoc', entityId: `dl-${++n}` });
    const as = (who: PrincipalId) => host.getScope(who, t1, s1);
    const mint = async (who: PrincipalId, input: Record<string, unknown>): Promise<MintedDownloadLink> =>
      (await as(who)).invoke<MintedDownloadLink>('upl/mint-download', input);
    const upload = async (body = 'the recording'): Promise<AttachmentRecord> =>
      (await host.attachments(alice, t1, s1)).upload({
        entity: udoc(),
        filename: 'clip.txt',
        contentType: 'text/plain',
        visibility: 'internal',
        body: bytes(body),
      });
    const read = async (m: MintedDownloadLink, id: string, scope = s1) => {
      const opened = await host.openDownloadLink!(t1, scope, m.secret, id);
      return opened && textOf(opened.body.stream);
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(uploadLinkMod);
      await host.admin.createTenant(staff, { id: t1, slug: `dl-${t1.toLowerCase()}`, name: 'Download links' });
      await host.admin.grantEntitlement(staff, t1, 'upl');
      for (const s of [s1, s2]) {
        await host.provisionScope(staff, { tenantId: t1, scopeId: s, vertical: 'upl-vertical' });
        await host.admin.activateScope(staff, t1, s);
      }
      await host.provisionBlobStore(staff, { tenantId: t1, vertical: 'upl-vertical', binding: 'ATTACHMENTS' });
      await host.admin.defineRole(staff, t1, { key: 'owner', permissions: [UPL_READ, UPL_WRITE], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'reader', permissions: [UPL_READ], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t1, scopeId: null } });
      await host.admin.assignRole(staff, { principalId: bob, roleKey: 'reader', node: { tenantId: t1, scopeId: null } });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('a holder of the read key mints; the link reads the file, a range of it, and again', async () => {
      const file = await upload();
      const minted = await mint(bob, { attachmentId: file.id });
      expect(minted.secret).toMatch(/^sbdl_/);
      expect(minted.path).toBe(`/api/attachment-downloads/${file.id}/${minted.secret}`);
      expect(await read(minted, file.id)).toBe('the recording');
      const ranged = await host.openDownloadLink!(t1, s1, minted.secret, file.id, { range: { start: 4, end: 12 } });
      expect(ranged!.range).toEqual({ start: 4, end: 12 });
      expect(await textOf(ranged!.body.stream)).toBe('recording');
      expect(await read(minted, file.id)).toBe('the recording');
    });

    it('refuses a caller with no read key (and writes no row), a file the scope does not hold, and a life past a day', async () => {
      const file = await upload();
      expect(errorCodeOf(await refusal(mint(nobody, { attachmentId: file.id })))).toBe('permission_denied');
      const rows = await (await as(alice)).invoke<string[]>('upl/dump-downloads');
      expect(rows.filter((r) => r.includes(file.id))).toEqual([]);
      expect(errorCodeOf(await refusal(mint(alice, { attachmentId: ulid() })))).toBe('not_found');
      expect(errorCodeOf(await refusal(mint(alice, { attachmentId: file.id, ttlSeconds: 86_401 })))).toBe('validation_failed');
    });

    it('reads one file in one scope: another file, an unknown or malformed secret, or another scope finds nothing', async () => {
      const [file, other] = [await upload(), await upload('another')];
      const minted = await mint(alice, { attachmentId: file.id });
      for (const attempt of [
        () => host.openDownloadLink!(t1, s1, minted.secret, other.id),
        () => host.openDownloadLink!(t1, s1, 'sbdl_' + 'A'.repeat(43), file.id),
        () => host.openDownloadLink!(t1, s1, 'nonsense', file.id),
        () => host.openDownloadLink!(t1, s2, minted.secret, file.id),
      ]) {
        expect(errorCodeOf(await refusal(attempt()))).toBe('not_found');
      }
    });

    it('a link past its life, and a revoked one, are gone; a second revoke is a no-op', async () => {
      const file = await upload();
      const short = await mint(alice, { attachmentId: file.id, ttlSeconds: 1 });
      const revoked = await mint(alice, { attachmentId: file.id });
      await (await as(alice)).invoke('upl/revoke-download', { id: revoked.id });
      await (await as(alice)).invoke('upl/revoke-download', { id: revoked.id });
      await sleep(1100);
      for (const m of [short, revoked]) expect(reasonOf(await refusal(read(m, file.id)))).toBe(DOWNLOAD_LINK_GONE);
    });

    it('reads as the minter now: their read key taken away refuses the read, and given back allows it', async () => {
      const carol = principalId.parse(ulid());
      const role = { principalId: carol, roleKey: 'reader', node: { tenantId: t1, scopeId: s1 } };
      await host.admin.assignRole(staff, role);
      const file = await upload();
      const minted = await mint(carol, { attachmentId: file.id });
      await host.admin.unassignRole(staff, role);
      expect(errorCodeOf(await refusal(read(minted, file.id)))).toBe('permission_denied');
      await host.admin.assignRole(staff, role);
      expect(await read(minted, file.id)).toBe('the recording');
    });

    it('a file removed since the mint reads as null', async () => {
      const file = await upload();
      const minted = await mint(alice, { attachmentId: file.id });
      await (await host.attachments(alice, t1, s1)).remove(file.id);
      expect(await read(minted, file.id)).toBeNull();
    });

    it('minted and revoked are on the spine as the minter, and the secret is stored nowhere', async () => {
      const file = await upload();
      const minted = await mint(alice, { attachmentId: file.id });
      await (await as(alice)).invoke('upl/revoke-download', { id: minted.id });
      const events = (await (await as(alice)).invoke<{ type: string; actor: string; payload: string }[]>('upl/events')).filter((e) =>
        e.type.startsWith('attachment.download-link-'),
      );
      expect(events.slice(-2).map((e) => [e.type, JSON.parse(e.actor), JSON.parse(e.payload).linkId])).toEqual([
        ['attachment.download-link-minted', alice, minted.id],
        ['attachment.download-link-revoked', alice, minted.id],
      ]);
      const stored = await (await as(alice)).invoke<string[]>('upl/dump-downloads');
      expect(stored.join('\n')).not.toContain(minted.secret);
    });

    it('a fork never honours the source’s link, which still reads at the source', async () => {
      const file = await upload();
      const minted = await mint(alice, { attachmentId: file.id });
      const fork = scopeId.parse(ulid());
      await host.importScope(staff, { tenantId: t1, scopeId: fork, vertical: 'upl-vertical' }, await host.admin.exportScope(staff, t1, s1));
      expect(errorCodeOf(await refusal(read(minted, file.id, fork)))).toBe('not_found');
      expect(await read(minted, file.id)).toBe('the recording');
    });
  });
}
