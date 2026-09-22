/**
 * Contract suite for attachments through a capability (#1686) — a link share of a folder
 * delivering the FILES under it, where `getCapabilityScope` reaches `invoke` only.
 *
 * What it pins, in one sentence: **a capability reads an attachment exactly when the
 * checker, asked as the capability, would let it read the attachment's entity — never
 * outside its subtree, never past its minter's authority now, never once revoked — and it
 * writes no attachment at all.**
 *
 * Every refusal is paired with the allow beside it, so a surface that refused everything
 * cannot pass:
 *
 * 1. **The subtree.** A capability over folder F opens F's own file, a file in F and a file
 *    two levels down, and lists them; it is refused the file on the sibling G's document,
 *    and that refusal lands in the denial log against `{ capability }`.
 * 2. **The minter, now.** When the minter's role is taken away after the mint, the next
 *    download is refused; given back, it is allowed again.
 * 3. **Revocation.** A surface obtained before a revoke refuses the next call on it, while
 *    a live twin keeps reading. (The expiry TRANSITION needs a clock a test can move, so it
 *    is asserted on the pure host — `capabilityExpiryContractSuite`, #956.)
 * 4. **No writes.** Upload and remove are refused even for a capability that CARRIES the
 *    write key — which its own invoke of a writing operation shows it does — and each
 *    refusal is recorded; no file appears and none goes. A remove naming an unknown id is
 *    refused with the same answer.
 * 5. **A download is not a use.** `uses` counts exchanges; opening and listing leave it
 *    where the exchange put it.
 * 6. **The door's other refusals.** An operation allowlist names no attachment verb, so it
 *    refuses them all (`forbidden`), next to the listed operation working; a token that is
 *    not a session is `unauthenticated`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type AttachmentRecord,
  type CapabilityRecord,
  type EntityRef,
  type MintedCapability,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeAttachments, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { capMod } from './modules.js';

const CAP_READ = permissionKey.parse('cap:read');
const CAP_WRITE = permissionKey.parse('cap:write');
const CAP_ADMIN = permissionKey.parse('cap:admin');

const folder = (id: string): EntityRef => ({ entityType: 'folder', entityId: id });
const doc = (id: string): EntityRef => ({ entityType: 'doc', entityId: id });
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

interface DenialRow {
  actor: string;
  permission: string;
  operation: string | null;
}

const refusal = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

export function capabilityAttachmentContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`capability attachments (#1686): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid()); // owner: read + write + admin, tenant-wide
    const staff = platformActorId.parse(ulid());
    // One file per place in the tree. The tree in s1:   F ─┬─ d1          G ── d3
    //                                                      └─ F2 ── d4
    const files: Record<'F' | 'd1' | 'd4' | 'd3', AttachmentRecord> = {} as never;

    const as = (who: PrincipalId) => host.getScope(who, t1, s1);
    const share = async (who: PrincipalId, spec: Record<string, unknown>): Promise<MintedCapability> =>
      (await as(who)).invoke<MintedCapability>('cap/share', spec);
    const sessionOf = async (secret: string): Promise<string> => {
      const ex = await host.exchangeCapability(t1, s1, secret);
      if (ex?.kind !== 'session') throw new Error(`expected a session, got ${JSON.stringify(ex)}`);
      return ex.sessionToken;
    };
    const filesOf = async (token: string): Promise<ScopeAttachments> => {
      if (!host.getCapabilityAttachments) throw new Error('host has no getCapabilityAttachments');
      return host.getCapabilityAttachments(token, t1, s1);
    };
    const denialsOf = async (capability: string): Promise<DenialRow[]> =>
      (await (await as(alice)).invoke<DenialRow[]>('cap/denials')).filter(
        (d) => d.actor === JSON.stringify({ capability }),
      );
    const recordOf = async (id: string): Promise<CapabilityRecord> => {
      const all = await (await as(alice)).invoke<CapabilityRecord[]>('cap/list', { includeRevoked: true });
      const found = all.find((r) => r.id === id);
      if (!found) throw new Error(`no capability ${id}`);
      return found;
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(capMod);
      await host.admin.createTenant(staff, {
        id: t1,
        slug: `cap-att-${t1.toLowerCase()}`,
        name: 'Cap Attachments',
      });
      await host.admin.grantEntitlement(staff, t1, 'cap');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'cap-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.provisionBlobStore(staff, { tenantId: t1, vertical: 'cap-vertical', binding: 'ATTACHMENTS' });
      await host.admin.defineRole(staff, t1, {
        key: 'owner',
        permissions: [CAP_READ, CAP_WRITE, CAP_ADMIN],
        source: 'vertical',
      });
      await host.admin.defineRole(staff, t1, { key: 'reader', permissions: [CAP_READ], source: 'vertical' });
      await host.admin.assignRole(staff, {
        principalId: alice,
        roleKey: 'owner',
        node: { tenantId: t1, scopeId: null },
      });

      const stub = await as(alice);
      const link = (child: EntityRef, parent: EntityRef) => stub.invoke('cap/link', { child, parent });
      await link(doc('d1'), folder('F'));
      await link(folder('F2'), folder('F'));
      await link(doc('d4'), folder('F2'));
      await link(doc('d3'), folder('G'));

      const mine = await host.attachments(alice, t1, s1);
      const put = (entity: EntityRef, name: string) =>
        mine.upload({ entity, filename: `${name}.txt`, contentType: 'text/plain', visibility: 'internal', body: bytes(name) });
      files.F = await put(folder('F'), 'F');
      files.d1 = await put(doc('d1'), 'd1');
      files.d4 = await put(doc('d4'), 'd4');
      files.d3 = await put(doc('d3'), 'd3');
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    describe('reads: exactly the subtree', () => {
      let minted: MintedCapability;
      let surface: ScopeAttachments;

      beforeAll(async () => {
        minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ] });
        surface = await filesOf(await sessionOf(minted.secret));
      });

      it('opens the shared folder’s own file, a file in it, and one two levels down — bytes intact', async () => {
        for (const key of ['F', 'd1', 'd4'] as const) {
          const opened = await surface.open(files[key].id);
          expect(opened?.record.id).toBe(files[key].id);
          expect(text(opened!.body)).toBe(key);
        }
      });

      it('lists the files of an entity in its subtree', async () => {
        expect((await surface.list(doc('d4'))).map((r) => r.id)).toEqual([files.d4.id]);
      });

      it('is refused the file on the sibling folder’s document — opened or listed — and it is recorded', async () => {
        expect(errorCodeOf(await refusal(surface.open(files.d3.id)))).toBe('permission_denied');
        expect(errorCodeOf(await refusal(surface.list(doc('d3'))))).toBe('permission_denied');
        const rows = await denialsOf(minted.id);
        expect(rows).toContainEqual(
          expect.objectContaining({ permission: 'cap:read', operation: 'attachments.open' }),
        );
        expect(rows).toContainEqual(
          expect.objectContaining({ permission: 'cap:read', operation: 'attachments.list' }),
        );
        // The twin: the owner opens the very same file.
        expect((await (await host.attachments(alice, t1, s1)).open(files.d3.id))?.record.id).toBe(files.d3.id);
      });

      it('an unknown id is null, as it is for a principal', async () => {
        expect(await surface.open(ulid())).toBeNull();
      });

      it('a download is not a use: opening and listing leave `uses` where the exchange put it', async () => {
        const before = (await recordOf(minted.id)).uses;
        await surface.open(files.d1.id);
        await surface.list(doc('d1'));
        await surface.open(files.F.id);
        expect((await recordOf(minted.id)).uses).toBe(before);
        // The twin: an exchange IS a use.
        await sessionOf(minted.secret);
        expect((await recordOf(minted.id)).uses).toBe(before + 1);
      });
    });

    describe('never more than the minter can read, now', () => {
      it('taking the minter’s role away refuses the next download; giving it back allows it again', async () => {
        const dan = principalId.parse(ulid());
        const role = { principalId: dan, roleKey: 'reader', node: { tenantId: t1, scopeId: s1 } };
        await host.admin.assignRole(staff, role);
        const minted = await share(dan, { entity: folder('F'), permissions: [CAP_READ] });
        const surface = await filesOf(await sessionOf(minted.secret));
        expect((await surface.open(files.d1.id))?.record.id).toBe(files.d1.id);

        await host.admin.unassignRole(staff, role);
        expect(errorCodeOf(await refusal(surface.open(files.d1.id)))).toBe('permission_denied');
        expect(await denialsOf(minted.id)).toContainEqual(
          expect.objectContaining({ permission: 'cap:read', operation: 'attachments.open' }),
        );

        await host.admin.assignRole(staff, role);
        expect((await surface.open(files.d1.id))?.record.id).toBe(files.d1.id);
      });
    });

    describe('revocation', () => {
      it('a revoke refuses the next call on a surface obtained before it; a live twin keeps reading', async () => {
        const doomed = await share(alice, { entity: folder('F'), permissions: [CAP_READ] });
        const twin = await share(alice, { entity: folder('F'), permissions: [CAP_READ] });
        const doomedFiles = await filesOf(await sessionOf(doomed.secret));
        const twinFiles = await filesOf(await sessionOf(twin.secret));
        expect((await doomedFiles.open(files.d1.id))?.record.id).toBe(files.d1.id);

        await (await as(alice)).invoke('cap/unshare', { id: doomed.id });

        expect(errorCodeOf(await refusal(doomedFiles.open(files.d1.id)))).toBe('unauthenticated');
        expect(errorCodeOf(await refusal(doomedFiles.list(doc('d1'))))).toBe('unauthenticated');
        expect((await twinFiles.open(files.d1.id))?.record.id).toBe(files.d1.id);
        // A door refusal, not an enforced check: nothing is recorded against it.
        expect(await denialsOf(doomed.id)).toEqual([]);
      });
    });

    describe('writes are refused — whatever the capability carries', () => {
      let minted: MintedCapability;
      let surface: ScopeAttachments;

      beforeAll(async () => {
        minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ, CAP_WRITE] });
        surface = await filesOf(await sessionOf(minted.secret));
      });

      it('carries the write key: its own invoke of a writing operation goes through', async () => {
        const stub = await host.getCapabilityScope(await sessionOf(minted.secret), t1, s1);
        await expect(stub.invoke('cap/comment', { doc: doc('d1'), body: 'ok' })).resolves.toEqual({
          commented: true,
        });
      });

      it('an upload is refused, recorded against the capability, and adds no file', async () => {
        const err = await refusal(
          surface.upload({
            entity: doc('d1'),
            filename: 'planted.txt',
            contentType: 'text/plain',
            visibility: 'internal',
            body: bytes('planted'),
          }),
        );
        expect(errorCodeOf(err)).toBe('permission_denied');
        expect(await denialsOf(minted.id)).toContainEqual(
          expect.objectContaining({ permission: 'cap:write', operation: 'attachments.upload' }),
        );
        const mine = await host.attachments(alice, t1, s1);
        expect((await mine.list(doc('d1'))).map((r) => r.id)).toEqual([files.d1.id]);
      });

      it('a remove (and so a replace) is refused, recorded, and the file stays', async () => {
        const err = await refusal(surface.remove(files.d1.id));
        expect(errorCodeOf(err)).toBe('permission_denied');
        expect(await denialsOf(minted.id)).toContainEqual(
          expect.objectContaining({ permission: 'cap:write', operation: 'attachments.remove' }),
        );
        const opened = await (await host.attachments(alice, t1, s1)).open(files.d1.id);
        expect(text(opened!.body)).toBe('d1');
      });

      it('a remove naming an unknown id gets the same refusal, and there is no key to record', async () => {
        const before = (await denialsOf(minted.id)).length;
        expect(errorCodeOf(await refusal(surface.remove(ulid())))).toBe('permission_denied');
        expect((await denialsOf(minted.id)).length).toBe(before);
      });

      it('the twin: the owner, holding the same write key, uploads and removes', async () => {
        const mine = await host.attachments(alice, t1, s1);
        const rec = await mine.upload({
          entity: doc('d1'),
          filename: 'owner.txt',
          contentType: 'text/plain',
          visibility: 'internal',
          body: bytes('owner'),
        });
        expect((await mine.remove(rec.id))?.id).toBe(rec.id);
      });
    });

    describe('the door', () => {
      it('an operation allowlist names no attachment verb, so it refuses them; the listed operation works', async () => {
        const minted = await share(alice, {
          entity: folder('F'),
          permissions: [CAP_READ],
          operations: ['cap/read'],
        });
        const token = await sessionOf(minted.secret);
        const surface = await filesOf(token);
        expect(errorCodeOf(await refusal(surface.open(files.d1.id)))).toBe('forbidden');
        expect(errorCodeOf(await refusal(surface.list(doc('d1'))))).toBe('forbidden');
        const stub = await host.getCapabilityScope(token, t1, s1);
        await expect(stub.invoke('cap/read', { entity: doc('d1') })).resolves.toBeTruthy();
      });

      it('a token that is not a session is refused at the door', async () => {
        expect(errorCodeOf(await refusal(filesOf('not-a-session')))).toBe('unauthenticated');
      });
    });
  });
}
