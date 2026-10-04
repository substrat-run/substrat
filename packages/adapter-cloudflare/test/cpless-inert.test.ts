import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { moduleId, permissionKey, principalId, scopeId, tenantId, type ScopeId, type ScopeLifecycle } from '@substrat-run/contracts';
import { scheduleMod } from '@substrat-run/contract-tests';
import { INERT_SCOPE_REASON, ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';

/**
 * #2005 on a CP-LESS host — the hosted-vertical shape, with no control-plane directory to ask
 * what kind of scope it serves. A preview or a snapshot reaches such a vertical as a restore the
 * platform flags with the directory's classification (`markCopy`), and the store records that it
 * is a copy (`_substrat_copy_origin.is_copy`), so the coordinator reads the scope's own storage
 * instead: a copy's plain executor never runs, and its delivery is journaled inert. (A connector
 * never runs on a CP-less host at all; that is #574's routing.)
 */
describe('a CP-less host holds a copy inert by its own storage (#2005)', () => {
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const USE = permissionKey.parse('perm:use');
  const ran: string[] = [];
  /** The event ids the executor ran, so a copied event can be told from the scope's own. */
  const ranIds: string[] = [];
  let install: ScopeId;

  const hostFor = () => {
    // No `controlPlane` binding.
    const host = new CloudflareScopeHost({ scope: env.SCOPE });
    host.registerExecutor('cpless-effector', 'perm.acted', async (_admin, event) => {
      ran.push(event.scopeId);
      ranIds.push(event.id);
    });
    return host;
  };
  const seat = (s: ScopeId) =>
    hostFor().provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  const act = async (s: ScopeId, host = hostFor()) => (await host.getScope(owner, t, s)).invoke('perm/authorized-emit', { permission: USE });
  /** The scope's copy-origin rows, as column → value. */
  const originOf = async (s: ScopeId) => {
    const d = (await hostFor().exportScopeLocal(s)).find((x) => x.name === '_substrat_copy_origin');
    return (d?.rows ?? []).map((r) => Object.fromEntries(d!.columns.map((c, i) => [c, (r as unknown[])[i]])));
  };
  const inertIn = async (s: ScopeId) =>
    (await hostFor().executorDeadLetters(t, s)).filter((d) => d.error === INERT_SCOPE_REASON).length;

  beforeAll(async () => {
    install = scopeId.parse(ulid());
    await seat(install);
  });

  it('twin: an install runs its plain executor', async () => {
    await act(install);
    expect(ran).toEqual([install]);
    expect(await inertIn(install)).toBe(0);
  });

  const PREVIEW = { kind: 'preview', forkedFrom: null };
  const FORK = (from = install) => ({ kind: 'preview', forkedFrom: from });
  const INSTALL = { kind: 'scope', forkedFrom: null };

  it("a copy (a preview fork, restored from the install's export): held inert", async () => {
    const copy = scopeId.parse(ulid());
    await hostFor().restoreScopeLocal(copy, await hostFor().exportScopeLocal(install), { sourceScopeId: install, markCopy: FORK() });
    await act(copy);
    expect(ran).not.toContain(copy);
    expect(await inertIn(copy)).toBe(1);
    // Terminal: the retry driver neither runs it nor journals it again.
    expect((await hostFor().drainDue(t, copy)).attempted).toBe(0);
    expect(ran).not.toContain(copy);
  });

  it('a snapshot (copied inside this deployment): held inert', async () => {
    const snap = scopeId.parse(ulid());
    await hostFor().snapshotScopeLocal(install, snap);
    await act(snap);
    expect(ran).not.toContain(snap);
    expect(await inertIn(snap)).toBe(1);
  });

  it('a clean-room preview (a restore of nothing, then seated): held inert', async () => {
    const clean = scopeId.parse(ulid());
    await hostFor().restoreScopeLocal(clean, [], { markCopy: PREVIEW });
    await seat(clean);
    await act(clean);
    expect(ran).not.toContain(clean);
    expect(await inertIn(clean)).toBe(1);
  });

  // A copy made before every copy carried the marker, or a same-scope carry of one, holds no
  // row: on its own storage it reads as an install. The platform, which has the directory, marks it.
  describe('a copy that predates the marker (#2005)', () => {
    /** A scope this deployment holds with no origin row, as such a copy does. */
    const legacy = async () => {
      const s = scopeId.parse(ulid());
      await seat(s);
      return s;
    };

    it('reads as an install until it is marked — the gap this closes', async () => {
      const s = await legacy();
      await act(s);
      expect(ran).toContain(s);
    });

    it('a carry the platform flags (markCopy) stamps it, and its executors are then inert', async () => {
      const s = await legacy();
      await hostFor().restoreScopeLocal(s, await hostFor().exportScopeLocal(s), { sourceScopeId: s, exact: true, markCopy: PREVIEW });
      await act(s);
      expect(ran).not.toContain(s);
      expect(await inertIn(s)).toBe(1);
    });

    it('twin: the same carry unflagged leaves an install an install', async () => {
      const s = await legacy();
      await hostFor().restoreScopeLocal(s, await hostFor().exportScopeLocal(s), { sourceScopeId: s, exact: true });
      await act(s);
      expect(ran).toContain(s);
      expect(await originOf(s)).toEqual([]);
    });

    it('the repair verb stamps once, answers whether it did, and then holds it inert', async () => {
      const s = await legacy();
      expect(await hostFor().markCopyLocal(s, PREVIEW)).toEqual({ marked: true });
      expect(await hostFor().markCopyLocal(s, PREVIEW)).toEqual({ marked: false });
      await act(s);
      expect(ran).not.toContain(s);
    });

    it('refuses to mark a scope its classification says is primary — by restore or by the verb', async () => {
      const s = await legacy();
      await expect(hostFor().markCopyLocal(s, INSTALL)).rejects.toThrow(/primary/);
      await expect(
        hostFor().restoreScopeLocal(s, await hostFor().exportScopeLocal(s), { sourceScopeId: s, exact: true, markCopy: INSTALL }),
      ).rejects.toThrow(/primary/);
      expect(await originOf(s)).toEqual([]);
      await act(s);
      expect(ran).toContain(s);
    });

    it("clears a primary's mistaken mark, and its executors run again", async () => {
      const s = await legacy();
      await hostFor().markCopyLocal(s, PREVIEW);
      expect(await hostFor().clearCopyMarkLocal(s, INSTALL)).toEqual({ cleared: true });
      expect(await hostFor().clearCopyMarkLocal(s, INSTALL)).toEqual({ cleared: false });
      await act(s);
      expect(ran).toContain(s);
    });

    it('refuses to clear a scope classified a copy', async () => {
      const s = await legacy();
      await hostFor().markCopyLocal(s, PREVIEW);
      await expect(hostFor().clearCopyMarkLocal(s, PREVIEW)).rejects.toThrow(/copy/);
      await act(s);
      expect(ran).not.toContain(s);
    });

    it("the next case along: marking a load's origin sets the classification and keeps its mark and source", async () => {
      const copy = scopeId.parse(ulid());
      await hostFor().restoreScopeLocal(copy, await hostFor().exportScopeLocal(install), { sourceScopeId: install });
      const [before] = await originOf(copy);
      expect(before).toBeDefined();
      expect(await hostFor().markCopyLocal(copy, FORK())).toEqual({ marked: true });
      expect(await hostFor().markCopyLocal(copy, FORK())).toEqual({ marked: false });
      const marked = { ...before, is_copy: 1 };
      expect(await originOf(copy)).toEqual([marked]);
      await hostFor().restoreScopeLocal(copy, await hostFor().exportScopeLocal(copy), { sourceScopeId: copy, exact: true, markCopy: FORK() });
      expect(await originOf(copy)).toEqual([marked]);
    });
  });

  it("the next case along: the install's own backup returned to it is still the install", async () => {
    await hostFor().restoreScopeLocal(install, await hostFor().exportScopeLocal(install), { sourceScopeId: install });
    const before = ran.length;
    await act(install);
    expect(ran.slice(before)).toEqual([install]);
  });

  // #2009: a load into another scope id moves the copied-events mark and classifies nothing. One
  // install's backup restored onto another install is such a load, and the directory still calls
  // the destination primary, so its own effects run, while the work it copied never does.
  describe('the copied-events mark and the copy classification are separate facts (#2009)', () => {
    /** A host with no executor: an event emitted through it stays queued for every executor. */
    const quiet = () => new CloudflareScopeHost({ scope: env.SCOPE });
    /** An install holding one event no executor has reached yet, and that event's id. */
    const queuedSource = async () => {
      const s = scopeId.parse(ulid());
      await seat(s);
      await act(s, quiet());
      const outbox = (await hostFor().exportScopeLocal(s)).find((d) => d.name === '_substrat_outbox')!;
      const id = outbox.rows.map((r) => (r as unknown[])[outbox.columns.indexOf('id')] as string).sort().at(-1)!;
      return { s, id };
    };
    /** A dump as a kernel before #2009 wrote it: the origin row has no `is_copy` column. */
    const withoutClassification = (dump: Awaited<ReturnType<CloudflareScopeHost['exportScopeLocal']>>) =>
      dump.map((d) => {
        if (d.name !== '_substrat_copy_origin') return d;
        const at = d.columns.indexOf('is_copy');
        if (at < 0) return d;
        return {
          ...d,
          columns: d.columns.filter((_, i) => i !== at),
          rows: d.rows.map((r) => (r as unknown[]).filter((_, i) => i !== at)),
        };
      });

    it('twin: the queued event is real work, which its own scope runs', async () => {
      const src = await queuedSource();
      await act(src.s);
      expect(ranIds).toContain(src.id);
    });

    it("one install's backup restored onto another install: its own executors run, and the copied event never does", async () => {
      const src = await queuedSource();
      const dest = scopeId.parse(ulid());
      await hostFor().restoreScopeLocal(dest, await hostFor().exportScopeLocal(src.s), { sourceScopeId: src.s });
      expect(await originOf(dest)).toEqual([
        expect.objectContaining({ source_scope_id: src.s, events_through: src.id, is_copy: 0 }),
      ]);
      const before = ranIds.length;
      await act(dest);
      expect(ran).toContain(dest);
      expect(await inertIn(dest)).toBe(0);
      expect(ranIds.slice(before)).toHaveLength(1);
      expect(ranIds).not.toContain(src.id);
      expect((await hostFor().drainDue(t, dest)).attempted).toBe(0);
      expect(ranIds).not.toContain(src.id);
    });

    it('the same load flagged by the directory (a preview fork) is held inert, and its copied event never runs', async () => {
      const src = await queuedSource();
      const dest = scopeId.parse(ulid());
      await hostFor().restoreScopeLocal(dest, await hostFor().exportScopeLocal(src.s), {
        sourceScopeId: src.s,
        markCopy: FORK(src.s),
      });
      expect(await originOf(dest)).toEqual([expect.objectContaining({ events_through: src.id, is_copy: 1 })]);
      await act(dest);
      expect(ran).not.toContain(dest);
      expect(await inertIn(dest)).toBe(1);
      expect(ranIds).not.toContain(src.id);
    });

    it("a load classifies by the directory, not by the dump: a copy's export restored onto an install is not a copy", async () => {
      const src = await queuedSource();
      const preview = scopeId.parse(ulid());
      await hostFor().restoreScopeLocal(preview, await hostFor().exportScopeLocal(src.s), {
        sourceScopeId: src.s,
        markCopy: FORK(src.s),
      });
      const dest = scopeId.parse(ulid());
      await hostFor().restoreScopeLocal(dest, await hostFor().exportScopeLocal(preview), { sourceScopeId: preview });
      expect(await originOf(dest)).toEqual([
        expect.objectContaining({ source_scope_id: preview, events_through: src.id, is_copy: 0 }),
      ]);
      await act(dest);
      expect(ran).toContain(dest);
      expect(ranIds).not.toContain(src.id);
    });

    it('a legacy origin row (before the column) still reads as a copy; clearing it lets the scope run and keeps the copied event held', async () => {
      const src = await queuedSource();
      const dest = scopeId.parse(ulid());
      await hostFor().restoreScopeLocal(dest, await hostFor().exportScopeLocal(src.s), { sourceScopeId: src.s });
      // The same store as a pre-#2009 kernel left it: a backup of it, returned to it.
      await hostFor().restoreScopeLocal(dest, withoutClassification(await hostFor().exportScopeLocal(dest)), {
        sourceScopeId: dest,
        exact: true,
      });
      const [legacy] = await originOf(dest);
      expect(legacy).toMatchObject({ events_through: src.id, is_copy: null });
      await act(dest);
      expect(ran).not.toContain(dest);
      expect(await inertIn(dest)).toBe(1);

      // Staff's correction clears the classification only; before #2009 it refused this row.
      expect(await hostFor().clearCopyMarkLocal(dest, INSTALL)).toEqual({ cleared: true });
      expect(await hostFor().clearCopyMarkLocal(dest, INSTALL)).toEqual({ cleared: false });
      expect(await originOf(dest)).toEqual([{ ...legacy, is_copy: 0 }]);
      const before = ranIds.length;
      await act(dest);
      expect(ran).toContain(dest);
      expect(ranIds.slice(before)).toHaveLength(1);
      expect(ranIds).not.toContain(src.id);
      expect((await hostFor().drainDue(t, dest)).attempted).toBe(0);
      expect(ranIds).not.toContain(src.id);
    });
  });
});

/**
 * #1713 on a CP-LESS host: suspension reaches a hosted vertical only as the lifecycle the platform
 * delivers to the scope's own storage (`setLifecycleLocal`, behind `/internal/lifecycle`). Every
 * door that runs the scope's work reads it — a request's stub, the system door a schedule and a job
 * take, the retry driver, the job runner — and the entry points that defer rather than refuse (the
 * schedule run, freshness, the executor drain) leave everything due. An operator's reads still work.
 */
describe('a CP-less host holds a scope by the lifecycle delivered to it (#1713)', () => {
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const USE = permissionKey.parse('perm:use');
  const SCHED = moduleId.parse('@test/sched');
  const ran: string[] = [];
  let clock = Date.parse('2026-10-01T00:00:00.000Z');
  /** A lifecycle read now, later than every one before it, as the platform stamps each read. */
  const life = (scope: ScopeLifecycle['scope'], tenant: ScopeLifecycle['tenant'] = 'active'): ScopeLifecycle => ({
    scope,
    tenant,
    at: new Date((clock += 1000)).toISOString() as ScopeLifecycle['at'],
  });

  const hostFor = () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE });
    host.registerModule(scheduleMod);
    host.registerExecutor('lifecycle-effector', 'perm.acted', async (_admin, event) => {
      ran.push(event.scopeId);
    });
    return host;
  };
  const seat = async () => {
    const s = scopeId.parse(ulid());
    await hostFor().provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    return s;
  };
  const act = async (s: ScopeId) =>
    (await hostFor().getScope(owner, t, s)).invoke('perm/authorized-emit', { permission: USE });
  const revisionOf = (s: ScopeId) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_i, state) =>
      (state.storage.sql.exec(`SELECT value FROM _substrat_meta WHERE key = 'write_revision'`).toArray()[0] as
        | { value: string }
        | undefined)?.value ?? null,
    );

  it('twin: a scope with no lifecycle, and one delivered active, run everything', async () => {
    const bare = await seat();
    expect(await hostFor().lifecycleHeld(bare)).toBe(false);
    await act(bare);
    expect(ran).toContain(bare);
    const live = await seat();
    await hostFor().setLifecycleLocal(live, life('active'));
    expect(await hostFor().lifecycleHeld(live)).toBe(false);
    await act(live);
    expect(ran).toContain(live);
    expect((await hostFor().runDueSchedules(SCHED, t, live)).fired).toBe(2);
  });

  it('a suspended scope refuses every door, defers its schedules, its deliveries and its freshness, and resumes', async () => {
    const s = await seat();
    // A stub minted while the scope was live: the request already past the gate when the
    // suspension landed. Its write commits; the effect it raises is deferred, not run.
    const early = await hostFor().getScope(owner, t, s);
    expect(await hostFor().setLifecycleLocal(s, life('suspended'))).toMatchObject({ applied: true, changed: true });
    expect(await hostFor().lifecycleHeld(s)).toBe(true);

    const refused = /scope not active \(status: suspended\)/;
    await expect(act(s)).rejects.toThrow(refused);
    await expect(hostFor().getSystemScope(SCHED, t, s)).rejects.toThrow(refused);
    await expect(hostFor().drainDue(t, s)).rejects.toThrow(refused);
    await expect(hostFor().runDueJobs(t, s)).rejects.toThrow(refused);
    await expect(hostFor().attachments(owner, t, s)).rejects.toThrow(refused);

    const schedules = await hostFor().runDueSchedules(SCHED, t, s);
    expect(schedules).toMatchObject({ fired: 0, failed: 0, skipped: 2, lifecycleHeld: true });
    expect((await hostFor().checkFreshness(SCHED, t, s)).checks).toEqual([]);

    await early.invoke('perm/authorized-emit', { permission: USE });
    expect(ran).not.toContain(s);
    // An operator still reads it, and nothing was journaled against the delivery.
    expect(await hostFor().executorDeadLetters(t, s)).toEqual([]);
    await expect(hostFor().jobRuns(t, s)).resolves.toEqual([]);

    expect(await hostFor().setLifecycleLocal(s, life('active'))).toMatchObject({ applied: true, changed: true });
    // The delivery that waited, delivered once; the schedule that came due, fired once.
    const drained = await hostFor().drainDue(t, s);
    expect(drained).toMatchObject({ attempted: 1, delivered: 1 });
    expect(drained.lifecycleHeld).toBeUndefined();
    expect(ran.filter((x) => x === s)).toEqual([s]);
    expect((await hostFor().runDueSchedules(SCHED, t, s)).fired).toBe(2);
    await act(s);
    expect(ran.filter((x) => x === s)).toEqual([s, s]);
  });

  it('a held tenant holds its scope in the directory\'s words — suspended and deleting alike', async () => {
    const s = await seat();
    await hostFor().setLifecycleLocal(s, life('active', 'suspended'));
    await expect(act(s)).rejects.toThrow(`tenant not active (status: suspended): ${t}`);
    await hostFor().setLifecycleLocal(s, life('active', 'deleting'));
    await expect(hostFor().getSystemScope(SCHED, t, s)).rejects.toThrow(/tenant not active \(status: deleting\)/);
    expect((await hostFor().runDueSchedules(SCHED, t, s)).lifecycleHeld).toBe(true);
    await hostFor().setLifecycleLocal(s, life('active', 'active'));
    await act(s);
    expect(ran).toContain(s);
  });

  it('an archived scope is held too', async () => {
    const s = await seat();
    await hostFor().setLifecycleLocal(s, life('archived'));
    await expect(act(s)).rejects.toThrow(/scope not active \(status: archived\)/);
  });

  it('a late delivery cannot undo a later one: the newest read wins', async () => {
    const s = await seat();
    const older = life('active');
    const newer = life('suspended');
    await hostFor().setLifecycleLocal(s, newer);
    expect(await hostFor().setLifecycleLocal(s, older)).toEqual({ applied: false, changed: false, lifecycle: newer });
    expect(await hostFor().lifecycleHeld(s)).toBe(true);
    // A repeat of the same read is applied (idempotent) and moves nothing.
    expect(await hostFor().setLifecycleLocal(s, newer)).toMatchObject({ applied: true, changed: false });
  });

  it('a delivery is bookkeeping: it does not advance the write revision a carry fences on', async () => {
    const s = await seat();
    await act(s);
    const before = await revisionOf(s);
    await hostFor().setLifecycleLocal(s, life('suspended'));
    expect(await revisionOf(s)).toBe(before);
  });

  it("a backup from before the suspension, returned to the scope, does not lift it; a copy never inherits it", async () => {
    const s = await seat();
    const backup = await hostFor().exportScopeLocal(s);
    await hostFor().setLifecycleLocal(s, life('suspended'));
    await hostFor().restoreScopeLocal(s, backup, { sourceScopeId: s });
    expect(await hostFor().lifecycleHeld(s)).toBe(true);
    // The held scope's own dump carries its lifecycle; a copy of it is a scope of its own.
    const copy = scopeId.parse(ulid());
    await hostFor().restoreScopeLocal(copy, await hostFor().exportScopeLocal(s), { sourceScopeId: s });
    expect(await hostFor().lifecycleHeld(copy)).toBe(false);
  });

  it('twin: a dump that carries a NEWER lifecycle, returned to its scope, lands it', async () => {
    const s = await seat();
    await hostFor().setLifecycleLocal(s, life('suspended'));
    const held = await hostFor().exportScopeLocal(s);
    await hostFor().setLifecycleLocal(s, life('active'));
    // Captured before the unsuspend: the store's newer `active` wins over it.
    await hostFor().restoreScopeLocal(s, held, { sourceScopeId: s });
    expect(await hostFor().lifecycleHeld(s)).toBe(false);
  });
});
