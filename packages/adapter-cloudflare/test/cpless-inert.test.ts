import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CAPABILITY_SESSION_PREFIX,
  connectionId as connectionIdOf,
  errorCodeOf,
  moduleId,
  permissionKey,
  principalId,
  scopeId,
  tenantId,
  type ScopeId,
  type ScopeLifecycle,
  type TenantId,
} from '@substrat-run/contracts';
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
  let revision = 0;
  /**
   * A delivery newer than every one before it, as each directory change makes it: both revisions
   * move. `at` stays fixed, because nothing compares it.
   */
  const life = (scope: ScopeLifecycle['scope'], tenant: ScopeLifecycle['tenant'] = 'active'): ScopeLifecycle => {
    revision += 1;
    return { scope, tenant, at: '2026-10-01T00:00:00.000Z' as ScopeLifecycle['at'], revision: { epoch: 0, scope: revision, tenant: revision } };
  };
  /** A delivery at exact directory revisions (scope `sr`, tenant `tr`). */
  const at = (scope: ScopeLifecycle['scope'], tenant: ScopeLifecycle['tenant'], sr: number, tr: number): ScopeLifecycle => ({
    scope,
    tenant,
    at: '2026-10-01T00:00:00.000Z' as ScopeLifecycle['at'],
    revision: { epoch: 0, scope: sr, tenant: tr },
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

  it('a held scope is refused before its tenant\'s attachment bucket is resolved (#1995)', async () => {
    const s = await seat();
    const resolved: string[] = [];
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      attachmentBuckets: (tenant) => {
        resolved.push(tenant);
        return {};
      },
    });
    // The connector's bytes legs (#574, #711) reach the same bucket from the platform's side.
    const conn = connectionIdOf.parse(ulid());
    const upload = () =>
      host.connectorAttachmentUploadLocal(conn, t, s, {
        entity: { entityType: 'item', entityId: 'i1' },
        filename: 'a.txt',
        contentType: 'text/plain',
        visibility: 'customer',
        body: new TextEncoder().encode('a'),
      });
    const open = () => host.connectorAttachmentOpenLocal(conn, t, s, ulid());
    const refused = /scope not active \(status: suspended\)/;

    await host.setLifecycleLocal(s, life('suspended'));
    await expect(host.attachments(owner, t, s)).rejects.toThrow(refused);
    await expect(upload()).rejects.toThrow(refused);
    await expect(open()).rejects.toThrow(refused);
    expect(resolved).toEqual([]);

    // The twin: live again, each door gets past the gate to the tenant's bucket. What it does
    // there (this connection holds no grant) is the attachments suite's business, not this one's.
    await host.setLifecycleLocal(s, life('active'));
    await host.attachments(owner, t, s);
    expect(resolved).toEqual([t]);
    await upload().catch((e: unknown) => expect(String(e)).not.toMatch(refused));
    expect(resolved).toEqual([t, t]);
    await open().catch((e: unknown) => expect(String(e)).not.toMatch(refused));
    expect(resolved).toEqual([t, t, t]);
  });

  it('an archived scope is held too', async () => {
    const s = await seat();
    await hostFor().setLifecycleLocal(s, life('archived'));
    await expect(act(s)).rejects.toThrow(/scope not active \(status: archived\)/);
  });

  it("Codex's repro (#2019 review): active, suspended, then a LATE older active — refused, the scope stays held", async () => {
    const s = await seat();
    await hostFor().setLifecycleLocal(s, at('active', 'active', 1, 0));
    await hostFor().setLifecycleLocal(s, at('suspended', 'active', 2, 0));
    // The same `at` on all three: only the revision decides.
    expect(await hostFor().setLifecycleLocal(s, at('active', 'active', 1, 0))).toEqual({
      applied: false,
      changed: false,
      lifecycle: at('suspended', 'active', 2, 0),
    });
    expect(await hostFor().lifecycleHeld(s)).toBe(true);
    await expect(act(s)).rejects.toThrow(/scope not active \(status: suspended\)/);
  });

  it('an equal revision is refused, whatever state it carries', async () => {
    const s = await seat();
    await hostFor().setLifecycleLocal(s, at('suspended', 'active', 4, 2));
    expect(await hostFor().setLifecycleLocal(s, at('suspended', 'active', 4, 2))).toMatchObject({ applied: false, changed: false });
    expect(await hostFor().setLifecycleLocal(s, at('active', 'active', 4, 2))).toMatchObject({ applied: false });
    expect(await hostFor().lifecycleHeld(s)).toBe(true);
  });

  it('interleaved tenant and scope changes, delivered out of order, settle on the latest', async () => {
    const s = await seat();
    const tenantSuspend = at('active', 'suspended', 0, 1);
    const scopeSuspend = at('suspended', 'suspended', 1, 1);
    const tenantLift = at('suspended', 'active', 1, 2);
    const scopeLift = at('active', 'active', 2, 2);
    // The tenant lift lands first, then the two older deliveries straggle in.
    expect((await hostFor().setLifecycleLocal(s, tenantLift)).applied).toBe(true);
    expect((await hostFor().setLifecycleLocal(s, tenantSuspend)).applied).toBe(false);
    expect((await hostFor().setLifecycleLocal(s, scopeSuspend)).applied).toBe(false);
    await expect(act(s)).rejects.toThrow(/scope not active \(status: suspended\)/); // held by the scope, not the tenant
    expect(await hostFor().setLifecycleLocal(s, scopeLift)).toMatchObject({ applied: true, changed: true });
    await act(s);
    expect(ran).toContain(s);
  });

  it('a row stored before revisions still holds, and any revisioned delivery replaces it', async () => {
    const s = await seat();
    await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_i, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('scope_lifecycle', ?)`,
        JSON.stringify({ scope: 'suspended', tenant: 'active', at: '2026-09-30T00:00:00.000Z' }),
      );
    });
    expect(await hostFor().lifecycleHeld(s)).toBe(true);
    expect(await hostFor().setLifecycleLocal(s, at('active', 'active', 0, 0))).toMatchObject({ applied: true, changed: true });
    expect(await hostFor().lifecycleHeld(s)).toBe(false);
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

/**
 * #2016 on a CP-LESS host: no directory re-checks the (tenant, scope) pair the router asserted, so
 * the scope's own storage does — against the tenant it was provisioned for (its `provisioned_for`
 * receipt, #1738). Every door refuses a pair it does not agree with in K-3's words, BEFORE any
 * guard, handler or store lookup runs: no attachment bucket is resolved, no denial is journaled
 * (the permission gate never ran), nothing is written. Each refusal has its own-tenant twin.
 */
describe('a CP-less host refuses a (tenant, scope) pair its scope was not provisioned for (#2016)', () => {
  const t = tenantId.parse(ulid());
  const u = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const USE = permissionKey.parse('perm:use');
  const SCHED = moduleId.parse('@test/sched');
  const conn = connectionIdOf.parse(ulid());
  const TOKEN = `${CAPABILITY_SESSION_PREFIX}${'a'.repeat(43)}`;
  const resolved: string[] = [];
  let revision = 0;
  const life = (scope: ScopeLifecycle['scope'] = 'active'): ScopeLifecycle => {
    revision += 1;
    return { scope, tenant: 'active', at: '2026-10-01T00:00:00.000Z' as ScopeLifecycle['at'], revision: { epoch: 0, scope: revision, tenant: revision } };
  };

  const hostFor = () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      attachmentBuckets: (tenant) => {
        resolved.push(tenant);
        return {};
      },
    });
    host.registerModule(scheduleMod);
    return host;
  };
  const seat = async (tenant: TenantId = t) => {
    const s = scopeId.parse(ulid());
    await hostFor().provisionScopeLocal({
      tenantId: tenant,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    return s;
  };
  const stubOf = (s: ScopeId) => env.SCOPE.get(env.SCOPE.idFromName(s));
  const sql = (s: ScopeId, q: string, ...params: unknown[]) =>
    runInDurableObject(stubOf(s), (_i, state) => state.storage.sql.exec(q, ...(params as never[])).toArray());
  const receiptOf = async (s: ScopeId) =>
    ((await sql(s, `SELECT value FROM _substrat_meta WHERE key = 'provisioned_for'`))[0] as { value: string } | undefined)?.value ?? null;
  const dropReceipt = (s: ScopeId) => sql(s, `DELETE FROM _substrat_meta WHERE key = 'provisioned_for'`);
  const stray = (s: ScopeId, tenant: TenantId) =>
    sql(s, `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source, revoked_at) VALUES (?, 'stray', '[]', 'vertical', NULL)`, tenant);
  const denials = async (s: ScopeId) => Number(((await sql(s, 'SELECT COUNT(*) AS n FROM _substrat_denials'))[0] as { n: number }).n);
  const outcome = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);
  /** K-3's refusal, exactly: typed `not_found`, naming the pair asked for. */
  const isPairRefusal = (e: unknown, tenant: TenantId, s: ScopeId) =>
    errorCodeOf(e) === 'not_found' && String((e as Error).message).includes(`unknown scope for tenant: (${tenant}, ${s})`);

  /** Every door into a scope, called as `tenant`. */
  const doors: Record<string, (tenant: TenantId, s: ScopeId) => Promise<unknown>> = {
    invoke: async (x, s) => (await hostFor().getScope(owner, x, s)).invoke('perm/authorized-emit', { permission: USE }),
    system: (x, s) => hostFor().getSystemScope(SCHED, x, s),
    attachments: (x, s) => hostFor().attachments(owner, x, s),
    capabilityExchange: (x, s) => hostFor().exchangeCapability(x, s, 'not-a-capability-secret'),
    capabilityScope: async (x, s) => (await hostFor().getCapabilityScope(TOKEN, x, s)).invoke('perm/authorized-emit', { permission: USE }),
    capabilityAttachments: (x, s) => hostFor().getCapabilityAttachments(TOKEN, x, s),
    peer: (x, s) => hostFor().getVerticalScope({ vertical: 'other-app', scope: scopeId.parse(ulid()) }, x, s),
    connectorInvoke: (x, s) => hostFor().connectorInvokeLocal(conn, x, s, 'perm/authorized-emit', { permission: USE }),
    connectorUpload: (x, s) =>
      hostFor().connectorAttachmentUploadLocal(conn, x, s, {
        entity: { entityType: 'item', entityId: 'i1' },
        filename: 'a.txt',
        contentType: 'text/plain',
        visibility: 'customer',
        body: new TextEncoder().encode('a'),
      }),
    connectorOpen: (x, s) => hostFor().connectorAttachmentOpenLocal(conn, x, s, ulid()),
    startJob: (x, s) => hostFor().startJobRun(x, s, { moduleId: SCHED, job: 'noop' }),
    runJobs: (x, s) => hostFor().runDueJobs(x, s),
    jobRuns: (x, s) => hostFor().jobRuns(x, s),
    drain: (x, s) => hostFor().drainDue(x, s),
    deadLetters: (x, s) => hostFor().executorDeadLetters(x, s),
    platformRequests: (x, s) => hostFor().listPlatformRequests(x, s),
  };

  it.each(Object.keys(doors))('%s: the mismatched pair is refused at the door; the provisioned tenant is let through', async (door) => {
    const s = await seat();
    resolved.length = 0;
    const before = await denials(s);
    const refused = await outcome(doors[door]!(u, s));
    expect(isPairRefusal(refused, u, s)).toBe(true);
    // Refused before anything ran: no bucket resolved, no permission check journaled, no job.
    expect(resolved).toEqual([]);
    expect(await denials(s)).toBe(before);
    expect(await hostFor().jobRuns(t, s)).toEqual([]);
    // The twin: whatever the door does next for its own tenant, it is not this refusal.
    const own = await outcome(doors[door]!(t, s));
    expect(isPairRefusal(own, t, s)).toBe(false);
  });

  it('the refusal holds however much the tenant holds: a stray role row for it does not let it in', async () => {
    const s = await seat();
    await stray(s, u);
    expect(isPairRefusal(await outcome(doors.invoke!(u, s)), u, s)).toBe(true);
    await doors.invoke!(t, s);
  });

  it('a scope provisioned before the receipt existed is judged by its role rows', async () => {
    const s = await seat();
    await dropReceipt(s);
    expect(isPairRefusal(await outcome(doors.invoke!(u, s)), u, s)).toBe(true);
    await doors.invoke!(t, s);
    // Nothing back-filled it: a door is a read, and a request's tenant is never recorded.
    expect(await receiptOf(s)).toBeNull();
  });

  it('a scope that holds neither a receipt nor roles has nothing to hold the pair against, and refuses no one', async () => {
    // A load from a world that keeps its roles elsewhere, before its repair: the permission gate
    // still decides what anyone may do in it, exactly as before the cross-check.
    const s = scopeId.parse(ulid());
    await hostFor().restoreScopeLocal(s, []);
    expect(await receiptOf(s)).toBeNull();
    for (const tenant of [t, u]) expect(isPairRefusal(await outcome(doors.system!(tenant, s)), tenant, s)).toBe(false);
  });

  describe('the back-fill: only from the platform\'s word, never from a request', () => {
    it('a lifecycle delivery records the tenant on a legacy scope whose role rows agree; then a stray row stops counting', async () => {
      const s = await seat();
      await dropReceipt(s);
      await stray(s, u);
      // Legacy and holding a row for `u`: by inference alone, `u` gets in.
      expect(isPairRefusal(await outcome(doors.invoke!(u, s)), u, s)).toBe(false);
      expect(await hostFor().setLifecycleLocal(s, life(), t)).toMatchObject({ applied: true });
      expect(await receiptOf(s)).toBe(t);
      expect(isPairRefusal(await outcome(doors.invoke!(u, s)), u, s)).toBe(true);
      await doors.invoke!(t, s);
    });

    it('a delivery for a tenant the scope is foreign to is refused and stores nothing', async () => {
      const s = await seat();
      const e = await outcome(hostFor().setLifecycleLocal(s, life('suspended'), u));
      expect(errorCodeOf(e)).toBe('conflict');
      expect(String((e as Error).message)).toContain(t);
      expect(await hostFor().lifecycleHeld(s)).toBe(false);
      expect(await receiptOf(s)).toBe(t);
      // The legacy twin: foreign by its role rows, refused the same way, and nothing recorded.
      await dropReceipt(s);
      expect(errorCodeOf(await outcome(hostFor().setLifecycleLocal(s, life('suspended'), u)))).toBe('conflict');
      expect(await receiptOf(s)).toBeNull();
      expect(await hostFor().lifecycleHeld(s)).toBe(false);
    });

    it('a delivery to a scope never provisioned here records no receipt, and one without a tenant records none either', async () => {
      const bare = scopeId.parse(ulid());
      await hostFor().restoreScopeLocal(bare, []);
      await hostFor().setLifecycleLocal(bare, life(), t);
      expect(await receiptOf(bare)).toBeNull();
      // An older platform names no tenant: delivered as before, nothing recorded.
      const legacy = await seat();
      await dropReceipt(legacy);
      expect(await hostFor().setLifecycleLocal(legacy, life())).toMatchObject({ applied: true });
      expect(await receiptOf(legacy)).toBeNull();
    });

    it('a reconcile (the provision path) back-fills too', async () => {
      const s = await seat();
      await dropReceipt(s);
      await hostFor().projectRolesLocal(t, s, [{ key: 'office-admin', permissions: [USE], source: 'vertical' }]);
      expect(await receiptOf(s)).toBe(t);
    });
  });

  describe('copies and forks record their own tenant, never the source\'s', () => {
    it('a snapshot records the tenant the platform names; a source of another tenant is refused before anything is copied', async () => {
      const source = await seat();
      const snap = scopeId.parse(ulid());
      await hostFor().snapshotScopeLocal(source, snap, t);
      expect(await receiptOf(snap)).toBe(t);
      await doors.invoke!(t, snap);
      expect(isPairRefusal(await outcome(doors.invoke!(u, snap)), u, snap)).toBe(true);

      const leak = scopeId.parse(ulid());
      expect(isPairRefusal(await outcome(hostFor().snapshotScopeLocal(source, leak, u)), u, source)).toBe(true);
      // Nothing was copied: the would-be fork holds none of the source's roles, and no receipt.
      expect(await sql(leak, 'SELECT tenant_id FROM _substrat_roles')).toEqual([]);
      expect(await receiptOf(leak)).toBeNull();
    });

    it('an older platform\'s snapshot (no tenant) leaves the fork judged by its copied role rows', async () => {
      const source = await seat();
      const snap = scopeId.parse(ulid());
      await hostFor().snapshotScopeLocal(source, snap);
      expect(await receiptOf(snap)).toBeNull();
      expect(isPairRefusal(await outcome(doors.invoke!(u, snap)), u, snap)).toBe(true);
      await doors.invoke!(t, snap);
    });

    it('a copy of another tenant\'s dump into a fresh scope records the restoring tenant', async () => {
      const source = await seat(u);
      const copy = scopeId.parse(ulid());
      await hostFor().restoreScopeLocal(copy, await hostFor().exportScopeLocal(source), { sourceScopeId: source, tenantId: t });
      expect(await receiptOf(copy)).toBe(t);
      expect(isPairRefusal(await outcome(doors.system!(u, copy)), u, copy)).toBe(true);
      expect(isPairRefusal(await outcome(doors.system!(t, copy)), t, copy)).toBe(false);
    });

    it('a restore keeps the scope\'s own receipt across the load, and one naming another tenant is refused untouched', async () => {
      const own = await seat();
      const other = await seat(u);
      const theirs = await hostFor().exportScopeLocal(other);
      // No tenant named (an older platform): the store keeps its own receipt, never the dump's.
      await hostFor().restoreScopeLocal(own, theirs, { sourceScopeId: other });
      expect(await receiptOf(own)).toBe(t);
      // The platform naming a tenant the store was not provisioned for: refused before the drops.
      const mine = await seat();
      const outbox = () => sql(mine, 'SELECT COUNT(*) AS n FROM _substrat_outbox');
      await doors.invoke!(t, mine);
      const before = await outbox();
      const e = await outcome(hostFor().restoreScopeLocal(mine, theirs, { sourceScopeId: other, tenantId: u }));
      expect(errorCodeOf(e)).toBe('conflict');
      expect(await receiptOf(mine)).toBe(t);
      expect(await outbox()).toEqual(before);
      // The twin: the same restore for its own tenant lands.
      await hostFor().restoreScopeLocal(mine, theirs, { sourceScopeId: other, tenantId: t });
      expect(await receiptOf(mine)).toBe(t);
    });
  });
});
