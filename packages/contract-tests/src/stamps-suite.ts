/**
 * Contract suite for the updated stamps the host holds true (#2166).
 *
 * What it pins, on each adapter's SQL: an entity that declares `updatedAt`/`updatedBy` holds them on
 * every row an operation or a consumer emits about. A derived create writes all four stamps and a
 * derived update the updated pair. An authored write that stamps the pair passes; one that skips
 * either column, writes a constant time or another principal is refused `internal`, and its row and
 * its event roll back with it. A deleted row, a kernel move, an emit rolled back inside a
 * `ctx.atomic` and an entity without the pair are not checked. A consumer is held to the same rule,
 * with its own instant and principal, and a refused delivery is dead-lettered.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { errorCodeOf, permissionKey, platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { stampsMod, type StampMode } from './stamps-module.js';

const KEYS = ['sdoc:read', 'sdoc:write', 'sdoc:archive'].map((k) => permissionKey.parse(k));
type Doc = { id: string; title: string; created_at: string; created_by: string; updated_at: string; updated_by: string };

export function updatedStampsContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`updated stamps held by the host (#2166): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const carl: PrincipalId = principalId.parse(ulid());
    let as: ScopeStub;
    let asCarl: ScopeStub;

    const refusal = (call: Promise<unknown>): Promise<{ code: string | undefined; message: string }> =>
      call.then(
        () => ({ code: 'answered', message: '' }),
        (e: unknown) => ({ code: errorCodeOf(e), message: (e as Error).message }),
      );
    const get = (id: string) => as.invoke<Doc>('stamps/get-doc', { docId: id });
    const events = async (id: string) => (await as.invoke<{ events: number }>('stamps/history', { id })).events;
    const create = async (title: string) => as.invoke<Doc>('stamps/create-doc', { title });
    /**
     * A stamp left alone is only stale once the clock has moved past it: in the same millisecond
     * the old time IS this call's, and true. A timer, because workerd's clock stands still while
     * code runs.
     */
    const pastStamp = async (d: Doc) => {
      while (new Date().toISOString() <= d.updated_at) await new Promise((r) => setTimeout(r, 2));
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(stampsMod);
      await host.admin.createTenant(staff, { id: t, slug: 'stamps-tenant', name: 'Stamps Tenant' });
      await host.admin.grantEntitlement(staff, t, 'stamps');
      await host.admin.defineRole(staff, t, { key: 'stamps-admin', permissions: KEYS, source: 'vertical' });
      for (const who of [alice, carl]) {
        await host.admin.assignRole(staff, { principalId: who, roleKey: 'stamps-admin', node: { tenantId: t, scopeId: null } });
      }
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'stamps-vertical' });
      await host.admin.activateScope(staff, t, s);
      as = await host.getScope(alice, t, s);
      asCarl = await host.getScope(carl, t, s);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    describe('derived writes stamp the pair themselves', () => {
      it('a derived create writes all four stamps: the call’s instant and the caller', async () => {
        const before = new Date().toISOString();
        const d = await create('first');
        const after = new Date().toISOString();
        expect(d.created_at).toBe(d.updated_at);
        expect(d.created_at >= before && d.created_at <= after).toBe(true);
        expect([d.created_by, d.updated_by]).toEqual([alice, alice]);
        expect(await get(d.id)).toEqual(d);
      });

      it('a derived update moves the updated pair to its own caller, and leaves the created pair', async () => {
        const d = await create('second');
        const before = new Date().toISOString();
        const after = await asCarl.invoke<Doc>('stamps/update-doc', { docId: d.id, title: 'changed' });
        expect(after).toEqual({ ...d, title: 'changed', updated_at: after.updated_at, updated_by: carl });
        expect(after.updated_at >= before).toBe(true);
        expect(await get(d.id)).toEqual(after);
      });

      it('a derived update that sends nothing writes nothing, so the pair stays', async () => {
        const d = await create('untouched');
        expect(await asCarl.invoke<Doc>('stamps/update-doc', { docId: d.id })).toEqual(d);
      });
    });

    describe('an authored write is held to the pair', () => {
      it('an authored update that stamps the pair passes', async () => {
        const d = await create('authored');
        await asCarl.invoke('stamps/touch-doc', { id: d.id, title: 'by hand', stamp: 'both' });
        const after = await get(d.id);
        expect(after.title).toBe('by hand');
        expect(after.updated_by).toBe(carl);
        expect(after.created_by).toBe(alice);
      });

      it.each([
        ['skip-at', 'updated_at', 'time'],
        ['skip-by', 'updated_by', 'principal'],
        ['constant', 'updated_at', 'time'],
        ['other', 'updated_by', 'principal'],
      ] as const)('stamping %s is refused internal, and the write and its event roll back', async (stamp, column, what) => {
        const d = await create(`refused ${stamp}`);
        await pastStamp(d);
        const seen = await events(d.id);
        const r = await refusal(asCarl.invoke('stamps/touch-doc', { id: d.id, title: 'lost', stamp }));
        expect(r.code).toBe('internal');
        expect(r.message).toContain(`'${column}' does not hold this call's ${what}`);
        expect(r.message).toContain('stamps/touch-doc');
        expect(await get(d.id)).toEqual(d);
        expect(await events(d.id)).toBe(seen);
      });

      it('an authored insert must stamp the updated pair too: without it, no row is left', async () => {
        const ok = ulid();
        await as.invoke('stamps/add-doc', { id: ok, title: 'with', stampUpdated: true });
        expect((await get(ok)).updated_at).toBe((await get(ok)).created_at);
        const stale = ulid();
        const r = await refusal(as.invoke('stamps/add-doc', { id: stale, title: 'without', stampUpdated: false }));
        expect(r.code).toBe('internal');
        expect((await refusal(get(stale))).code).toBe('not_found');
      });
    });

    describe('what is not checked', () => {
      it('an emit about a deleted row: there is nothing left to stamp', async () => {
        const d = await create('to remove');
        await as.invoke('stamps/remove-doc', { id: d.id });
        expect((await refusal(get(d.id))).code).toBe('not_found');
      });

      it('a kernel move: archiving writes only the platform’s columns, and leaves the pair', async () => {
        const d = await create('to archive');
        await asCarl.invoke('stamps/archive-doc', { docId: d.id });
        expect(await get(d.id)).toEqual(d);
      });

      it('an emit rolled back inside ctx.atomic is gone from the outbox, so it is not held', async () => {
        const d = await create('atomic');
        // Another principal, past the create's millisecond: the rolled-back write left the row
        // stale in time, so were its emit still counted, this call would be refused.
        await pastStamp(d);
        const seen = await events(d.id);
        await asCarl.invoke('stamps/atomic-touch', { id: d.id, title: 'never' });
        expect(await get(d.id)).toEqual(d);
        expect(await events(d.id)).toBe(seen);
      });

      it('an entity that declares no updated stamp: an unstamped write passes', async () => {
        const id = ulid();
        await expect(as.invoke('stamps/touch-plain', { id, title: 'one' })).resolves.toEqual({ id });
        await expect(asCarl.invoke('stamps/touch-plain', { id, title: 'two' })).resolves.toEqual({ id });
      });
    });

    describe('a consumer is held to the pair, as its own principal', () => {
      const poke = async (stamp: StampMode) => {
        const d = await create(`poked ${stamp}`);
        await as.invoke('stamps/poke', { id: d.id, stamp });
        return d;
      };
      const lettersFor = async (id: string) =>
        (await host.admin.deadLetters(staff, t, s, {})).entries.filter((l) => String(l.error ?? '').includes(id));

      it('a consumer that stamps the pair writes the row, as its own principal', async () => {
        const d = await poke('both');
        const after = await get(d.id);
        expect(after.title).toBe('consumed both');
        expect(after.updated_by).not.toBe(alice);
        expect(after.updated_at >= d.updated_at).toBe(true);
        expect(await lettersFor(d.id)).toEqual([]);
      });

      it('a consumer that skips the pair is dead-lettered, and its write rolls back', async () => {
        const d = await poke('constant');
        expect(await get(d.id)).toEqual(d);
        const letters = await lettersFor(d.id);
        expect(letters).toHaveLength(1);
        expect(String(letters[0]?.error)).toContain("'updated_at' does not hold this call's time");
        expect(String(letters[0]?.error)).toContain('consuming sdoc.poked');
      });
    });
  });
}
