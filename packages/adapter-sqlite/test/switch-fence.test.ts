import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  moduleId,
  platformActorId,
  scopeId,
  tenantId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { PEER_CALLER, peerMod, scheduleMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

const SCHED = moduleId.parse('@test/sched');

type Runtime = { actor: { turn<T>(op: () => Promise<T> | T): Promise<T> } };

/**
 * #2045: two switch calls on one subject that overlap. Each call writes the directory's record,
 * then moves the scope; neither pair is atomic. Without the fence, operator A recording OFF, then
 * B recording ON and moving ON, then A's OFF landing, left the record ON beside a scope that is
 * OFF. With it, the record and the scope always end on the same (the newer) call's position.
 *
 * The interleavings are placed deterministically on the scope actor: the test holds the scope's
 * turn, so a call that has written its record waits there before it moves; and a call started
 * INSIDE the held turn is re-entrant, so it records and moves at once — ahead of the one queued.
 */
describe('#2045: overlapping switch calls end with the record and the scope agreeing', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-switch-fence-'));
    dirs.push(dir);
    const host = new SqliteScopeHost({ dir });
    host.registerModule(scheduleMod);
    host.registerModule(peerMod);
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `fence-${t.slice(-10).toLowerCase()}`, name: 'Fence' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.admin.grantEntitlement(staff, t, 'peer');
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    const runtime = (host as unknown as { runtime(t: TenantId, s: ScopeId): Runtime }).runtime(t, s);
    const node = { tenantId: t, scopeId: s };
    const kinds = {
      peer: {
        switch: (to: 'on' | 'off', reason: string = to) =>
          to === 'off'
            ? host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason })
            : host.admin.restoreToPeer(staff, { vertical: PEER_CALLER, node, reason }),
        recorded: async () =>
          (await host.admin.peerSwitchCarry(staff, node)).switchedOffPeers.includes(PEER_CALLER) ? 'off' : 'on',
        scope: async () => (await host.admin.peerGrantsStatus(staff, node)).find((p) => p.vertical === PEER_CALLER)?.calls,
      },
      system: {
        switch: (to: 'on' | 'off', reason: string = to) =>
          to === 'off'
            ? host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason })
            : host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason }),
        recorded: async () =>
          (await host.admin.listSystemSwitches(staff, { scopeId: s, moduleId: SCHED }))[0]?.position ?? 'on',
        scope: async () => (await host.admin.systemGrantsStatus(staff, node)).find((m) => m.moduleId === SCHED)?.schedules,
      },
    };
    /** The settled value or the refusal of a call, so two can run side by side. */
    const settle = (p: Promise<unknown>) =>
      p.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const done = () => host.close();
    return { host, t, s, node, runtime, kinds, settle, done, staff };
  };

  for (const kind of ['peer', 'system'] as const) {
    describe(kind, () => {
      it('A records OFF, B records ON and moves ON, THEN A moves: A is superseded, and both read ON', async () => {
        const { runtime, kinds, settle, done } = await setup();
        const k = kinds[kind];
        let recorded!: () => void;
        const aRecorded = new Promise<void>((r) => (recorded = r));
        // B runs inside the held turn, so it moves ahead of A, which queued behind the turn.
        const b = runtime.actor.turn(async () => {
          await aRecorded;
          return settle(k.switch('on', 'B'));
        });
        const a = settle(k.switch('off', 'A')); // records synchronously, then waits on the turn
        recorded();
        expect((await b).ok).toBe(true);
        const outcomeA = await a;
        expect(outcomeA.ok).toBe(false);
        expect(errorCodeOf(outcomeA.ok ? undefined : outcomeA.error)).toBe('conflict');
        expect(await k.recorded()).toBe('on');
        expect(await k.scope()).toBe('on');
        await done();
      });

      it('twin, in order: A records and moves OFF, then B records and moves ON — both succeed, both read ON', async () => {
        const { runtime, kinds, settle, done } = await setup();
        const k = kinds[kind];
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const held = runtime.actor.turn(() => gate);
        const a = settle(k.switch('off', 'A'));
        const b = settle(k.switch('on', 'B'));
        release();
        await held;
        expect([(await a).ok, (await b).ok]).toEqual([true, true]);
        expect(await k.recorded()).toBe('on');
        expect(await k.scope()).toBe('on');
        await done();
      });

      it('the race that ends OFF, then a restore from before it: the re-assert puts it back OFF', async () => {
        const { host, t, s, runtime, kinds, settle, done, staff } = await setup();
        const k = kinds[kind];
        await k.switch('off');
        await k.switch('on'); // a record row exists, so the coming ON writes one
        const before = await host.admin.exportScope(staff, t, s);
        let recorded!: () => void;
        const aRecorded = new Promise<void>((r) => (recorded = r));
        const b = runtime.actor.turn(async () => {
          await aRecorded;
          return settle(k.switch('off', 'B'));
        });
        const a = settle(k.switch('on', 'A'));
        recorded();
        expect((await b).ok).toBe(true);
        expect((await a).ok).toBe(false);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        await host.restoreScope(staff, t, s, before);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        await done();
      });
    });
  }

  it('upgrade: a scope created before the fence gains its table on the next open, and fences from then on', async () => {
    const { host, t, s, kinds, done } = await setup();
    const dir = dirs.at(-1)!;
    const db = (host as unknown as { runtime(t: TenantId, s: ScopeId): { db: { exec(q: string): void } } }).runtime(t, s).db;
    db.exec('DROP TABLE _substrat_switch_fences'); // the storage an older build left
    await done();
    const reopened = new SqliteScopeHost({ dir });
    reopened.registerModule(scheduleMod);
    reopened.registerModule(peerMod);
    const staff = platformActorId.parse(ulid());
    const node = { tenantId: t, scopeId: s };
    await reopened.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason: 'after upgrade' });
    const rows = (reopened as unknown as { runtime(t: TenantId, s: ScopeId): { db: { prepare(q: string): { all(): unknown[] } } } })
      .runtime(t, s)
      .db.prepare('SELECT subject FROM _substrat_switch_fences')
      .all();
    expect(rows).toEqual([{ subject: `vertical:${PEER_CALLER}` }]);
    void kinds;
    await reopened.close();
  });
});
