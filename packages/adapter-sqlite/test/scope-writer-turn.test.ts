/**
 * Every scope-level admin write takes a turn on the scope actor (#1678).
 *
 * The hazard #1577 found for the job store and #1666 for the kill switch, swept for the
 * rest: `invoke` opens a raw `BEGIN IMMEDIATE` on the scope's connection and HOLDS IT
 * ACROSS AWAITS. A plain statement issued meanwhile joined that transaction, and a
 * `db.transaction` became a SAVEPOINT in it — so a stranger's ROLLBACK undid the write
 * after the verb had answered success and audited it. A grant vanished; a revoked role
 * came back; a drained batch was offered to the lake again.
 *
 * Each writer gets its own case of one shape: an operation suspends inside its open
 * transaction, the writer is issued, the operation ROLLS BACK, and the write is still
 * there. The oracle is a SEPARATE read-only connection on the scope's file, which sees
 * only what was committed — the question is exactly "did it survive", and the host's
 * own connection would be the wrong one to ask. The twin runs every writer with nothing
 * in flight; the re-entrant case calls each from inside the scope's own actor task,
 * under a time bound, so a turn that queued behind itself fails instead of hanging.
 *
 * ADAPTER-SPECIFIC, for the reason `job-store-turn.test.ts` gives: the Durable Object
 * serializes its RPCs, so a shared-suite version would assert nothing on the hosted side.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectionId,
  dataSubjectId,
  moduleManifest,
  orgId,
  permissionKey,
  platformActorId,
  principalId,
  roleKey,
  scopeId,
  tenantId,
  type ScopeId,
} from '@substrat-run/contracts';
import {
  ulid,
  UNSAFE_allowAllChecker,
  webCryptoSecretBox,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

const VERTICAL = 'lever-vertical';
const LEVER = '@test/lever';

/** Hooks the `lever/tick` schedule calls — set by the one case that needs it. */
let onTick: (() => void) | undefined;

/** A module with one schedule and one freshness expectation, whose tick the test drives. */
const leverMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: LEVER,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [
      { key: 'lever:tick', description: 'run the scheduled tick' },
      { key: 'lever:use', description: 'a permission the writers grant' },
    ],
    events: {
      emits: [
        { type: 'lever.happened', schemaVersion: 1 },
        { type: 'lever.erase-requested', schemaVersion: 1 },
      ],
      consumes: [],
    },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'lever',
    schedules: [{ operation: 'lever/tick', cadence: { everyMinutes: 60 }, permissions: ['lever:tick'] }],
    freshness: [{ eventType: 'lever.happened', within: { hours: 1 } }],
  }),
  migrations: [],
  operations: {
    'lever/tick': (() => {
      onTick?.();
    }) as OperationHandler<never, unknown>,
  },
};

describe('scope-level admin writes survive a concurrent operation that rolls back (#1678)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-writer-turn-'));
  const host = new SqliteScopeHost({
    dir,
    checker: UNSAFE_allowAllChecker,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const alice = principalId.parse(ulid());
  const USE = permissionKey.parse('lever:use');
  const ROLE = roleKey.parse('lever-role');
  const subject = dataSubjectId.parse(ulid());

  /** The scope the `eraser` executor acts on, and whether it got to the end. */
  let erasing!: ScopeId;
  let erased = false;

  /** Set per case: the held operation announces it is inside its transaction, then waits. */
  let entered!: () => void;
  let held!: Promise<void>;

  const newScope = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: VERTICAL });
    await host.admin.activateScope(staff, t, s);
    return s;
  };
  /** An operation in flight and suspended INSIDE its transaction, released by the test. */
  const holdOpen = async (s: ScopeId, op = 'gate/hold') => {
    let release!: () => void;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = (await host.getScope(alice, t, s)).invoke(op);
    await inside;
    return { blocked, release };
  };
  /**
   * The case's shape: hold an operation open, issue `write` WITHOUT awaiting it (with the
   * turn it cannot finish until the operation has, so awaiting it here would deadlock the
   * test rather than fail it), roll the operation back, then hand back the write's result.
   */
  const underRollback = async <T>(s: ScopeId, write: () => Promise<T>, op = 'gate/hold'): Promise<T> => {
    const { blocked, release } = await holdOpen(s, op);
    const writing = write();
    release();
    await expect(blocked).rejects.toThrow(/always rolls back/);
    return writing;
  };
  /** A promise that fails the case instead of hanging it. */
  const within = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms))]);

  /** The COMMITTED state of a scope's file, read on a connection of its own. */
  const committed = <T>(s: ScopeId, sql: string, ...params: unknown[]): T[] => {
    const db = new Database(join(dir, `${t}__${s}.sqlite`), { readonly: true });
    try {
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  };
  const tuple = (s: ScopeId, subj: string, relation: string) =>
    committed<{ revoked_at: string | null }>(
      s,
      'SELECT revoked_at FROM _substrat_tuples WHERE subject = ? AND relation = ? AND object = ?',
      subj,
      relation,
      `scope:${s}`,
    );
  const liveTuple = (s: ScopeId, subj: string, relation: string) =>
    tuple(s, subj, relation).filter((r) => r.revoked_at === null).length === 1;
  const seat = (_s: ScopeId) => `system:${LEVER}`;
  const cadence = (s: ScopeId, kind: 'schedule' | 'freshness', op: string) =>
    committed<{ last_run_at: string }>(
      s,
      'SELECT last_run_at FROM _substrat_schedule_state WHERE kind = ? AND schedule_op = ?',
      kind,
      op,
    );
  const outbox = (s: ScopeId) =>
    committed<{ id: string; drained_at: string | null; payload: string | null }>(
      s,
      "SELECT id, drained_at, payload FROM _substrat_outbox WHERE type = 'lever.happened' ORDER BY id",
    );
  const emit = async (s: ScopeId) => (await host.getScope(alice, t, s)).invoke('gate/emit');
  const undrained = async (s: ScopeId) => (await host.admin.readUndrainedEvents(staff, t, s)).map((e) => e.id);

  const newOrg = async () => {
    const id = orgId.parse(ulid());
    await host.admin.createOrg(staff, { id, tenantId: t, slug: `org-${id.toLowerCase()}`, name: 'Lever org' });
    return id;
  };
  /** One live connection per (tenant, vertical, provider) — made once, granted per scope. */
  let conn!: ReturnType<typeof connectionId.parse>;

  // The writers, one closure each, so the rollback cases, the twin and the re-entrant
  // case all issue exactly the same call.
  const grant = (s: ScopeId, who = alice) =>
    host.admin.grant(staff, { principalId: who, permission: USE, node: { tenantId: t, scopeId: s }, grantedBy: alice });
  const grantToOrg = (s: ScopeId, org: ReturnType<typeof orgId.parse>) =>
    host.admin.grantToOrg(staff, org, USE, { tenantId: t, scopeId: s });
  const grantToConnection = (s: ScopeId) =>
    host.admin.grantToConnection(staff, { connectionId: conn, permission: USE, node: { tenantId: t, scopeId: s }, grantedBy: staff });
  const assign = (s: ScopeId) =>
    host.admin.assignRole(staff, { principalId: alice, roleKey: ROLE, node: { tenantId: t, scopeId: s } });
  const unassign = (s: ScopeId) =>
    host.admin.unassignRole(staff, { principalId: alice, roleKey: ROLE, node: { tenantId: t, scopeId: s } });
  const reprovision = (s: ScopeId) => host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: VERTICAL });
  const drain = (s: ScopeId, ids: string[]) => host.admin.markEventsDrained(staff, t, s, ids);
  const redrain = (s: ScopeId) => host.admin.redrainEvents(staff, t, s, { drainedBefore: new Date().toISOString() });
  const shred = (s: ScopeId) => host.admin.shredSubject(staff, t, s, subject);
  /** Un-seat the schedule's grant on a connection of its own, so a re-provision has one to seat. */
  const unseat = (s: ScopeId) => {
    const db = new Database(join(dir, `${t}__${s}.sqlite`));
    try {
      db.prepare('DELETE FROM _substrat_tuples WHERE subject = ?').run(seat(s));
    } finally {
      db.close();
    }
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  beforeAll(async () => {
    host.registerModule(leverMod);
    // Suspends inside its own `BEGIN IMMEDIATE`, then throws so the transaction ROLLS BACK
    // — a commit would carry a joined write along and hide the bug.
    host.defineOperation('gate/hold', async () => {
      entered();
      await held;
      throw new Error('this operation always rolls back');
    });
    // Emits the event the freshness expectation watches, THEN suspends and rolls back — so
    // the event exists only in an uncommitted transaction (#1678 review).
    host.defineOperation('gate/hold-emit', (async (ctx) => {
      ctx.emit({
        type: 'lever.happened',
        schemaVersion: 1,
        entity: { entityType: 'lever', entityId: 'l1' },
        piiClass: 'none',
        payload: {},
      });
      entered();
      await held;
      throw new Error('this operation always rolls back');
    }) as OperationHandler<never, unknown>);
    // One event carrying the data subject, so there is something to drain and to shred.
    host.defineOperation('gate/emit', ((ctx) => {
      ctx.emit({
        type: 'lever.happened',
        schemaVersion: 1,
        entity: { entityType: 'lever', entityId: 'l1' },
        piiClass: 'direct',
        subjectId: subject,
        payload: { said: 'hello' },
      });
    }) as OperationHandler<never, unknown>);
    // #1624's path: an executor is handed the full `HostAdmin` and runs INSIDE the scope's
    // actor task (invoke's post-commit tail), so an erasure executor that shreds its own
    // scope is an ordinary design — and a turn that queued there would wedge the scope.
    host.defineOperation('gate/request-erasure', ((ctx) => {
      ctx.emit({
        type: 'lever.erase-requested',
        schemaVersion: 1,
        entity: { entityType: 'lever', entityId: 'l1' },
        piiClass: 'none',
        payload: {},
      });
    }) as OperationHandler<never, unknown>);
    host.registerExecutor('eraser', 'lever.erase-requested', async (admin) => {
      await admin.shredSubject(staff, t, erasing, subject);
      await admin.grant(staff, { principalId: alice, permission: USE, node: { tenantId: t, scopeId: erasing }, grantedBy: alice });
      erased = true;
    });
    await host.admin.createTenant(staff, { id: t, slug: `writer-turn-${ulid().toLowerCase()}`, name: 'Writer turn' });
    await host.admin.grantEntitlement(staff, t, 'lever');
    conn = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: conn,
      tenantId: t,
      vertical: VERTICAL,
      provider: 'scrive',
      label: 'lever',
      secret: { accessToken: 'tok' },
    });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('grant: a capability grant survives the rollback', async () => {
    const s = await newScope();
    await underRollback(s, () => grant(s));
    expect(liveTuple(s, `principal:${alice}`, `granted:${USE}`)).toBe(true);
  });

  it('grantToOrg: an org grant survives the rollback', async () => {
    const s = await newScope();
    const org = await newOrg();
    await underRollback(s, () => grantToOrg(s, org));
    expect(liveTuple(s, `org:${org}`, `granted:${USE}`)).toBe(true);
  });

  it('grantToConnection: the tuple survives the rollback, so it agrees with the directory row', async () => {
    const s = await newScope();
    await underRollback(s, () => grantToConnection(s));
    expect(liveTuple(s, `connection:${conn}`, `granted:${USE}`)).toBe(true);
    expect((await host.connectionGrantsInScope(t, s)).map((g) => g.permission)).toContain(USE);
  });

  it('assignRole: a scope role assignment survives the rollback', async () => {
    const s = await newScope();
    await underRollback(s, () => assign(s));
    expect(liveTuple(s, `principal:${alice}`, `role:${ROLE}`)).toBe(true);
  });

  it('unassignRole: a revoke survives the rollback — the role does NOT come back live', async () => {
    const s = await newScope();
    await assign(s);
    await underRollback(s, () => unassign(s));
    const rows = tuple(s, `principal:${alice}`, `role:${ROLE}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  it('provisionScope: a re-provision re-seats the schedule grant, and the seat survives the rollback', async () => {
    const s = await newScope();
    unseat(s);
    expect(liveTuple(s, seat(s), 'granted:lever:tick')).toBe(false);
    await underRollback(s, () => reprovision(s));
    expect(liveTuple(s, seat(s), 'granted:lever:tick')).toBe(true);
  });

  it('markEventsDrained: the mark survives the rollback, and the next drain does NOT re-ship the batch', async () => {
    const s = await newScope();
    await emit(s);
    const batch = await undrained(s);
    expect(batch).toHaveLength(1);
    expect(await underRollback(s, () => drain(s, batch))).toBe(1);
    expect(outbox(s)[0]!.drained_at).not.toBeNull();
    // The duplicate the rollback caused: the lake's next read offered the same batch again.
    expect(await undrained(s)).toEqual([]);
  });

  it('redrainEvents: a reopen survives the rollback, so the batch is offered again', async () => {
    const s = await newScope();
    await emit(s);
    const batch = await undrained(s);
    await drain(s, batch);
    await tick();
    expect(await underRollback(s, () => redrain(s))).toBe(1);
    expect(outbox(s)[0]!.drained_at).toBeNull();
    expect(await undrained(s)).toEqual(batch);
  });

  it('runDueSchedules: the cadence row survives a rollback, so the schedule does NOT fire twice', async () => {
    const s = await newScope();
    // The tick queues the held operation behind ITSELF, so it begins as soon as the tick's
    // task ends — ahead of the driver recording the run. Without the turn, that record
    // joined the held transaction and was rolled back with it.
    let blocked: Promise<unknown> | undefined;
    let release!: () => void;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    onTick = () => {
      onTick = undefined;
      blocked = host.getScope(alice, t, s).then((stub) => stub.invoke('gate/hold'));
    };
    const running = host.runDueSchedules(leverMod.manifest.id as never, t, s);
    await inside;
    release();
    await expect(blocked).rejects.toThrow(/always rolls back/);
    expect(await running).toMatchObject({ fired: 1 });
    expect(cadence(s, 'schedule', 'lever/tick')).toHaveLength(1);
    expect(await host.runDueSchedules(leverMod.manifest.id as never, t, s)).toMatchObject({ fired: 0, skipped: 1 });
  });

  it('checkFreshness: the evaluator\'s state row survives the rollback', async () => {
    const s = await newScope();
    await underRollback(s, () => host.checkFreshness(leverMod.manifest.id as never, t, s));
    expect(cadence(s, 'freshness', 'freshness:lever.happened')).toHaveLength(1);
  });

  const verdict = (s: ScopeId) =>
    committed<{ last_status: string }>(
      s,
      "SELECT last_status FROM _substrat_schedule_state WHERE kind = 'freshness' AND schedule_op = ?",
      'freshness:lever.happened',
    ).map((r) => r.last_status);

  it('checkFreshness: an event that rolls back is never judged `ok` — the probe runs inside the turn (#1678 review)', async () => {
    const s = await newScope();
    // The held operation has EMITTED the watched event and not committed it. Probed outside
    // the turn, the evaluator saw it, waited, and persisted `ok` after the rollback removed it.
    const report = await underRollback(s, () => host.checkFreshness(leverMod.manifest.id as never, t, s), 'gate/hold-emit');
    expect(outbox(s)).toEqual([]);
    expect(report.checks.map((c) => c.outcome)).toEqual(['skipped']);
    expect(verdict(s)).toEqual(['skipped']);
  });

  it('twin: a COMMITTED event is judged `ok`', async () => {
    const s = await newScope();
    await emit(s);
    const report = await host.checkFreshness(leverMod.manifest.id as never, t, s);
    expect(report.checks.map((c) => c.outcome)).toEqual(['ok']);
    expect(verdict(s)).toEqual(['ok']);
  });

  it('shredSubject: the redaction survives the rollback — the payload does NOT come back', async () => {
    const s = await newScope();
    await emit(s);
    expect(outbox(s)[0]!.payload).not.toBeNull();
    expect(await underRollback(s, () => shred(s))).toMatchObject({ eventsRedacted: 1 });
    expect(outbox(s)[0]!.payload).toBeNull();
  });

  it('restoreScope: a restore survives the rollback', async () => {
    const s = await newScope();
    const empty = await host.admin.exportScope(staff, t, s);
    await emit(s);
    expect(outbox(s)).toHaveLength(1);
    await underRollback(s, () => host.restoreScope(staff, t, s, empty));
    expect(outbox(s)).toEqual([]);
  });

  it('twin: with no operation in flight, every writer behaves exactly as before', async () => {
    const s = await newScope();
    const org = await newOrg();
    await grant(s);
    await grantToOrg(s, org);
    await grantToConnection(s);
    await assign(s);
    expect(liveTuple(s, `principal:${alice}`, `granted:${USE}`)).toBe(true);
    expect(liveTuple(s, `org:${org}`, `granted:${USE}`)).toBe(true);
    expect(liveTuple(s, `connection:${conn}`, `granted:${USE}`)).toBe(true);
    expect(liveTuple(s, `principal:${alice}`, `role:${ROLE}`)).toBe(true);
    await unassign(s);
    expect(liveTuple(s, `principal:${alice}`, `role:${ROLE}`)).toBe(false);
    unseat(s);
    await reprovision(s);
    expect(liveTuple(s, seat(s), 'granted:lever:tick')).toBe(true);
    expect(await host.runDueSchedules(leverMod.manifest.id as never, t, s)).toMatchObject({ fired: 1 });
    expect(cadence(s, 'schedule', 'lever/tick')).toHaveLength(1);
    await host.checkFreshness(leverMod.manifest.id as never, t, s);
    expect(cadence(s, 'freshness', 'freshness:lever.happened')).toHaveLength(1);
    const empty = await host.admin.exportScope(staff, t, s);
    await emit(s);
    const batch = await undrained(s);
    expect(await drain(s, batch)).toBe(1);
    expect(await undrained(s)).toEqual([]);
    await tick();
    expect(await redrain(s)).toBe(1);
    expect(await undrained(s)).toEqual(batch);
    expect(await shred(s)).toMatchObject({ eventsRedacted: 1 });
    expect(outbox(s)[0]!.payload).toBeNull();
    await host.restoreScope(staff, t, s, empty);
    expect(outbox(s)).toEqual([]);
  });

  it('re-entrant: called from inside the scope\'s own actor task, every writer joins it instead of deadlocking', async () => {
    const s = await newScope();
    const org = await newOrg();
    const empty = await host.admin.exportScope(staff, t, s);
    await emit(s);
    const batch = await undrained(s);
    // `runDueSchedules` is not here: it INVOKES the schedule through the system door, and
    // an invoke is an `enqueue`, not a turn — from inside a task it always waited on
    // itself, before this change as after it.
    host.defineOperation('gate/reenter', async () => {
      await grant(s);
      await grantToOrg(s, org);
      await grantToConnection(s);
      await assign(s);
      await unassign(s);
      await reprovision(s);
      await host.checkFreshness(leverMod.manifest.id as never, t, s);
      const drained = await drain(s, batch);
      await tick();
      const redrained = await redrain(s);
      const shredded = await shred(s);
      return { drained, redrained, eventsRedacted: shredded.eventsRedacted };
    });
    // Its own operation: a restore replaces the tables the operation's transaction holds.
    host.defineOperation('gate/reenter-restore', () => host.restoreScope(staff, t, s, empty));
    expect(await within((await host.getScope(alice, t, s)).invoke('gate/reenter'))).toEqual({
      drained: 1,
      redrained: 1,
      eventsRedacted: 1,
    });
    // Committed with the operation that made them.
    expect(liveTuple(s, `principal:${alice}`, `granted:${USE}`)).toBe(true);
    expect(liveTuple(s, `org:${org}`, `granted:${USE}`)).toBe(true);
    expect(liveTuple(s, `connection:${conn}`, `granted:${USE}`)).toBe(true);
    expect(liveTuple(s, `principal:${alice}`, `role:${ROLE}`)).toBe(false);
    expect(liveTuple(s, seat(s), 'granted:lever:tick')).toBe(true);
    expect(cadence(s, 'freshness', 'freshness:lever.happened')).toHaveLength(1);
    expect(outbox(s)).toEqual([{ id: batch[0], drained_at: null, payload: null }]);

    await within((await host.getScope(alice, t, s)).invoke('gate/reenter-restore'));
    expect(outbox(s)).toEqual([]);
  });

  it('re-entrant: an executor handed the HostAdmin inside the scope\'s actor task shreds and grants without wedging it (#1624)', async () => {
    const s = await newScope();
    erasing = s;
    await emit(s);
    await within((await host.getScope(alice, t, s)).invoke('gate/request-erasure'));
    expect(erased).toBe(true);
    expect(outbox(s)[0]!.payload).toBeNull();
    expect(liveTuple(s, `principal:${alice}`, `granted:${USE}`)).toBe(true);
  });
});
