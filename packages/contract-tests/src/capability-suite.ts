/**
 * Contract suite for capabilities (#1672) — authority carried by a secret rather than held
 * by a principal: a link share, a claim link.
 *
 * What it pins, in one sentence: **whoever exchanges a capability's secret acts as the
 * capability, and the capability reaches exactly its entity subtree and keys, never more
 * than its minter holds right now, for as long as it is live — and the kernel stores only the
 * secret's hash.**
 *
 * Every refusal here is paired with the allow beside it, so a checker that refused
 * everything cannot pass: the sibling folder is refused NEXT TO the shared folder being
 * read, the other key NEXT TO the carried one, the revoked capability NEXT TO its live
 * twin. The properties, and why each is behavioural rather than a note:
 *
 * 1. **The subtree and the keys.** A capability over folder F reads F, a document in F and
 *    a document two levels down; it is refused the sibling folder G, G's document, a
 *    node-level read, and a key it does not carry — each refusal landing in the denial log
 *    against `{ capability }`.
 * 2. **Never more than the minter holds, on every use.** A reader cannot mint a write key;
 *    and when the minter's own role is taken away AFTER the mint, the capability stops
 *    granting on the very next call.
 * 3. **Revocation, expiry and the use limit.** A revoke refuses the next invoke on a stub
 *    minted before it; a use limit refuses the exchange past it while the sessions already
 *    handed out keep working — a use is an exchange, not an invocation; two exchanges racing
 *    for a single-use capability admit one. (The expiry TRANSITION needs a clock a test can
 *    move, so it is asserted on the pure host — see `capabilityExpiryContractSuite`.)
 * 4. **The spine.** An event the capability causes carries `{ capability }` as its actor
 *    and K-34 authorization naming the root; the mint and the exchange are events too.
 * 5. **Only the hash is stored.** Every table of the scope is scanned after a mint, an
 *    exchange and a use; the hash is there and the secret is not. The TRIPWIRE for a module
 *    persisting its own secret by accident — as a payload value, an object key, an entity id,
 *    an intent's kind, a text or a byte SQL parameter — refuses the write and rolls the mint
 *    back, and each channel's clean twin goes through. An idempotent replay of a mint returns
 *    a placeholder. (A tripwire, not a boundary: a module that means to leak its secret can
 *    encode it first, and no scan of storage can recognise every encoding.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  CAPABILITY_SECRET_PREFIX,
  CAPABILITY_SESSION_PREFIX,
  capabilityRecord,
  errorCodeOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type CapabilityExchange,
  type CapabilityFilter,
  type EntityRef,
  type Instant,
  type MintedCapability,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import { capabilityTokenHash, ulid, WITHHELD_SECRET, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { CAP_LEAK_CHANNELS, capMod } from './modules.js';

const CAP_READ = permissionKey.parse('cap:read');
const CAP_WRITE = permissionKey.parse('cap:write');
const CAP_ADMIN = permissionKey.parse('cap:admin');

const folder = (id: string): EntityRef => ({ entityType: 'folder', entityId: id });
const doc = (id: string): EntityRef => ({ entityType: 'doc', entityId: id });

interface OutboxRow {
  id: string;
  type: string;
  occurred_at: string;
  actor: string;
  authorization: string | null;
  operation: string | null;
  entity_type: string;
  entity_id: string;
  payload: string | null;
}
interface DenialRow {
  actor: string;
  permission: string;
  operation: string | null;
}

/** The refusal a promise settles with, or `undefined` when it resolved. */
const refusal = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

export function capabilityContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`capability contract (#1672): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid()); // same tenant, a second scope
    const alice: PrincipalId = principalId.parse(ulid()); // owner: read + write + admin, tenant-wide
    const bob: PrincipalId = principalId.parse(ulid()); // reader at s1 only
    const carol: PrincipalId = principalId.parse(ulid()); // holds nothing
    const seat: PrincipalId = principalId.parse(ulid()); // the principal a `become` yields
    const staff = platformActorId.parse(ulid());

    const inFuture = (ms: number): Instant => new Date(Date.now() + ms).toISOString() as Instant;

    const as = (who: PrincipalId, scope: ScopeId = s1) => host.getScope(who, t1, scope);
    const share = async (
      who: PrincipalId,
      spec: Record<string, unknown>,
    ): Promise<MintedCapability> => (await as(who)).invoke<MintedCapability>('cap/share', spec);
    const exchange = (secret: string, scope: ScopeId = s1): Promise<CapabilityExchange | null> =>
      host.exchangeCapability(t1, scope, secret);
    const sessionOf = async (secret: string): Promise<string> => {
      const ex = await exchange(secret);
      if (ex?.kind !== 'session') throw new Error(`expected a session, got ${JSON.stringify(ex)}`);
      return ex.sessionToken;
    };
    const holder = async (secret: string) => host.getCapabilityScope(await sessionOf(secret), t1, s1);
    const outbox = async (): Promise<OutboxRow[]> => (await as(alice)).invoke<OutboxRow[]>('cap/outbox');
    const denials = async (): Promise<DenialRow[]> => (await as(alice)).invoke<DenialRow[]>('cap/denials');
    const dump = async (): Promise<Record<string, string>> =>
      (await as(alice)).invoke<Record<string, string>>('cap/dump');

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(capMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'cap-tenant', name: 'Cap Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'cap');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'cap-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.provisionScope(staff, { tenantId: t1, scopeId: s2, vertical: 'cap-vertical' });
      await host.admin.activateScope(staff, t1, s2);
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
      await host.admin.assignRole(staff, {
        principalId: bob,
        roleKey: 'reader',
        node: { tenantId: t1, scopeId: s1 },
      });

      // The tree in s1:   F ─┬─ d1          G ── d3
      //                      ├─ d2
      //                      └─ F2 ── d4
      const stub = await as(alice);
      const link = (child: EntityRef, parent: EntityRef) => stub.invoke('cap/link', { child, parent });
      await link(doc('d1'), folder('F'));
      await link(doc('d2'), folder('F'));
      await link(folder('F2'), folder('F'));
      await link(doc('d4'), folder('F2'));
      await link(doc('d3'), folder('G'));
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    describe('mint → exchange → act: exactly the subtree and the keys', () => {
      let minted: MintedCapability;
      let stub: Awaited<ReturnType<ScopeHost['getCapabilityScope']>>;

      beforeAll(async () => {
        minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ] });
        stub = await holder(minted.secret);
      });

      it('hands back a prefixed secret and an id, once', () => {
        expect(minted.secret.startsWith(CAPABILITY_SECRET_PREFIX)).toBe(true);
        expect(minted.secret.length).toBeGreaterThanOrEqual(CAPABILITY_SECRET_PREFIX.length + 43);
      });

      it('an exchange yields a session, never the secret back', async () => {
        const ex = await exchange(minted.secret);
        expect(ex?.kind).toBe('session');
        if (ex?.kind !== 'session') return;
        expect(ex.sessionToken.startsWith(CAPABILITY_SESSION_PREFIX)).toBe(true);
        expect(ex.sessionToken).not.toContain(minted.secret);
        expect(ex.capabilityId).toBe(minted.id);
        expect(ex.entity).toEqual(folder('F'));
      });

      it('reads the shared folder, a document in it, and one two levels down', async () => {
        for (const entity of [folder('F'), doc('d1'), doc('d4')]) {
          await expect(stub.invoke('cap/read', { entity })).resolves.toMatchObject({ read: entity });
        }
      });

      it('reports a capability grant read as incomplete on each adapter', async () => {
        await expect(stub.invoke('cap/granted-entities')).resolves.toEqual({
          kind: 'incomplete', reason: 'capability',
        });
      });

      it('the proof ends at the capability’s grant on its root, after the minter’s own chain', async () => {
        const out = await stub.invoke<{ proof: { subject: string; relation: string; object: string }[] }>(
          'cap/read',
          { entity: doc('d4') },
        );
        const last = out.proof[out.proof.length - 1]!;
        expect(last).toEqual({
          subject: `capability:${minted.id}`,
          relation: 'granted:cap:read',
          object: 'folder:F',
        });
        expect(out.proof).toContainEqual({
          subject: `capability:${minted.id}`,
          relation: 'minted-by',
          object: `principal:${alice}`,
        });
        // The walk it took: d4 → F2 → F.
        expect(out.proof).toContainEqual({ subject: 'doc:d4', relation: 'parent', object: 'folder:F2' });
        expect(out.proof).toContainEqual({ subject: 'folder:F2', relation: 'parent', object: 'folder:F' });
      });

      it('is refused the sibling folder and the sibling’s document — and the refusal is recorded', async () => {
        for (const entity of [folder('G'), doc('d3')]) {
          const err = await refusal(stub.invoke('cap/read', { entity }));
          expect(errorCodeOf(err)).toBe('permission_denied');
        }
        const rows = (await denials()).filter(
          (d) => d.actor === JSON.stringify({ capability: minted.id }),
        );
        expect(rows.filter((d) => d.permission === 'cap:read' && d.operation === 'cap/read')).toHaveLength(2);
      });

      it('is refused a key it does not carry, even on its own root', async () => {
        const err = await refusal(stub.invoke('cap/comment', { doc: doc('d1'), body: 'hi' }));
        expect(errorCodeOf(err)).toBe('permission_denied');
        const rows = await denials();
        expect(rows).toContainEqual(
          expect.objectContaining({
            actor: JSON.stringify({ capability: minted.id }),
            permission: 'cap:write',
            operation: 'cap/comment',
          }),
        );
      });

      it('holds no node-level authority: a check without an entity refuses it', async () => {
        const err = await refusal(stub.invoke('cap/read-all'));
        expect(errorCodeOf(err)).toBe('permission_denied');
        // The positive twin: the owner, holding the key at the node, passes the same check.
        await expect((await as(alice)).invoke('cap/read-all')).resolves.toEqual({ all: true });
      });

      it('ctx.principal carries the capability id — it is not a person', async () => {
        expect(await stub.invoke('cap/whoami')).toBe(minted.id);
      });

      it('a session is scope-bound: presented to another scope of the tenant, it acts as nobody', async () => {
        const token = await sessionOf(minted.secret);
        const elsewhere = await host.getCapabilityScope(token, t1, s2);
        expect(errorCodeOf(await refusal(elsewhere.invoke('cap/read', { entity: folder('F') })))).toBe(
          'unauthenticated',
        );
      });

      it('a secret is scope-bound: exchanged at another scope of the tenant, it finds nothing', async () => {
        expect(await exchange(minted.secret, s2)).toBeNull();
      });
    });

    describe('never more than the minter holds — at the mint, and on every use', () => {
      it('a reader cannot mint a write key; the same reader can mint the read key', async () => {
        const err = await refusal(share(bob, { entity: folder('F'), permissions: [CAP_WRITE] }));
        expect(errorCodeOf(err)).toBe('permission_denied');
        const ok = await share(bob, { entity: folder('F'), permissions: [CAP_READ] });
        expect(ok.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      });

      it('one key too many refuses the whole mint, and leaves no row behind', async () => {
        const before = (await (await as(alice)).invoke<unknown[]>('cap/list', { includeRevoked: true })).length;
        await refusal(share(bob, { entity: folder('F'), permissions: [CAP_READ, CAP_WRITE] }));
        const after = (await (await as(alice)).invoke<unknown[]>('cap/list', { includeRevoked: true })).length;
        expect(after).toBe(before);
      });

      it('someone holding nothing mints nothing', async () => {
        const err = await refusal(share(carol, { entity: folder('F'), permissions: [CAP_READ] }));
        expect(errorCodeOf(err)).toBe('permission_denied');
      });

      it('taking the minter’s role away AFTER the mint ends what the capability can do, at the next call', async () => {
        const dan = principalId.parse(ulid());
        const role = { principalId: dan, roleKey: 'reader', node: { tenantId: t1, scopeId: s1 } };
        await host.admin.assignRole(staff, role);
        const minted = await share(dan, { entity: folder('F'), permissions: [CAP_READ] });
        const stub = await holder(minted.secret);
        await expect(stub.invoke('cap/read', { entity: doc('d1') })).resolves.toBeTruthy();
        await host.admin.unassignRole(staff, role);
        expect(errorCodeOf(await refusal(stub.invoke('cap/read', { entity: doc('d1') })))).toBe(
          'permission_denied',
        );
        // Given back, it grants again — the re-check is live, not a latch.
        await host.admin.assignRole(staff, role);
        await expect(stub.invoke('cap/read', { entity: doc('d1') })).resolves.toBeTruthy();
      });

      it('a consumer cannot mint: its checks allow unconditionally, so it is refused outright', async () => {
        await (await as(alice)).invoke('cap/request-mint', { entity: folder('F') });
        const notes = await (await as(alice)).invoke<{ body: string }[]>('cap/notes');
        expect(notes.map((n) => n.body)).toContain('refused forbidden');
        expect(notes.some((n) => n.body.startsWith('minted'))).toBe(false);
      });

      it('a capability cannot mint a capability — no re-delegation', async () => {
        const minted = await share(alice, {
          entity: folder('F'),
          permissions: [CAP_READ],
        });
        const stub = await holder(minted.secret);
        const err = await refusal(stub.invoke('cap/share', { entity: folder('F'), permissions: [CAP_READ] }));
        expect(errorCodeOf(err)).toBe('forbidden');
      });
    });

    describe('revocation, the use limit, and the operation list', () => {
      it('a revoke refuses the NEXT invoke on a stub minted before it; its live twin keeps working', async () => {
        const doomed = await share(alice, { entity: folder('F'), permissions: [CAP_READ] });
        const twin = await share(alice, { entity: folder('F'), permissions: [CAP_READ] });
        const doomedStub = await holder(doomed.secret);
        const twinStub = await holder(twin.secret);
        await expect(doomedStub.invoke('cap/read', { entity: folder('F') })).resolves.toBeTruthy();

        await (await as(alice)).invoke('cap/unshare', { id: doomed.id });

        expect(errorCodeOf(await refusal(doomedStub.invoke('cap/read', { entity: folder('F') })))).toBe(
          'unauthenticated',
        );
        expect(await exchange(doomed.secret)).toBeNull();
        await expect(twinStub.invoke('cap/read', { entity: folder('F') })).resolves.toBeTruthy();
      });

      it('revoking twice is a no-op, not an error', async () => {
        const minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ] });
        await (await as(alice)).invoke('cap/unshare', { id: minted.id });
        await expect((await as(alice)).invoke('cap/unshare', { id: minted.id })).resolves.toEqual({
          revoked: true,
        });
      });

      it('only someone who could have minted it may revoke it', async () => {
        const minted = await share(alice, { entity: folder('F'), permissions: [CAP_WRITE] });
        // bob reads F but does not hold cap:write there.
        expect(errorCodeOf(await refusal((await as(bob)).invoke('cap/unshare', { id: minted.id })))).toBe(
          'permission_denied',
        );
        expect(errorCodeOf(await refusal((await as(carol)).invoke('cap/unshare', { id: minted.id })))).toBe(
          'permission_denied',
        );
      });

      it('a use limit refuses the exchange past it — and the sessions already out keep acting', async () => {
        const minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ], maxUses: 2 });
        const first = await host.getCapabilityScope(await sessionOf(minted.secret), t1, s1);
        await sessionOf(minted.secret);
        expect(await exchange(minted.secret)).toBeNull();
        // A use is an EXCHANGE: the first session reads as often as it likes.
        for (let i = 0; i < 3; i++) {
          await expect(first.invoke('cap/read', { entity: doc('d1') })).resolves.toBeTruthy();
        }
        const [record] = (await (await as(alice)).invoke<unknown[]>('cap/list', { entity: folder('F') }))
          .map((r) => capabilityRecord.parse(r))
          .filter((r) => r.id === minted.id);
        expect(record?.uses).toBe(2);
        expect(record?.maxUses).toBe(2);
      });

      it('two exchanges racing for a single-use capability admit exactly one', async () => {
        const minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ], maxUses: 1 });
        const results = await Promise.all(Array.from({ length: 5 }, () => exchange(minted.secret)));
        expect(results.filter((r) => r !== null)).toHaveLength(1);
      });

      it('an operation off the capability’s list is refused before its handler, whatever the keys allow', async () => {
        const minted = await share(alice, {
          entity: folder('F'),
          permissions: [CAP_READ, CAP_WRITE],
          operations: ['cap/read'],
        });
        const stub = await holder(minted.secret);
        await expect(stub.invoke('cap/read', { entity: doc('d1') })).resolves.toBeTruthy();
        expect(errorCodeOf(await refusal(stub.invoke('cap/comment', { doc: doc('d1'), body: 'x' })))).toBe(
          'forbidden',
        );
        // Refused at the door: no key was checked, so nothing lands in the denial log.
        const rows = (await denials()).filter((d) => d.actor === JSON.stringify({ capability: minted.id }));
        expect(rows).toHaveLength(0);
      });

      it('an allowlist naming an operation that does not exist is refused at the mint', async () => {
        const err = await refusal(
          share(alice, { entity: folder('F'), permissions: [CAP_READ], operations: ['cap/no-such-op'] }),
        );
        expect(errorCodeOf(err)).toBe('validation_failed');
      });

      it('an expiry that is not in the future is refused at the mint', async () => {
        const err = await refusal(
          share(alice, { entity: folder('F'), permissions: [CAP_READ], expiresAt: '2000-01-01T00:00:00.000Z' }),
        );
        expect(errorCodeOf(err)).toBe('validation_failed');
      });

      // #1856: the walk reads the root back as `<entityType>:<entityId>`. alice holds the
      // key tenant-wide, so the delegation check would ALLOW these; only the grammar
      // refuses them, and it refuses before a row is written.
      it('a root the permission walk could not read back is refused at the mint, and leaves no row', async () => {
        const count = async () =>
          (await (await as(alice)).invoke<unknown[]>('cap/list', { includeRevoked: true })).length;
        const before = await count();
        for (const entity of [
          { entityType: 'folder', entityId: 'F 2' },
          { entityType: 'fol:der', entityId: 'F' },
          { entityType: 'fol der', entityId: 'F' },
        ]) {
          const err = await refusal(share(alice, { entity, permissions: [CAP_READ] }));
          expect(errorCodeOf(err)).toBe('validation_failed');
          expect((err as Error).message).toMatch(/ctx\.capabilities\.mint: malformed entity ref/);
        }
        expect(await count()).toBe(before);
        // The twin: the same minter, key and shape, well-formed, mints.
        await expect(share(alice, { entity: folder('F'), permissions: [CAP_READ] })).resolves.toMatchObject({
          id: expect.any(String),
        });
      });

      it('a secret that is not one of ours, or one never minted, exchanges for nothing', async () => {
        expect(await exchange('not-a-secret')).toBeNull();
        expect(await exchange(`${CAPABILITY_SECRET_PREFIX}${'A'.repeat(43)}`)).toBeNull();
      });
    });

    describe('the spine: the actor, K-34, and the capability’s own events', () => {
      it('an event the capability causes is stamped `{ capability }`, with the key and root that authorized it', async () => {
        const minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ, CAP_WRITE] });
        const stub = await holder(minted.secret);
        await stub.invoke('cap/comment', { doc: doc('d2'), body: 'looks good' });
        const row = (await outbox())
          .filter((r) => r.type === 'cap.commented' && r.entity_id === 'd2')
          .pop()!;
        expect(JSON.parse(row.actor)).toEqual({ capability: minted.id });
        expect(JSON.parse(row.authorization!)).toEqual([{ permission: 'cap:write', grant: 'folder:F' }]);
        expect(row.operation).toBe('cap/comment');
      });

      it('the mint is on the spine as the minter; the exchange as the capability — neither carries the secret', async () => {
        const minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ] });
        await sessionOf(minted.secret);
        const rows = await outbox();
        const mint = rows.find(
          (r) => r.type === 'capability.minted' && JSON.parse(r.payload!).capabilityId === minted.id,
        )!;
        expect(JSON.parse(mint.actor)).toBe(alice);
        expect(mint.entity_type).toBe('folder');
        expect(mint.entity_id).toBe('F');
        const exercised = rows.find(
          (r) => r.type === 'capability.exercised' && JSON.parse(r.payload!).capabilityId === minted.id,
        )!;
        expect(JSON.parse(exercised.actor)).toEqual({ capability: minted.id });
        expect(exercised.operation).toBe('capabilities.exchange');
        // ONE instant per exchange: the event says the use happened exactly when the row does.
        const [record] = (await (await as(alice)).invoke<unknown[]>('cap/list', { entity: folder('F'), limit: 200 }))
          .map((r) => capabilityRecord.parse(r))
          .filter((r) => r.id === minted.id);
        expect(record?.lastUsedAt).toBe(exercised.occurred_at);
        expect(JSON.parse(exercised.payload!)).toMatchObject({ mode: 'act', uses: 1 });
        for (const r of [mint, exercised]) expect(r.payload).not.toContain(minted.secret);
      });

      it('a revoke is on the spine as the revoker', async () => {
        const minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ] });
        await (await as(alice)).invoke('cap/unshare', { id: minted.id });
        const row = (await outbox()).find(
          (r) => r.type === 'capability.revoked' && JSON.parse(r.payload!).capabilityId === minted.id,
        )!;
        expect(JSON.parse(row.actor)).toBe(alice);
      });
    });

    describe('only the hash is stored; an accidental write of the secret is refused', () => {
      it('after a mint, an exchange and a use, every table holds the hash and none holds the secret', async () => {
        const minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ, CAP_WRITE] });
        const token = await sessionOf(minted.secret);
        const stub = await host.getCapabilityScope(token, t1, s1);
        await stub.invoke('cap/comment', { doc: doc('d1'), body: 'stored' });
        const tables = await dump();
        const everything = Object.values(tables).join('\n');
        expect(everything).not.toContain(minted.secret);
        expect(everything).not.toContain(token);
        // The positive twin: what IS stored is the hash — of both.
        expect(tables._substrat_capabilities).toContain(await capabilityTokenHash(minted.secret));
        expect(tables._substrat_capability_sessions).toContain(await capabilityTokenHash(token));
      });

      // The tripwire, channel by channel: each accidental write of the secret is refused
      // and takes its mint down with it; the SAME channel carrying a harmless value goes
      // through and the capability persists — so a guard that refused a channel wholesale,
      // or scanned only the payload, would fail one side or the other.
      const labelled = async (label: string) =>
        (await (await as(alice)).invoke<unknown[]>('cap/list', { includeRevoked: true, limit: 200 }))
          .map((r) => capabilityRecord.parse(r))
          .some((r) => r.label === label);
      for (const via of CAP_LEAK_CHANNELS) {
        it(`the secret written via ${via} is refused, and its mint rolled back with it`, async () => {
          const label = `leak-${via}-${ulid()}`;
          const err = await refusal(
            (await as(alice)).invoke('cap/share-and-leak', {
              entity: folder('F'),
              permissions: [CAP_READ],
              label,
              via,
            }),
          );
          expect(errorCodeOf(err)).toBe('forbidden');
          expect(await labelled(label)).toBe(false);
        });

        it(`a harmless value written via ${via} goes through (the clean twin)`, async () => {
          const label = `clean-${via}-${ulid()}`;
          await (await as(alice)).invoke('cap/share-and-leak', {
            entity: folder('F'),
            permissions: [CAP_READ],
            label,
            via,
            leak: false,
          });
          expect(await labelled(label)).toBe(true);
        });
      }

      it('an idempotent replay of a mint withholds the secret; the first response carried it', async () => {
        const key = `mint-${ulid()}`;
        const input = { entity: folder('F'), permissions: [CAP_READ], label: key };
        const stub = await as(alice);
        const first = await stub.invoke<{ id: string; link: string }>('cap/share-link', input, {
          idempotencyKey: key,
        });
        expect(first.link).toMatch(new RegExp(`#share=${CAPABILITY_SECRET_PREFIX}`));
        const replay = await stub.invoke<{ id: string; link: string }>('cap/share-link', input, {
          idempotencyKey: key,
        });
        expect(replay.id).toBe(first.id);
        expect(replay.link).toBe(`https://docs.example/#share=${WITHHELD_SECRET}`);
        const secret = first.link.split('#share=')[1]!;
        expect(Object.values(await dump()).join('\n')).not.toContain(secret);
        // The first response's secret is the real one: it exchanges.
        expect((await exchange(secret))?.kind).toBe('session');
      });
    });

    describe('listing', () => {
      it('lists records with neither the secret nor its hash; revoked ones only when asked', async () => {
        const live = await share(alice, { entity: folder('F2'), permissions: [CAP_READ], label: 'live' });
        const gone = await share(alice, { entity: folder('F2'), permissions: [CAP_READ], label: 'gone' });
        await (await as(alice)).invoke('cap/unshare', { id: gone.id });
        const listed = await (await as(alice)).invoke<unknown[]>('cap/list', { entity: folder('F2') });
        const ids = listed.map((r) => capabilityRecord.parse(r).id);
        expect(ids).toContain(live.id);
        expect(ids).not.toContain(gone.id);
        const all = (await (await as(alice)).invoke<unknown[]>('cap/list', {
          entity: folder('F2'),
          includeRevoked: true,
        })).map((r) => capabilityRecord.parse(r));
        expect(all.find((r) => r.id === gone.id)?.revokedBy).toBe(alice);
        const text = JSON.stringify(all);
        expect(text).not.toContain(live.secret);
        expect(text).not.toContain(await capabilityTokenHash(live.secret));
      });
    });

    describe('become — platform-minted, exchanged for a principal', () => {
      it('yields the principal once, is spent, and is audited without its secret', async () => {
        const minted = await host.admin.mintCapability(staff, t1, s1, {
          principal: seat,
          expiresAt: inFuture(60_000),
          maxUses: 1,
          label: 'claim',
        });
        const ex = await exchange(minted.secret);
        expect(ex).toEqual({ kind: 'principal', capabilityId: minted.id, principal: seat });
        expect(await exchange(minted.secret)).toBeNull();
        const log = await host.admin.auditLog(staff);
        const entry = log.find(
          (e) => e.action === 'mintCapability' && JSON.stringify(e.after).includes(minted.id),
        );
        expect(entry).toBeDefined();
        expect(JSON.stringify(log)).not.toContain(minted.secret);
        expect(JSON.stringify(log)).not.toContain(await capabilityTokenHash(minted.secret));
        const exercised = (await outbox()).find(
          (r) => r.type === 'capability.exercised' && JSON.parse(r.payload!).capabilityId === minted.id,
        )!;
        expect(JSON.parse(exercised.actor)).toEqual({ capability: minted.id });
        expect(JSON.parse(exercised.payload!)).toMatchObject({ mode: 'become', principal: seat });
      });

      it('a route that can only take a session refuses a `become` secret WITHOUT spending it', async () => {
        const minted = await host.admin.mintCapability(staff, t1, s1, {
          principal: seat,
          expiresAt: inFuture(60_000),
          maxUses: 1,
        });
        expect(await host.exchangeCapability(t1, s1, minted.secret, { mode: 'act' })).toBeNull();
        // Still unspent: the route that CAN take a principal gets it.
        expect(await host.exchangeCapability(t1, s1, minted.secret, { mode: 'become' })).toEqual({
          kind: 'principal',
          capabilityId: minted.id,
          principal: seat,
        });
      });

      it('and a claim route refuses a share link without spending it', async () => {
        const link = await share(alice, { entity: folder('F'), permissions: [CAP_READ], maxUses: 1 });
        expect(await host.exchangeCapability(t1, s1, link.secret, { mode: 'become' })).toBeNull();
        expect((await host.exchangeCapability(t1, s1, link.secret, { mode: 'act' }))?.kind).toBe('session');
      });

      it('is revoked by the platform, not by a module', async () => {
        const minted = await host.admin.mintCapability(staff, t1, s1, {
          principal: seat,
          expiresAt: inFuture(60_000),
          maxUses: 3,
        });
        expect(errorCodeOf(await refusal((await as(alice)).invoke('cap/unshare', { id: minted.id })))).toBe(
          'forbidden',
        );
        await host.admin.revokeCapability(staff, t1, s1, minted.id);
        expect(await exchange(minted.secret)).toBeNull();
      });

      it('the platform can revoke a module-minted link too — the lever for a leaked one', async () => {
        const minted = await share(alice, { entity: folder('F'), permissions: [CAP_READ] });
        const stub = await holder(minted.secret);
        await host.admin.revokeCapability(staff, t1, s1, minted.id);
        expect(errorCodeOf(await refusal(stub.invoke('cap/read', { entity: folder('F') })))).toBe(
          'unauthenticated',
        );
      });

      it('requires a future expiry, and refuses an unknown capability on revoke', async () => {
        expect(
          errorCodeOf(
            await refusal(
              host.admin.mintCapability(staff, t1, s1, {
                principal: seat,
                expiresAt: '2000-01-01T00:00:00.000Z' as Instant,
                maxUses: 1,
              }),
            ),
          ),
        ).toBe('validation_failed');
        expect(
          errorCodeOf(await refusal(host.admin.revokeCapability(staff, t1, s1, ulid() as never))),
        ).toBe('not_found');
      });
    });

    // #1686: the operator's read. A staff actor has no operation to stand in, so
    // `HostAdmin.listCapabilities` is the directory `ctx.capabilities.list` reads, for them.
    // The property that matters is what it NEVER returns — a secret or a hash — and each such
    // check below has its positive twin: the same record shows everything else it should.
    describe('the operator read — HostAdmin.listCapabilities (#1686)', () => {
      const HEX64 = /\b[0-9a-f]{64}\b/i;
      let shareLink: MintedCapability;
      let narrowed: MintedCapability;
      let revoked: MintedCapability;
      let claim: MintedCapability;
      let expiry: Instant;
      let sessionToken: string;
      const entriesOf = async (t: typeof t1, sc: ScopeId, filter?: CapabilityFilter) =>
        (await host.admin.listCapabilities(staff, t, sc, filter)).entries;
      const own = <R extends { id: string }>(rows: R[]): R[] => rows.filter((r) => [shareLink, narrowed, revoked, claim].some((m) => m.id === r.id));

      beforeAll(async () => {
        expiry = inFuture(3_600_000);
        shareLink = await share(alice, { entity: folder('F'), permissions: [CAP_READ], label: 'ops-share' });
        narrowed = await share(alice, {
          entity: folder('G'),
          permissions: [CAP_READ],
          operations: ['cap/read'],
          expiresAt: expiry,
          maxUses: 3,
          label: 'ops-narrowed',
        });
        revoked = await share(alice, { entity: folder('F2'), permissions: [CAP_READ], label: 'ops-revoked' });
        await (await as(alice)).invoke('cap/unshare', { id: revoked.id });
        claim = await host.admin.mintCapability(staff, t1, s1, {
          principal: seat,
          expiresAt: inFuture(3_600_000),
          maxUses: 1,
          label: 'ops-claim',
        });
        sessionToken = await sessionOf(narrowed.secret); // one counted use on `narrowed`
      });

      it('lists what the module-side list does, as records an operator can read', async () => {
        const rows = own(await entriesOf(t1, s1, { includeRevoked: true, limit: 200 }));
        expect(rows.map((r) => r.id).sort()).toEqual([shareLink.id, narrowed.id, revoked.id, claim.id].sort());
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(shareLink.id)).toMatchObject({
          mode: 'act',
          label: 'ops-share',
          entity: folder('F'),
          permissions: [CAP_READ],
          operations: null,
          mintedBy: alice,
          expiresAt: null,
          maxUses: null,
          uses: 0,
          revokedAt: null,
          revokedBy: null,
        });
        expect(byId.get(narrowed.id)).toMatchObject({
          mode: 'act',
          entity: folder('G'),
          operations: ['cap/read'],
          expiresAt: expiry,
          maxUses: 3,
          uses: 1,
        });
        expect(byId.get(narrowed.id)!.lastUsedAt).not.toBeNull();
        expect(byId.get(revoked.id)).toMatchObject({ revokedBy: alice });
        expect(byId.get(revoked.id)!.revokedAt).not.toBeNull();
        expect(byId.get(claim.id)).toMatchObject({
          mode: 'become',
          principal: seat,
          mintedBy: { platform: staff },
          maxUses: 1,
        });
        // Every row is exactly the published record — the same schema ctx.capabilities.list is held to.
        for (const r of rows) expect(capabilityRecord.parse(r)).toEqual(r);
      });

      it('never returns a secret or a hash — not as a field, not anywhere in the text', async () => {
        const rows = await entriesOf(t1, s1, { includeRevoked: true, limit: 200 });
        const text = JSON.stringify(rows);
        // The positive twin of everything below: the read is not empty and is a faithful one.
        expect(own(rows)).toHaveLength(4);
        for (const m of [shareLink, narrowed, revoked, claim]) {
          expect(text).toContain(m.id);
          expect(text).not.toContain(m.secret);
          expect(text).not.toContain(await capabilityTokenHash(m.secret));
        }
        // A session token's hash is as live a credential as the capability's own.
        expect(text).not.toContain(sessionToken);
        expect(text).not.toContain(await capabilityTokenHash(sessionToken));
        // And whatever else a column might carry: no 64-hex digest of anything.
        expect(text).not.toMatch(HEX64);
        // Field by field: a record has only the published keys, and none of them is a credential.
        const allowed = new Set([
          ...Object.keys(capabilityRecord.options[0].shape),
          ...Object.keys(capabilityRecord.options[1].shape),
        ]);
        for (const r of rows) {
          for (const key of Object.keys(r)) {
            expect(allowed.has(key)).toBe(true);
            expect(key).not.toMatch(/hash|secret|token/i);
          }
        }
      });

      it('is live-only by default, and shows the revoked one when asked', async () => {
        const live = own(await entriesOf(t1, s1, { limit: 200 })).map((r) => r.id);
        expect(live).toContain(shareLink.id);
        expect(live).not.toContain(revoked.id);
        const all = own(await entriesOf(t1, s1, { includeRevoked: true, limit: 200 }));
        expect(all.map((r) => r.id)).toContain(revoked.id);
      });

      it('is newest first, narrows by entity, and is bounded', async () => {
        const all = await entriesOf(t1, s1, { includeRevoked: true, limit: 200 });
        const ids = all.map((r) => r.id);
        expect(ids).toEqual([...ids].sort().reverse()); // ULIDs: id order IS mint order
        const onG = await entriesOf(t1, s1, { entity: folder('G'), includeRevoked: true });
        expect(onG.length).toBeGreaterThan(0);
        expect(onG.every((r) => r.mode === 'act' && r.entity.entityId === 'G')).toBe(true);
        expect(onG.map((r) => r.id)).toContain(narrowed.id);
        expect(await entriesOf(t1, s1, { limit: 1 })).toHaveLength(1);
        // The bound is the filter's: past it is refused, not silently clamped.
        await expect(host.admin.listCapabilities(staff, t1, s1, { limit: 201 })).rejects.toThrow();
        await expect(host.admin.listCapabilities(staff, t1, s1, { limit: 0 })).rejects.toThrow();
      });

      it('reads the scope it is asked about and no other (K-3), and each read leaves an access row', async () => {
        const other = await entriesOf(t1, s2, { includeRevoked: true, limit: 200 });
        expect(own(other)).toEqual([]);
        // A scope of another tenant: the pair does not resolve, so no log of another tenant's is reachable.
        const t2 = tenantId.parse(ulid());
        const s3 = scopeId.parse(ulid());
        await host.admin.createTenant(staff, { id: t2, slug: 'cap-tenant-2', name: 'Cap Tenant 2' });
        await host.admin.grantEntitlement(staff, t2, 'cap');
        await host.provisionScope(staff, { tenantId: t2, scopeId: s3, vertical: 'cap-vertical' });
        await host.admin.activateScope(staff, t2, s3);
        const foreign = await host.admin.mintCapability(staff, t2, s3, {
          principal: seat,
          expiresAt: inFuture(60_000),
          maxUses: 1,
          label: 'ops-foreign',
        });
        await expect(host.admin.listCapabilities(staff, t2, s1)).rejects.toThrow();
        await expect(host.admin.listCapabilities(staff, t1, s3)).rejects.toThrow();
        // The twin: the foreign tenant's own pair reads its own row, which t1's never showed.
        const theirs = await entriesOf(t2, s3);
        expect(theirs.map((r) => r.id)).toEqual([foreign.id]);
        expect(JSON.stringify(await entriesOf(t1, s1, { includeRevoked: true, limit: 200 }))).not.toContain(foreign.id);

        const logged = await host.admin.accessLog(staff, { tenantId: t1, method: 'listCapabilities' });
        expect(logged.length).toBeGreaterThan(0);
        expect(JSON.stringify(logged)).not.toContain(shareLink.secret);
      });

      it('is a read: the use counts it reports do not move because it was asked', async () => {
        const a = await entriesOf(t1, s1, { entity: folder('G'), includeRevoked: true });
        const b = await entriesOf(t1, s1, { entity: folder('G'), includeRevoked: true });
        expect(b).toEqual(a);
      });

      // Paging. A scope with more capabilities than one page holds is walked to the end by
      // the cursor each page hands back — the operator is never left with the newest 50 and no
      // way to the rest. The walk runs on a scope of its own so its count is exact.
      describe('paging', () => {
        const TOTAL = 205; // past the filter's own ceiling of 200, so no single read can hold it
        const walkScope = scopeId.parse(ulid());
        const minted: string[] = []; // oldest first
        const mintMore = async (n: number): Promise<string[]> => {
          const stub = await as(alice, walkScope);
          const ids: string[] = [];
          for (let i = 0; i < n; i++) {
            ids.push((await stub.invoke<MintedCapability>('cap/share', { entity: folder('F'), permissions: [CAP_READ] })).id);
          }
          return ids;
        };
        const walk = async (limit: number, between?: (page: number) => Promise<void>) => {
          const seen: string[] = [];
          const sizes: number[] = [];
          let cursor: string | undefined;
          for (let page = 0; ; page++) {
            const p = await host.admin.listCapabilities(staff, t1, walkScope, {
              limit,
              ...(cursor === undefined ? {} : { cursor: cursor as never }),
            });
            seen.push(...p.entries.map((r) => r.id));
            sizes.push(p.entries.length);
            if (p.nextCursor === null) return { seen, sizes };
            // The cursor is the last record of the page just read, and only a page with more behind it carries one.
            expect(p.nextCursor).toBe(p.entries[p.entries.length - 1]!.id);
            expect(p.entries).toHaveLength(limit);
            cursor = p.nextCursor;
            await between?.(page);
            expect(page).toBeLessThan(TOTAL + 100); // a cursor that does not advance would loop for ever
          }
        };

        beforeAll(async () => {
          await host.provisionScope(staff, { tenantId: t1, scopeId: walkScope, vertical: 'cap-vertical' });
          await host.admin.activateScope(staff, t1, walkScope);
          minted.push(...(await mintMore(TOTAL)));
        }, 120_000);

        it('hands back a cursor exactly when more follow, and the whole set is reachable in pages', async () => {
          const newestFirst = [...minted].reverse();
          // The default page is not the whole set — and says so rather than looking complete.
          const first = await host.admin.listCapabilities(staff, t1, walkScope);
          expect(first.entries.map((r) => r.id)).toEqual(newestFirst.slice(0, 50));
          expect(first.nextCursor).toBe(newestFirst[49]);
          // Even the ceiling does not hold 205: the 5 oldest are behind the cursor, not dropped.
          const max = await host.admin.listCapabilities(staff, t1, walkScope, { limit: 200 });
          expect(max.entries).toHaveLength(200);
          expect(max.nextCursor).toBe(newestFirst[199]);
          const rest = await host.admin.listCapabilities(staff, t1, walkScope, { limit: 200, cursor: max.nextCursor! });
          expect(rest.entries.map((r) => r.id)).toEqual(newestFirst.slice(200));
          expect(rest.nextCursor).toBeNull();
          // The walk, at several page sizes: every record once, newest first, no gap, no repeat.
          for (const limit of [1, 50, 73, 200]) {
            const { seen } = await walk(limit);
            expect([limit, seen]).toEqual([limit, newestFirst]);
          }
        }, 120_000);

        it('a page that ends exactly at the end carries no cursor (no trailing empty page)', async () => {
          // 205 = 5 × 41: five full pages of 41 end the walk exactly, with nothing after the fifth.
          const { sizes } = await walk(41);
          expect(sizes).toEqual([41, 41, 41, 41, 41]);
          const { sizes: by5 } = await walk(5);
          expect(by5).toEqual(Array(TOTAL / 5).fill(5));
        });

        it('a record minted mid-walk neither repeats nor drops one the walk had yet to reach', async () => {
          const before = [...minted].reverse();
          const added: string[] = [];
          const { seen } = await walk(40, async () => {
            added.push(...(await mintMore(1)));
          });
          // Every record that existed when the walk began, once and in order…
          expect(seen).toEqual(before);
          // …and the newcomers sort ahead of every cursor already handed out, so they are the
          // next walk's first records rather than a hole in this one.
          expect(added.length).toBeGreaterThan(0);
          const fresh = await host.admin.listCapabilities(staff, t1, walkScope, { limit: added.length });
          expect(fresh.entries.map((r) => r.id)).toEqual([...added].reverse());
          minted.push(...added);
        }, 120_000);

        it('narrows and pages together: the cursor walks the filtered set', async () => {
          const stub = await as(alice, walkScope);
          const g = await stub.invoke<MintedCapability>('cap/share', { entity: folder('G'), permissions: [CAP_READ] });
          const g2 = await stub.invoke<MintedCapability>('cap/share', { entity: folder('G'), permissions: [CAP_READ] });
          minted.push(g.id, g2.id);
          const one = await host.admin.listCapabilities(staff, t1, walkScope, { entity: folder('G'), limit: 1 });
          expect(one.entries.map((r) => r.id)).toEqual([g2.id]);
          expect(one.nextCursor).toBe(g2.id);
          const two = await host.admin.listCapabilities(staff, t1, walkScope, {
            entity: folder('G'),
            limit: 1,
            cursor: one.nextCursor!,
          });
          expect(two.entries.map((r) => r.id)).toEqual([g.id]);
          expect(two.nextCursor).toBeNull();
        });

        it('refuses a cursor that is not a capability id, and a limit past the bound', async () => {
          for (const cursor of ['', 'not-an-id', 'sbcap_x', '01JZ0000000000000000000000'.toLowerCase()]) {
            await expect(
              host.admin.listCapabilities(staff, t1, walkScope, { cursor: cursor as never }),
            ).rejects.toThrow();
          }
          await expect(host.admin.listCapabilities(staff, t1, walkScope, { limit: 201 })).rejects.toThrow();
          // The twin: a well-formed cursor is accepted, even one that matches nothing.
          const nothing = await host.admin.listCapabilities(staff, t1, walkScope, { cursor: ulid() as never });
          expect(nothing.entries.length).toBeGreaterThanOrEqual(0);
        });

        it('pages carry the same records and no hash, however they are cut', async () => {
          const p = await host.admin.listCapabilities(staff, t1, walkScope, { limit: 3 });
          expect(JSON.stringify(p)).not.toMatch(HEX64);
          expect(Object.keys(p).sort()).toEqual(['entries', 'nextCursor']);
        });
      });
    });

    // #1686: capability rows never cross a scope id. A link minted on production opens
    // production, never a fork or a preview copy of it; a backup restored into the scope it
    // came from keeps the links that were live. Every refusal on the copy is paired with the
    // source still working, and the copy is shown to hold the rest of the data.
    describe('forks and restores — a link never opens a copy (#1686)', () => {
      let link: MintedCapability;
      let token: string;
      const listed = async (sc: ScopeId) =>
        (await host.admin.listCapabilities(staff, t1, sc, { includeRevoked: true, limit: 200 })).entries.map((r) => r.id);
      const refusedAt = async (sc: ScopeId) => {
        expect(await exchange(link.secret, sc)).toBeNull();
        const stub = await host.getCapabilityScope(token, t1, sc);
        expect(errorCodeOf(await refusal(stub.invoke('cap/read', { entity: folder('F') })))).toBe('unauthenticated');
        expect(await listed(sc)).toEqual([]);
        // The copy is a working copy of everything else: the owner reads the shared folder there.
        await expect((await as(alice, sc)).invoke('cap/read', { entity: folder('F') })).resolves.toMatchObject({
          read: folder('F'),
        });
      };
      const worksAtSource = async () => {
        expect((await exchange(link.secret, s1))?.kind).toBe('session');
        const stub = await host.getCapabilityScope(token, t1, s1);
        await expect(stub.invoke('cap/read', { entity: doc('d1') })).resolves.toMatchObject({ read: doc('d1') });
        expect(await listed(s1)).toContain(link.id);
      };

      beforeAll(async () => {
        link = await share(alice, { entity: folder('F'), permissions: [CAP_READ], label: 'fork-share' });
        token = await sessionOf(link.secret);
      });

      it('the dump a copy is made from carries the capability row — what the loader leaves behind is real', async () => {
        const dumped = await host.admin.exportScope(staff, t1, s1);
        const caps = dumped.tables.find((t) => t.name === '_substrat_capabilities');
        expect(JSON.stringify(caps?.rows)).toContain(await capabilityTokenHash(link.secret));
        const sessions = dumped.tables.find((t) => t.name === '_substrat_capability_sessions');
        expect(JSON.stringify(sessions?.rows)).toContain(await capabilityTokenHash(token));
      });

      it('a fork (importScope): the secret and the session are refused there, and the fork lists nothing', async () => {
        const fork = scopeId.parse(ulid());
        await host.importScope(staff, { tenantId: t1, scopeId: fork, vertical: 'cap-vertical' }, await host.admin.exportScope(staff, t1, s1));
        await refusedAt(fork);
        await worksAtSource();
      });

      it('a snapshot (snapshotScope): the same', async () => {
        const snap = await host.snapshotScope(staff, t1, s1, { kind: 'preview' });
        await refusedAt(snap);
        await worksAtSource();
      });

      it("a restore of this scope's backup onto another scope: the same", async () => {
        const other = scopeId.parse(ulid());
        await host.provisionScope(staff, { tenantId: t1, scopeId: other, vertical: 'cap-vertical' });
        await host.admin.activateScope(staff, t1, other);
        await host.restoreScope(staff, t1, other, await host.admin.exportScope(staff, t1, s1));
        await refusedAt(other);
        await worksAtSource();
      });

      it('a restore into the scope the backup came from keeps the link, its session and its listing', async () => {
        const backup = await host.admin.exportScope(staff, t1, s1);
        await host.restoreScope(staff, t1, s1, backup);
        await worksAtSource();
        // Its standing came back as it was: still live, the uses it had.
        const rec = (await host.admin.listCapabilities(staff, t1, s1, { limit: 200 })).entries.find((r) => r.id === link.id);
        expect(rec).toMatchObject({ revokedAt: null, label: 'fork-share' });
      });
    });
  });
}
