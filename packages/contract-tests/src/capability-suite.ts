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
  });
}
