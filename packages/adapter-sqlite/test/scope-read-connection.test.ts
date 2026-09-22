/**
 * Every scope read on the admin seam sees only what was COMMITTED (#1624).
 *
 * #1678 put the writers on the scope actor. The reads were the other half: `invoke` holds a
 * `BEGIN IMMEDIATE` open on the scope's connection across its awaits, and every `HostAdmin`
 * read ran on that same connection — so a read taken while an operation was suspended saw
 * its uncommitted rows. The lake drain is where that stops being a wrong answer on a screen:
 * it shipped the event, the operation rolled back, and the append-only lake kept an event the
 * scope never had. The reads now run on a read-only connection of their own, and the file is
 * WAL, so they see the last committed snapshot.
 *
 * The shape, per read group: an operation suspends INSIDE its transaction with a row it has
 * not committed; the read, issued from outside, does not see it; the operation rolls back and
 * the read still sees nothing. The twin commits instead, and the read sees the row. Rows the
 * module cannot write itself (`_substrat_*`) are PLANTED through the host's own connection
 * while the operation holds it — which is exactly the mechanism of the bug: a statement on
 * that connection lands inside the stranger's transaction.
 *
 * Re-entrant reads are the other deliberate half: a read issued from INSIDE the scope's actor
 * task (an operation or executor holding `HostAdmin`) is reading its own unit, and still sees
 * its own uncommitted writes, as it always did.
 *
 * ADAPTER-SPECIFIC, for the reason `scope-writer-turn.test.ts` gives: the Durable Object
 * serializes its RPCs, so a shared-suite version would assert nothing on the hosted side.
 */
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectionId,
  dataSubjectId,
  eventId,
  moduleManifest,
  platformActorId,
  principalId,
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

const VERTICAL = 'reader-vertical';
const READER = '@test/reader';

const readerMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: READER,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'reader:tick', description: 'run the scheduled tick' }],
    events: { emits: [{ type: 'reader.happened', schemaVersion: 1 }], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'reader',
    schedules: [{ operation: 'reader/tick', cadence: { everyMinutes: 60 }, permissions: ['reader:tick'] }],
  }),
  migrations: [],
  operations: { 'reader/tick': (() => undefined) as OperationHandler<never, unknown> },
};

/** What the host keeps per scope — reached into only to plant rows and to see the handles. */
interface Runtime {
  db: Database.Database;
  reader: Database.Database | null;
}

describe('admin reads see only committed state, from a read-only connection (#1624)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-read-connection-'));
  const host = new SqliteScopeHost({
    dir,
    checker: UNSAFE_allowAllChecker,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const alice = principalId.parse(ulid());
  const subject = dataSubjectId.parse(ulid());
  const ENTITY = { entityType: 'reader', entityId: 'r1' } as const;
  /** Big enough that its pages move `scopeDatabaseSize`, which a small row may not. */
  const BULK = 'x'.repeat(64 * 1024);

  const rtOf = (s: ScopeId) =>
    (host as unknown as { scopes: Map<string, Runtime> }).scopes.get(`${t}/${s}`);
  const readers = () => (host as unknown as { readers: Map<string, Runtime> }).readers;

  const newScope = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: VERTICAL });
    await host.admin.activateScope(staff, t, s);
    return s;
  };

  /** Set per case: the held operation announces it is inside its transaction, then waits. */
  let entered!: () => void;
  let held!: Promise<void>;
  /** How the held operation ends — read when it resumes, since the host copies its input. */
  let commitHeld = false;
  /** A statement on the HOST's connection — inside whatever transaction it holds right now. */
  const plant = (s: ScopeId, sql: string, ...params: unknown[]) => rtOf(s)!.db.prepare(sql).run(...params);
  /** The event the held operation emitted, read where it lives: the uncommitted transaction. */
  const inflightEventId = (s: ScopeId) =>
    (rtOf(s)!.db.prepare("SELECT id FROM _substrat_outbox WHERE type = 'reader.happened'").get() as { id: string }).id;
  /** Every read that answers from the outbox, reduced to "how much of the held event it saw". */
  const outboxReads = async (s: ScopeId, id: string, invocationId: string) => {
    const tables = await host.admin.listScopeTables(staff, t, s);
    const dump = await host.admin.exportScope(staff, t, s);
    const facet = await host.admin.facetEvents(staff, t, s, { groupBy: { kind: 'type' } });
    return {
      readUndrainedEvents: (await host.admin.readUndrainedEvents(staff, t, s)).length,
      facetEvents: facet.buckets.reduce((n, b) => n + b.count, 0),
      entityHistory: (await host.admin.entityHistory(staff, t, s, ENTITY)).entries.length,
      eventCause: (await host.admin.eventCause(staff, t, s, { eventId: eventId.parse(id) })).chain.length,
      eventEffects: (await host.admin.eventEffects(staff, t, s, { eventId: eventId.parse(id) })).root ? 1 : 0,
      invocationEvents: (await host.admin.invocationEvents(staff, t, s, { invocationId })).events.length,
      listScopeTables: tables.find((x) => x.name === '_substrat_outbox')!.rowCount,
      readScopeTable: (await host.admin.readScopeTable(staff, t, s, { table: '_substrat_outbox', limit: 1, offset: 0 })).rowCount,
      queryScope: Number(
        (await host.admin.queryScope(staff, t, s, { sql: 'SELECT COUNT(*) FROM _substrat_outbox' })).rows[0]![0],
      ),
      exportScope: dump.tables.find((x) => x.name === '_substrat_outbox')!.rows.length,
    };
  };
  const all = (n: number) => ({
    readUndrainedEvents: n,
    facetEvents: n,
    entityHistory: n,
    eventCause: n,
    eventEffects: n,
    invocationEvents: n,
    listScopeTables: n,
    readScopeTable: n,
    queryScope: n,
    exportScope: n,
  });

  /** The spine reads a module cannot feed directly, each reduced to "did it see the planted row". */
  const spineReads = async (s: ScopeId) => ({
    listDenials: (await host.admin.listDenials(staff, t, s)).length,
    summarizeDenials: (await host.admin.summarizeDenials(staff, t, s)).total,
    deadLetters: (await host.admin.deadLetters(staff, t, s, {})).entries.length,
    executorDeadLetters: (await host.executorDeadLetters(t, s)).length,
    scopeAppliedMigrations: (await host.admin.scopeAppliedMigrations(staff, t, s)).filter(
      (m) => m.moduleId === '@test/planted',
    ).length,
    connectionGrantsInScope: (await host.connectionGrantsInScope(t, s)).length,
    redrainCount: await host.admin.redrainEvents(staff, t, s, {
      drainedBefore: new Date().toISOString(),
      countOnly: true,
    }),
  });
  const plantSpine = (s: ScopeId, committedEvent: string) => {
    const at = new Date(Date.now() - 1000).toISOString();
    plant(
      s,
      `INSERT INTO _substrat_denials (id, actor, permission, tenant_id, scope_id, operation, at)
         VALUES (?, ?, 'reader:tick', ?, ?, 'reader/tick', ?)`,
      ulid(),
      JSON.stringify({ principal: alice }),
      t,
      s,
      at,
    );
    plant(
      s,
      `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, error, attempts, next_attempt_at)
         VALUES (?, 'executor:planted', ?, 'boom', 3, NULL)`,
      committedEvent,
      at,
    );
    plant(s, `INSERT INTO _substrat_migrations (module_id, version, applied_at) VALUES ('@test/planted', '1', ?)`, at);
    plant(
      s,
      `INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, 'granted:reader:tick', ?)`,
      `connection:${connectionId.parse(ulid())}`,
      `scope:${s}`,
    );
    plant(s, `UPDATE _substrat_outbox SET drained_at = ? WHERE id = ?`, at, committedEvent);
  };
  const noSpine = {
    listDenials: 0,
    summarizeDenials: 0,
    deadLetters: 0,
    executorDeadLetters: 0,
    scopeAppliedMigrations: 0,
    connectionGrantsInScope: 0,
    redrainCount: 0,
  };
  const allSpine = {
    listDenials: 1,
    summarizeDenials: 1,
    deadLetters: 1,
    executorDeadLetters: 1,
    scopeAppliedMigrations: 1,
    connectionGrantsInScope: 1,
    redrainCount: 1,
  };

  const emit = async (s: ScopeId) => (await host.getScope(alice, t, s)).invoke('gate/emit');
  const ev = {
    type: 'reader.happened',
    schemaVersion: 1,
    entity: ENTITY,
    piiClass: 'direct' as const,
    subjectId: subject,
    payload: { bulk: BULK },
  };
  /** A promise that fails the case instead of hanging it. */
  const within = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms))]);

  beforeAll(async () => {
    host.registerModule(readerMod);
    // Suspends inside its own `BEGIN IMMEDIATE`, then commits or throws as told — the
    // transaction the planted rows land in.
    host.defineOperation('gate/hold', (async () => {
      entered();
      await held;
      if (!commitHeld) throw new Error('this operation rolls back');
    }) as OperationHandler<never, unknown>);
    host.defineOperation('gate/hold-emit', (async (ctx) => {
      ctx.emit(ev);
      entered();
      await held;
      if (!commitHeld) throw new Error('this operation rolls back');
    }) as OperationHandler<never, unknown>);
    host.defineOperation('gate/emit', ((ctx) => {
      ctx.emit(ev);
    }) as OperationHandler<never, unknown>);
    host.defineOperation('gate/hold-intent', (async (ctx) => {
      ctx.requestPlatform({ kind: 'email.send', payload: { to: 'someone@example.test' } });
      entered();
      await held;
      if (!commitHeld) throw new Error('this operation rolls back');
    }) as OperationHandler<never, unknown>);
    await host.admin.createTenant(staff, { id: t, slug: `read-conn-${ulid().toLowerCase()}`, name: 'Read connection' });
    await host.admin.grantEntitlement(staff, t, 'reader');
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Hold `op` open inside its transaction; the returned `finish` commits or rolls it back. */
  const holdOp = async (s: ScopeId, op: string, invocationId = ulid()) => {
    let release!: () => void;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    commitHeld = false;
    const running = (await host.getScope(alice, t, s)).invoke(op, undefined, { invocationId });
    await ready;
    return {
      invocationId,
      finish: async (how: 'commit' | 'rollback') => {
        commitHeld = how === 'commit';
        release();
        if (how === 'commit') await running;
        else await expect(running).rejects.toThrow(/rolls back/);
      },
    };
  };

  describe('outbox reads', () => {
    it('the lake: an uncommitted event is not offered mid-invoke, and after its rollback nothing is drained', async () => {
      const s = await newScope();
      const { finish } = await holdOp(s, 'gate/hold-emit');
      // The bug's own evidence: the host's connection DOES hold the event right now.
      expect(inflightEventId(s)).toBeTruthy();
      const offered = await host.admin.readUndrainedEvents(staff, t, s);
      expect(offered).toEqual([]);
      // What a drain pass does next: mark what it shipped. Nothing shipped, nothing marked.
      expect(await host.admin.markEventsDrained(staff, t, s, offered.map((e) => e.id))).toBe(0);
      await finish('rollback');
      expect(await host.admin.readUndrainedEvents(staff, t, s)).toEqual([]);
    });

    it('twin: once the invoke commits, the event IS offered', async () => {
      const s = await newScope();
      const { finish } = await holdOp(s, 'gate/hold-emit');
      const id = inflightEventId(s);
      expect(await host.admin.readUndrainedEvents(staff, t, s)).toEqual([]);
      await finish('commit');
      expect((await host.admin.readUndrainedEvents(staff, t, s)).map((e) => e.id)).toEqual([id]);
    });

    it('every outbox read: nothing of the held event mid-invoke, nothing after its rollback', async () => {
      const s = await newScope();
      const { finish, invocationId } = await holdOp(s, 'gate/hold-emit');
      const id = inflightEventId(s);
      expect(await outboxReads(s, id, invocationId)).toEqual(all(0));
      await finish('rollback');
      expect(await outboxReads(s, id, invocationId)).toEqual(all(0));
    });

    it('twin: every outbox read sees the event once the invoke commits', async () => {
      const s = await newScope();
      const { finish, invocationId } = await holdOp(s, 'gate/hold-emit');
      const id = inflightEventId(s);
      expect(await outboxReads(s, id, invocationId)).toEqual(all(0));
      await finish('commit');
      expect(await outboxReads(s, id, invocationId)).toEqual(all(1));
    });

    it('scopeDatabaseSize: the file size a held invoke has not committed is not reported, and is once it commits', async () => {
      const s = await newScope();
      const before = await host.admin.scopeDatabaseSize(staff, t, s);
      const { finish } = await holdOp(s, 'gate/hold-emit');
      expect(await host.admin.scopeDatabaseSize(staff, t, s)).toBe(before);
      await finish('commit');
      expect(await host.admin.scopeDatabaseSize(staff, t, s)).toBeGreaterThan(before);
    });

    it('exportScope: a backup taken mid-invoke is the committed state, so restoring it loses nothing that committed', async () => {
      const s = await newScope();
      await emit(s);
      const { finish } = await holdOp(s, 'gate/hold-emit');
      const dump = await host.admin.exportScope(staff, t, s);
      await finish('rollback');
      expect(dump.tables.find((x) => x.name === '_substrat_outbox')!.rows).toHaveLength(1);
    });
  });

  describe('spine reads', () => {
    it('denials, dead letters, migrations, connection grants and the redrain count: a planted row is not seen mid-invoke or after rollback', async () => {
      const s = await newScope();
      await emit(s);
      const committedEvent = (await host.admin.readUndrainedEvents(staff, t, s))[0]!.id;
      const { finish } = await holdOp(s, 'gate/hold');
      plantSpine(s, committedEvent);
      expect(await spineReads(s)).toEqual(noSpine);
      await finish('rollback');
      expect(await spineReads(s)).toEqual(noSpine);
    });

    it('twin: the same planted rows are seen once the invoke commits', async () => {
      const s = await newScope();
      await emit(s);
      const committedEvent = (await host.admin.readUndrainedEvents(staff, t, s))[0]!.id;
      const { finish } = await holdOp(s, 'gate/hold');
      plantSpine(s, committedEvent);
      expect(await spineReads(s)).toEqual(noSpine);
      await finish('commit');
      expect(await spineReads(s)).toEqual(allSpine);
    });

    it('the platform-intent drain: an intent an invoke has not committed is not listed, before or after its rollback', async () => {
      const s = await newScope();
      const { finish } = await holdOp(s, 'gate/hold-intent');
      expect(await host.listPlatformRequests(t, s)).toEqual([]);
      expect(await host.listPlatformRequestHistory(t, s)).toEqual([]);
      await finish('rollback');
      expect(await host.listPlatformRequests(t, s)).toEqual([]);
    });

    it('twin: once the invoke commits, the intent is listed', async () => {
      const s = await newScope();
      const { finish } = await holdOp(s, 'gate/hold-intent');
      expect(await host.listPlatformRequests(t, s)).toEqual([]);
      await finish('commit');
      expect((await host.listPlatformRequests(t, s)).map((r) => r.kind)).toEqual(['email.send']);
      expect(await host.listPlatformRequestHistory(t, s)).toHaveLength(1);
    });
  });

  describe('reads that feed a write stay in the turn', () => {
    const cadenceRow = (s: ScopeId) =>
      plant(
        s,
        `INSERT INTO _substrat_schedule_state (kind, schedule_op, last_run_at, last_status)
           VALUES ('schedule', 'reader/tick', ?, 'ok')`,
        new Date().toISOString(),
      );

    it('runDueSchedules: a cadence row an invoke rolls back does not suppress the run', async () => {
      const s = await newScope();
      const { finish } = await holdOp(s, 'gate/hold');
      cadenceRow(s);
      // Waits for the turn, which is the point: the gate is judged after the stranger ended.
      const running = host.runDueSchedules(readerMod.manifest.id as never, t, s);
      await finish('rollback');
      expect(await running).toMatchObject({ fired: 1, skipped: 0 });
    });

    /** The schedule's switch is its system grant (#383): revoking the seat turns it off. */
    const unseat = (s: ScopeId) =>
      plant(s, `UPDATE _substrat_tuples SET revoked_at = ? WHERE subject = ?`, new Date().toISOString(), `system:${READER}`);

    it('runDueSchedules: a switch-off an invoke rolls back does not stop the run', async () => {
      const s = await newScope();
      const { finish } = await holdOp(s, 'gate/hold');
      expect(unseat(s).changes).toBe(1);
      const running = host.runDueSchedules(readerMod.manifest.id as never, t, s);
      await finish('rollback');
      expect(await running).toMatchObject({ fired: 1 });
    });

    it('twin: a switch-off the invoke commits does stop it', async () => {
      const s = await newScope();
      const { finish } = await holdOp(s, 'gate/hold');
      unseat(s);
      const running = host.runDueSchedules(readerMod.manifest.id as never, t, s);
      await finish('commit');
      expect(await running).toMatchObject({ fired: 0 });
    });

    it('twin: a cadence row the invoke commits does suppress it', async () => {
      const s = await newScope();
      const { finish } = await holdOp(s, 'gate/hold');
      cadenceRow(s);
      const running = host.runDueSchedules(readerMod.manifest.id as never, t, s);
      await finish('commit');
      expect(await running).toMatchObject({ fired: 0, skipped: 1 });
    });
  });

  describe('re-entrant reads see their own unit', () => {
    it('an operation reading its own scope mid-transaction sees its own uncommitted event — and a stranger does not', async () => {
      const s = await newScope();
      let own = -1;
      host.defineOperation('gate/reenter-read', (async (ctx) => {
        ctx.emit(ev);
        own = (await within(host.admin.readUndrainedEvents(staff, t, s))).length;
        entered();
        await held;
        if (!commitHeld) throw new Error('this operation rolls back');
      }) as OperationHandler<never, unknown>);
      const { finish } = await holdOp(s, 'gate/reenter-read');
      expect(own).toBe(1);
      expect(await host.admin.readUndrainedEvents(staff, t, s)).toEqual([]);
      await finish('commit');
      expect(await host.admin.readUndrainedEvents(staff, t, s)).toHaveLength(1);
    });

    it('twin: the same read with nothing of its own written sees only what was committed', async () => {
      const s = await newScope();
      await emit(s);
      let own = -1;
      host.defineOperation('gate/reenter-read-none', (async () => {
        own = (await within(host.admin.readUndrainedEvents(staff, t, s))).length;
      }) as OperationHandler<never, unknown>);
      await (await host.getScope(alice, t, s)).invoke('gate/reenter-read-none');
      expect(own).toBe(1);
    });

    it('an executor handed HostAdmin reads its own scope inside the actor task without wedging it', async () => {
      const s = await newScope();
      let seen = -1;
      host.registerExecutor('reader-exec', 'reader.happened', async (admin) => {
        if (seen !== -1) return;
        seen = (await within(admin.readUndrainedEvents(staff, t, s))).length;
      });
      await within(emit(s));
      expect(seen).toBe(1);
    });
  });

  describe('lifecycle', () => {
    it('the reader is read-only, opened on the first read, and a write through it is impossible', async () => {
      const s = await newScope();
      expect(rtOf(s)!.reader).toBeNull();
      await host.admin.listScopeTables(staff, t, s);
      const reader = rtOf(s)!.reader!;
      expect(reader.readonly).toBe(true);
      expect(() => reader.prepare('DELETE FROM _substrat_outbox').run()).toThrow(/readonly/);
    });

    it('restoreScope: a read after a restore sees the restored data, never the snapshot it had before', async () => {
      const s = await newScope();
      const empty = await host.admin.exportScope(staff, t, s);
      await emit(s);
      const full = await host.admin.exportScope(staff, t, s);
      expect(await host.admin.readUndrainedEvents(staff, t, s)).toHaveLength(1);
      await host.restoreScope(staff, t, s, empty);
      expect(await host.admin.readUndrainedEvents(staff, t, s)).toEqual([]);
      expect((await host.admin.listScopeTables(staff, t, s)).find((x) => x.name === '_substrat_outbox')!.rowCount).toBe(0);
      await host.restoreScope(staff, t, s, full);
      expect(await host.admin.readUndrainedEvents(staff, t, s)).toHaveLength(1);
    });

    it('shredSubject: a read after an erasure sees the payload gone', async () => {
      const s = await newScope();
      await emit(s);
      const before = await host.admin.entityHistory(staff, t, s, ENTITY);
      expect(before.entries[0]!.payload).not.toBeNull();
      await host.admin.shredSubject(staff, t, s, subject);
      const after = await host.admin.entityHistory(staff, t, s, ENTITY);
      expect(after.entries[0]!.payload).toBeNull();
    });

    it('reapScope: the reader is closed with the writer, and the reaped scope cannot be read', async () => {
      const s = await newScope();
      await emit(s);
      await host.admin.readUndrainedEvents(staff, t, s);
      const reader = rtOf(s)!.reader!;
      expect(reader.open).toBe(true);
      await host.admin.archiveScope(staff, t, s);
      await host.admin.reapScope(staff, t, s, { force: true });
      expect(reader.open).toBe(false);
      expect(readers().has(`${t}/${s}`)).toBe(false);
      await expect(host.admin.readUndrainedEvents(staff, t, s)).rejects.toThrow(/reaped/);
    });

    it(`the reader cap: past it the least recently read scope's reader is closed, and its next read reopens it`, async () => {
      const scopes: ScopeId[] = [];
      for (let i = 0; i < 34; i += 1) scopes.push(await newScope());
      for (const s of scopes) await host.admin.listScopeTables(staff, t, s);
      expect(readers().size).toBeLessThanOrEqual(32);
      expect(rtOf(scopes[0]!)!.reader).toBeNull();
      expect(rtOf(scopes[33]!)!.reader!.open).toBe(true);
      await emit(scopes[0]!);
      expect(await host.admin.readUndrainedEvents(staff, t, scopes[0]!)).toHaveLength(1);
      expect(rtOf(scopes[0]!)!.reader!.open).toBe(true);
      expect(readers().size).toBeLessThanOrEqual(32);
    });

    it('close(): every reader closes with the host', async () => {
      const own = new SqliteScopeHost({
        dir: mkdtempSync(join(tmpdir(), 'substrat-read-close-')),
        checker: UNSAFE_allowAllChecker,
        secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      });
      const tt = tenantId.parse(ulid());
      const ss = scopeId.parse(ulid());
      await own.admin.createTenant(staff, { id: tt, slug: `read-close-${ulid().toLowerCase()}`, name: 'Close' });
      await own.provisionScope(staff, { tenantId: tt, scopeId: ss, vertical: VERTICAL });
      await own.admin.listScopeTables(staff, tt, ss);
      const reader = (own as unknown as { scopes: Map<string, Runtime> }).scopes.get(`${tt}/${ss}`)!.reader!;
      expect(reader.open).toBe(true);
      await own.close();
      expect(reader.open).toBe(false);
    });
  });
});
