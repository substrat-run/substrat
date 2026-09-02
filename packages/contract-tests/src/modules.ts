/**
 * Executable contract-test artifacts as STATIC importable values (not inline
 * `beforeAll` closures). The Cloudflare adapter bundles these into its ScopeDO
 * at code time — a Durable Object cannot receive handler closures over RPC — so
 * both the pure-SQLite suite (which registers them on the facade that also
 * executes them) and the CF suite (whose DO executes them, facade only
 * validates) draw from this one source. The assertions live in the suites; the
 * artifacts live here.
 */
import {
  dataSubjectId,
  moduleManifest,
  operationInputsOf,
  operationConcurrencyOf,
  operationIdempotencyOptOutsOf,
  IDEMPOTENCY_RESULT_LIMIT,
  permissionKey,
  principalId,
  z,
  type EntityRef,
  type ListPage,
  type PermissionKey,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  readHistory,
  readTimeline,
  ulid,
  type ConsumerHandler,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// -- manifests ---------------------------------------------------------------

export const testModManifest = moduleManifest.parse({
  id: '@test/mod',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'testmod:use', description: 'test permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entityRelations: [{ entityType: 'item', parentType: 'box' }],
  entitlementKey: 'testmod',
});

// #383: a module that declares RECURRING work. `sched/tick` is scheduled (its
// permission `sched:tick` is projected to the system principal at provisioning);
// `sched:admin` is declared but NOT scheduled, so the system principal never holds
// it — the lever that proves `ctx.check` is the real gate, not a bypass.
export const scheduleModManifest = moduleManifest.parse({
  id: '@test/sched',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'sched:tick', description: 'run the scheduled tick' },
    { key: 'sched:admin', description: 'a permission the schedule does NOT grant' },
  ],
  events: { emits: [{ type: 'sched.ticked', schemaVersion: 1 }], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'sched',
  schedules: [{ operation: 'sched/tick', cadence: { everyMinutes: 60 }, permissions: ['sched:tick'] }],
});

export const flowModManifest = moduleManifest.parse({
  id: '@test/flow',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'flow:use', description: 'flow permission' }],
  events: {
    emits: [
      { type: 'flow.step1', schemaVersion: 1 },
      { type: 'flow.step2', schemaVersion: 1 },
    ],
    consumes: [
      { type: 'flow.step1', schemaVersion: 1 },
      { type: 'flow.step2', schemaVersion: 1 },
    ],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'flow',
});

// #770: the sub-transaction module. `atomic:extra` exists to be checked ONLY inside
// a rolled-back region — the lever that proves the K-34 `passed` accumulator is
// restored, because that accumulator lives in JavaScript and the storage rollback
// cannot reach it. Its absence from a LATER event's `authorization` is the assertion.
export const atomicModManifest = moduleManifest.parse({
  id: '@test/atomic',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'atomic:use', description: 'the caller-level permission' },
    { key: 'atomic:extra', description: 'checked only inside a sub-transaction' },
  ],
  events: {
    emits: [
      { type: 'atomic.acted', schemaVersion: 1 },
      { type: 'atomic.inner', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entityRelations: [{ entityType: 'item', parentType: 'box' }],
  entitlementKey: 'atomic',
});

export const lateModManifest = moduleManifest.parse({
  id: '@test/late',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'late:use', description: 'late module permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'late',
});

// Entitlement gate (§4.3): a module whose SKU flag the tenant does not hold does
// not load — its operations do not resolve. Isolated on its own tenant so
// granting/revoking here cannot disturb the other suites' fixtures.
export const billedModManifest = moduleManifest.parse({
  id: '@test/billed',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'billed:use', description: 'billed module permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'billed',
});

// Manifest-declared operation guards (K-17). Two modules, on purpose: one
// GUARDED module whose manifest declares the gate, one GATE module that
// contributes the named predicate. The guarded module registers FIRST — the
// contract says predicates resolve at invoke, not at registration, because
// registration order is caller-controlled.
export const guardedModManifest = moduleManifest.parse({
  id: '@test/guarded',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'guarded:use', description: 'guarded permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'guarded',
  guards: [
    { before: 'guarded/act', predicate: 'gate/flag-set', config: { flag: 'go' } },
    // A guard whose predicate NO module contributes: the operation must fail
    // closed, never run unguarded.
    { before: 'guarded/orphan', predicate: 'gate/does-not-exist', config: {} },
  ],
});

// Operation withdrawal (K-17). Order-independence is the contract, so the suite
// withdraws one operation BEFORE its module registers and one AFTER.
export const withdrawEarlyManifest = moduleManifest.parse({
  id: '@test/withdraw-early',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'wearly:use', description: 'early withdrawer' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'withdraw-early',
  withdraws: ['victim/a'], // @test/victim has not registered yet
});

export const victimModManifest = moduleManifest.parse({
  id: '@test/victim',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'victim:use', description: 'victim permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'victim',
});

export const withdrawLateManifest = moduleManifest.parse({
  id: '@test/withdraw-late',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'wlate:use', description: 'late withdrawer' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'withdraw-late',
  withdraws: ['victim/b'], // @test/victim already registered
});

export const gateModManifest = moduleManifest.parse({
  id: '@test/gate',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'gate:use', description: 'gate permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'gate',
});

/**
 * K-42 (#868): a CONSUMER of `perm.acted`, whose whole job is to answer the
 * question a raw outbox read cannot — does the two-actor stamp survive the trip
 * from the stored row back into a `DomainEvent`? An adapter that writes the column
 * and drops it on the way out passes every assertion that reads SQL directly, and
 * still hands its consumers an event with no administrative actor on it.
 *
 * Only the impersonation suite reads `imp_echo`, so it is inert everywhere else.
 */
export const impersonationEchoManifest = moduleManifest.parse({
  id: '@imp/echo',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [],
  events: {
    emits: [],
    consumes: [{ type: 'perm.acted', schemaVersion: 1 }],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'imp-echo',
});

export const permModManifest = moduleManifest.parse({
  id: '@perm/mod',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'perm:use', description: 'use the thing' },
    { key: 'perm:read', description: 'read the thing' },
  ],
  events: {
    // #473: the attachment surface emits these on upload/remove; declaring them keeps the
    // module's emitted-event set honest (an attachment target implies these events).
    emits: [
      { type: 'attachment.added', schemaVersion: 1 },
      { type: 'attachment.removed', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  // #473: an attachment target on `item`, gated read=perm:read / write=perm:use — reusing
  // the permission model the suite already sets up, so both adapters exercise attachments.
  attachmentTargets: [{ entityType: 'item', readPermission: 'perm:read', writePermission: 'perm:use' }],
  entityRelations: [{ entityType: 'item', parentType: 'box' }],
  entitlementKey: 'perm',
});

// -- bare operations (registered via defineOperation, no manifest) -----------

interface OutboxRow {
  id: string;
  type: string;
  occurred_at: string;
  tenant_id: string;
  scope_id: string;
  pii_class: string;
  subject_id: string | null;
}

interface PlatformRequestRow {
  id: string;
  kind: string;
  payload: string;
  requested_by: string;
  status: string;
  attempts: number;
  requested_at: string;
}

// Shared across test/stash + test/read-stash. Module scope so the value survives
// between invokes on the same DO instance (and, on the pure adapter, across the
// suite process). Only these two operations touch it.
const stash: { value?: { items: string[] } } = {};

export const contractTestBareOps: Record<string, OperationHandler<never, unknown>> = {
  'test/init-counter': ((ctx) => {
    ctx.sql.exec('CREATE TABLE IF NOT EXISTS counter (n INTEGER NOT NULL)');
    ctx.sql.exec('DELETE FROM counter');
    ctx.sql.exec('INSERT INTO counter (n) VALUES (0)');
  }) as OperationHandler<never, unknown>,
  // Read → await → write. Under interleaving this loses updates; under strict
  // serialization it cannot.
  'test/slow-increment': (async (ctx) => {
    const [row] = ctx.sql.query<{ n: number }>('SELECT n FROM counter');
    await new Promise((r) => setTimeout(r, 5));
    ctx.sql.exec('UPDATE counter SET n = ?', [row!.n + 1]);
  }) as OperationHandler<never, unknown>,
  'test/read-counter': ((ctx) => {
    const [row] = ctx.sql.query<{ n: number }>('SELECT n FROM counter');
    return row!.n;
  }) as OperationHandler<never, unknown>,
  'test/stash': ((_ctx, input: { items: string[] }) => {
    stash.value = input;
  }) as OperationHandler<never, unknown>,
  'test/read-stash': (() => stash.value!) as OperationHandler<never, unknown>,
  // `secret` exists for the erasure suite (#37): a payload whose CONTENT differs per
  // subject is what lets a test tell "this subject's payload survived" from "some payload
  // survived" — the distinction an erasure either honours or quietly fails.
  'test/emit-event': ((ctx, input: { subject?: string; secret?: string } | undefined) => {
    ctx.emit({
      type: 'test.happened',
      schemaVersion: 1,
      entity: { entityType: 'test-thing', entityId: 'x1' },
      piiClass: input?.subject ? 'pseudonymous' : 'none',
      ...(input?.subject ? { subjectId: dataSubjectId.parse(input.subject) } : {}),
      payload: { hello: 'world', ...(input?.secret ? { secret: input.secret } : {}) },
    });
  }) as OperationHandler<never, unknown>,
  'test/emit-unclassified-pii': ((ctx) => {
    // piiClass 'direct' without subjectId — must be rejected at emit (§6.1)
    ctx.emit({
      type: 'test.bad',
      schemaVersion: 1,
      entity: { entityType: 'test-thing', entityId: 'x2' },
      piiClass: 'direct',
      payload: {},
    });
  }) as OperationHandler<never, unknown>,
  /**
   * The clock seam (#812). Reads `ctx.now()` twice around an `emit`, so the suite
   * can assert the two things module code is entitled to rely on: the value does
   * not move within one operation, and the event envelope agrees with it.
   */
  'test/now': ((ctx) => {
    const first = ctx.now();
    ctx.emit({
      type: 'test.happened',
      schemaVersion: 1,
      entity: { entityType: 'test-thing', entityId: 'clock' },
      piiClass: 'none',
      payload: {},
    });
    return { first, second: ctx.now() };
  }) as OperationHandler<never, unknown>,
  'test/read-outbox': ((ctx) =>
    ctx.sql.query<OutboxRow>('SELECT * FROM _substrat_outbox ORDER BY id')) as OperationHandler<
    never,
    unknown
  >,
  // -- #901: an entity's version is the last event's ULID ---------------------
  // The read under test. Takes the ref rather than fixing one, so the suite can
  // ask about an entity nothing has ever emitted about and get the absence.
  'test/version-of': ((ctx, input: { entityType: string; entityId: string }) =>
    ctx.versionOf({ entityType: input.entityType, entityId: input.entityId })) as OperationHandler<
    never,
    unknown
  >,
  // Emit about a NAMED entity. `test/emit-event` is fixed to `x1`, and the suite
  // needs two entities moving independently to prove the version is per-entity
  // and not just "the newest event in the scope".
  'test/emit-about': ((ctx, input: { entityId: string; subject?: string }) => {
    ctx.emit({
      type: 'test.happened',
      schemaVersion: 1,
      entity: { entityType: 'test-thing', entityId: input.entityId },
      piiClass: input.subject ? 'pseudonymous' : 'none',
      ...(input.subject ? { subjectId: dataSubjectId.parse(input.subject) } : {}),
      payload: { about: input.entityId },
    });
  }) as OperationHandler<never, unknown>,
  // Emit, then read the version back INSIDE the same operation — the
  // read-after-write half, and the reason `emit` writing the outbox row inline
  // rather than buffering to commit is load-bearing rather than incidental.
  'test/emit-then-version': ((ctx, input: { entityId: string }) => {
    const before = ctx.versionOf({ entityType: 'test-thing', entityId: input.entityId });
    ctx.emit({
      type: 'test.happened',
      schemaVersion: 1,
      entity: { entityType: 'test-thing', entityId: input.entityId },
      piiClass: 'none',
      payload: {},
    });
    return { before, after: ctx.versionOf({ entityType: 'test-thing', entityId: input.entityId }) };
  }) as OperationHandler<never, unknown>,
  // A mutation that emits NOTHING. The version must not move — this is the
  // documented hole, pinned deliberately so it is a known property rather than a
  // surprise. The fix is a compile-checked `concurrency` against `emits` (#129),
  // not a change here.
  // -- #800: the supported read of an entity's history ------------------------
  // Emit N events about one entity in ONE invocation. `ctx.now()` is stable for
  // the whole operation (#812), so every row lands with the IDENTICAL
  // `occurred_at` — which is what makes a timestamp cursor lose rows, and what
  // the suite needs to be able to construct on purpose rather than hope for.
  'test/emit-burst': ((ctx, input: { entityId: string; count: number }) => {
    for (let n = 0; n < input.count; n++) {
      ctx.emit({
        type: 'test.happened',
        schemaVersion: 1,
        entity: { entityType: 'test-thing', entityId: input.entityId },
        piiClass: 'none',
        payload: { n },
      });
    }
    return ctx.now();
  }) as OperationHandler<never, unknown>,
  // The reads under test. They take the whole page shape so the suite can drive
  // limit, cursor and order without a variant operation per case.
  'test/timeline': ((ctx, input: { entityType: string; entityId: string } & ListPage) =>
    readTimeline(
      ctx,
      { entityType: input.entityType, entityId: input.entityId },
      input,
    )) as OperationHandler<never, unknown>,
  'test/history': ((ctx, input: { entityType: string; entityId: string } & ListPage) =>
    readHistory(
      ctx,
      { entityType: input.entityType, entityId: input.entityId },
      input,
    )) as OperationHandler<never, unknown>,
  // An event carrying PII, so the suite can shred it and assert the history
  // degrades to a null payload instead of vanishing or throwing.
  //
  // It CHECKS before it emits, unlike `test/emit-about`, and that is the point
  // rather than politeness: `authorization` is stamped from the checks the
  // operation passed (K-34), so an operation that checks nothing writes a null
  // there — indistinguishable from a row predating the column. A history read
  // has to be driven against an event that actually recorded its authority.
  'test/emit-about-with-payload': (async (
    ctx,
    input: { entityId: string; subject: string; said: string },
  ) => {
    assertAllowed(await ctx.check(permissionKey.parse('testmod:use')));
    ctx.emit({
      type: 'test.happened',
      schemaVersion: 1,
      entity: { entityType: 'test-thing', entityId: input.entityId },
      piiClass: 'direct',
      subjectId: dataSubjectId.parse(input.subject),
      payload: { said: input.said },
    });
  }) as OperationHandler<never, unknown>,
  'test/mutate-silently': ((ctx) => {
    ctx.sql.exec('CREATE TABLE IF NOT EXISTS quiet (n INTEGER NOT NULL)');
    ctx.sql.exec('INSERT INTO quiet (n) VALUES (1)');
  }) as OperationHandler<never, unknown>,
  // platform-intents.md: enqueue a platform intent and return its id.
  'platform/request': ((ctx, input: { kind: string; payload?: unknown }) =>
    ctx.requestPlatform({ kind: input.kind, payload: input.payload })) as OperationHandler<never, unknown>,
  // Enqueue then throw — the request write must roll back with the operation (atomic with the txn).
  'platform/request-then-throw': ((ctx, input: { kind: string }) => {
    ctx.requestPlatform({ kind: input.kind, payload: { rolled: 'back' } });
    throw new Error('boom after requestPlatform');
  }) as OperationHandler<never, unknown>,
  'platform/read-requests': ((ctx) =>
    ctx.sql.query<PlatformRequestRow>(
      'SELECT * FROM _substrat_platform_requests ORDER BY id',
    )) as OperationHandler<never, unknown>,
  // #618: the SUPPORTED read of the same rows — what a vertical uses to tell a user its
  // signing request never left, instead of the hand-written SELECT above.
  'platform/intents': ((ctx, input: { kind?: string; status?: string; limit?: number } | undefined) =>
    ctx.platformRequests(input as never)) as OperationHandler<never, unknown>,
  'test/write-marker': ((ctx, input: { v: string }) => {
    ctx.sql.exec('CREATE TABLE IF NOT EXISTS marker (v TEXT NOT NULL)');
    ctx.sql.exec('INSERT INTO marker (v) VALUES (?)', [input.v]);
  }) as OperationHandler<never, unknown>,
  'test/read-markers': ((ctx) => {
    ctx.sql.exec('CREATE TABLE IF NOT EXISTS marker (v TEXT NOT NULL)');
    return ctx.sql.query<{ v: string }>('SELECT v FROM marker').map((r) => r.v);
  }) as OperationHandler<never, unknown>,
  'test/atomic-init': ((ctx) => {
    ctx.sql.exec('CREATE TABLE IF NOT EXISTS atomic_t (n INTEGER NOT NULL)');
  }) as OperationHandler<never, unknown>,
  'test/atomic-fail': ((ctx) => {
    ctx.sql.exec('INSERT INTO atomic_t (n) VALUES (1)');
    ctx.emit({
      type: 'test.atomic',
      schemaVersion: 1,
      entity: { entityType: 'test-thing', entityId: 'x9' },
      piiClass: 'none',
      payload: {},
    });
    throw new Error('boom');
  }) as OperationHandler<never, unknown>,
  'test/atomic-read': ((ctx) => ({
    rows: ctx.sql.query<{ n: number }>('SELECT n FROM atomic_t').length,
    events: ctx.sql.query('SELECT id FROM _substrat_outbox WHERE type = ?', ['test.atomic']).length,
  })) as OperationHandler<never, unknown>,
};

// -- module operation handlers -----------------------------------------------

const addItem: OperationHandler<{ id: string; box: string }, void> = (ctx, input) => {
  ctx.sql.exec('INSERT INTO testmod_items (id, box) VALUES (?, ?)', [input.id, input.box]);
  ctx.link({ entityType: 'item', entityId: input.id }, { entityType: 'box', entityId: input.box });
};

const relinkItem: OperationHandler<{ id: string; box: string }, void> = (ctx, input) => {
  ctx.link({ entityType: 'item', entityId: input.id }, { entityType: 'box', entityId: input.box });
};

const linkUndeclared: OperationHandler<undefined, void> = (ctx) => {
  ctx.link({ entityType: 'box', entityId: 'b1' }, { entityType: 'item', entityId: 'i1' });
};

const readJournal: OperationHandler<undefined, { module_id: string; version: string }[]> = (ctx) =>
  ctx.sql.query('SELECT module_id, version FROM _substrat_migrations ORDER BY module_id');

const readTuples: OperationHandler<
  undefined,
  { subject: string; relation: string; object: string }[]
> = (ctx) => ctx.sql.query('SELECT subject, relation, object FROM _substrat_tuples ORDER BY subject');

/**
 * The forges (#954). Each one is a statement a module could reach the spine with
 * before `ctx.sql` was guarded — a granted tuple, a rewritten event, a dropped
 * migration journal — plus the two evasions a naive scanner hands through: a
 * quoted identifier, and a write dressed as a read with `RETURNING`.
 *
 * `forgeAfterWrite` is the one that proves the refusal is not merely a no-op: the
 * operation writes a legitimate row first, so if the throw did not take the whole
 * transaction with it, the item would survive.
 */
const forgeTuple: OperationHandler<undefined, void> = (ctx) => {
  ctx.sql.exec('INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', [
    'principal:forged',
    'granted:testmod:use',
    'scope:forged',
  ]);
};

const forgeOutbox: OperationHandler<undefined, void> = (ctx) => {
  ctx.sql.exec("UPDATE _substrat_outbox SET payload = '{\"forged\":true}'");
};

const forgeDropJournal: OperationHandler<undefined, void> = (ctx) => {
  ctx.sql.exec('DROP TABLE IF EXISTS _substrat_migrations');
};

const forgeQuoted: OperationHandler<undefined, void> = (ctx) => {
  ctx.sql.exec('DELETE FROM "_substrat_tuples"');
};

/**
 * The second table a statement reaches past the one it names first: a trigger ON the
 * outbox makes every LATER kernel write fail with SQLITE_CONSTRAINT. Denial of the
 * spine rather than forgery of it, and just as much a reach past `ctx.sql`.
 */
const forgeTrigger: OperationHandler<undefined, void> = (ctx) => {
  ctx.sql.exec(
    "CREATE TRIGGER block_outbox BEFORE INSERT ON _substrat_outbox " +
      "BEGIN SELECT RAISE(ABORT, 'blocked'); END",
  );
};

const forgeReturning: OperationHandler<undefined, unknown[]> = (ctx) =>
  ctx.sql.query('INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?) RETURNING subject', [
    'principal:forged',
    'granted:testmod:use',
    'scope:forged',
  ]);

const forgeAfterWrite: OperationHandler<{ id: string }, void> = (ctx, input) => {
  ctx.sql.exec('INSERT INTO testmod_items (id, box) VALUES (?, ?)', [input.id, 'b-forge']);
  ctx.sql.exec('INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', [
    'principal:forged',
    'granted:testmod:use',
    'scope:forged',
  ]);
};

/**
 * The projection CLAUDE.md blesses — a spine READ feeding a domain write. The
 * guard judges the write's target only, so this has to keep working; a guard that
 * refused it would be a rule against timelines rather than against forging.
 */
const projectJournal: OperationHandler<undefined, void> = (ctx) => {
  ctx.sql.exec(
    "INSERT OR REPLACE INTO testmod_notes (id, body) " +
      "SELECT module_id || '@' || version, version FROM _substrat_migrations",
  );
};

const readItems: OperationHandler<undefined, { id: string }[]> = (ctx) =>
  ctx.sql.query('SELECT id FROM testmod_items ORDER BY id');

const readNotes: OperationHandler<undefined, { id: string; body: string }[]> = (ctx) =>
  ctx.sql.query('SELECT id, body FROM testmod_notes ORDER BY id');

const linkOp: OperationHandler<{ child: EntityRef; parent: EntityRef }, void> = (ctx, input) => {
  ctx.link(input.child, input.parent);
};

const probeOp: OperationHandler<{ permission: PermissionKey; entity?: EntityRef }, unknown> = (
  ctx,
  input,
) => ctx.check(input.permission, input.entity);

// Assert a permission, then emit — the shape a real mutating operation has. Exercises
// K-34 (the emitted event carries the passed check as `authorization`) and, when the
// check is refused, K-35 (assertAllowed throws → the host records a denial and rolls back).
const authorizedEmitOp: OperationHandler<
  { permission: PermissionKey; entity?: EntityRef },
  void
> = async (ctx, input) => {
  assertAllowed(await ctx.check(input.permission, input.entity));
  ctx.emit({
    type: 'perm.acted',
    schemaVersion: 1,
    entity: input.entity ?? { entityType: 'test-thing', entityId: 'x1' },
    piiClass: 'none',
    payload: {},
  });
};

// A SECOND enforced check, so a denial log can be asked how many DISTINCT operations
// an actor was refused one key on (#867) — one operation refused four hundred times is
// a broken screen, the same count across several is someone walking the surface. With
// only one guarded operation in the module that column could never be anything but 1.
const authorizedReadOp: OperationHandler<{ permission: PermissionKey }, number> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(input.permission));
  return ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM testmod_items')[0]!.n;
};

const readOutboxOp: OperationHandler<undefined, unknown> = (ctx) =>
  ctx.sql.query('SELECT id, type, authorization, impersonation FROM _substrat_outbox ORDER BY id');

const readDenialsOp: OperationHandler<undefined, unknown> = (ctx) =>
  ctx.sql.query(
    `SELECT actor, permission, tenant_id, scope_id, operation, impersonation
       FROM _substrat_denials ORDER BY id`,
  );

// -- K-42 fixtures (#868) ----------------------------------------------------
// A read, a bare-SQL write, and an intent. The bare-SQL write is the one that
// matters: it goes through NO effecting verb, so a read-only session that only
// refused `ctx.emit` would let it commit. Its table is created in the handler
// rather than in a migration deliberately — this module has none, and a DDL
// statement is a write like any other, so a rolled-back session leaves no table
// behind either.

const noteWriteOp: OperationHandler<{ note: string }, { wrote: string }> = async (ctx, input) => {
  assertAllowed(await ctx.check(permissionKey.parse('perm:use')));
  ctx.sql.exec('CREATE TABLE IF NOT EXISTS perm_notes (note TEXT NOT NULL)');
  ctx.sql.exec('INSERT INTO perm_notes (note) VALUES (?)', [input.note]);
  return { wrote: input.note };
};

const noteReadOp: OperationHandler<undefined, string[]> = (ctx) => {
  ctx.sql.exec('CREATE TABLE IF NOT EXISTS perm_notes (note TEXT NOT NULL)');
  return ctx.sql.query<{ note: string }>('SELECT note FROM perm_notes ORDER BY note').map(
    (r) => r.note,
  );
};

const requestIntentOp: OperationHandler<{ kind: string }, string> = async (ctx, input) => {
  assertAllowed(await ctx.check(permissionKey.parse('perm:use')));
  return ctx.requestPlatform({ kind: input.kind, payload: {} });
};

const readIntentsOp: OperationHandler<undefined, unknown> = (ctx) =>
  ctx.sql.query(
    'SELECT kind, requested_by, impersonation FROM _substrat_platform_requests ORDER BY id',
  );

/** The identity a caller is running as, as `ctx` reports it — never the staff actor. */
const whoAmIOp: OperationHandler<undefined, string> = (ctx) => ctx.principal;

// -- #770 sub-transaction handlers -------------------------------------------
// Every write a sub-transaction can make is exercised in one place: a row, an
// event, a link, and a platform intent. The storage transaction reaches all four
// (they are rows in this scope's own database); what it cannot reach is the
// in-memory state, which is why `atomic:extra` and the intent tally are here.

const ATOMIC_ITEM: EntityRef = { entityType: 'item', entityId: 'atomic-i1' };
const ATOMIC_BOX: EntityRef = { entityType: 'box', entityId: 'atomic-b1' };

/** Everything a callee can write, then throw — the shape #770 describes. */
const writeThenThrow = async (ctx: OperationContext, tag: string): Promise<never> => {
  assertAllowed(await ctx.check(permissionKey.parse('atomic:extra')));
  ctx.sql.exec('INSERT INTO atomic_rows (id, tag) VALUES (?, ?)', [`inner-${tag}`, 'callee']);
  ctx.emit({
    type: 'atomic.inner',
    schemaVersion: 1,
    entity: ATOMIC_ITEM,
    piiClass: 'none',
    payload: {},
  });
  ctx.link(ATOMIC_ITEM, ATOMIC_BOX);
  ctx.requestPlatform({ kind: 'test.rolled-back', payload: { tag } });
  throw new Error(`callee boom: ${tag}`);
};

/**
 * The headline case. Caller writes, calls a callee that writes all four kinds of
 * thing and throws, CATCHES it, then writes again and emits. Afterwards: none of
 * the callee's work exists, both of the caller's writes do, and the trailing
 * event must NOT carry `atomic:extra` — that check passed inside work that was
 * discarded.
 */
const atomicRollback: OperationHandler<undefined, { caught: string }> = async (ctx) => {
  assertAllowed(await ctx.check(permissionKey.parse('atomic:use')));
  ctx.sql.exec("INSERT INTO atomic_rows (id, tag) VALUES ('before', 'caller')");
  let caught = '';
  try {
    await ctx.atomic(() => writeThenThrow(ctx, 'rollback'));
  } catch (err) {
    caught = (err as Error).message;
  }
  ctx.sql.exec("INSERT INTO atomic_rows (id, tag) VALUES ('after', 'caller')");
  ctx.emit({
    type: 'atomic.acted',
    schemaVersion: 1,
    entity: ATOMIC_ITEM,
    piiClass: 'none',
    payload: {},
  });
  return { caught };
};

/** A sub-transaction that SUCCEEDS keeps its writes and returns its value. */
const atomicSuccess: OperationHandler<undefined, number> = async (ctx) => {
  assertAllowed(await ctx.check(permissionKey.parse('atomic:use')));
  return ctx.atomic(() => {
    ctx.sql.exec("INSERT INTO atomic_rows (id, tag) VALUES ('kept', 'callee')");
    return 42;
  });
};

/** Two SIBLING sub-transactions: the first fails, the second must be unaffected. */
const atomicStacked: OperationHandler<undefined, void> = async (ctx) => {
  assertAllowed(await ctx.check(permissionKey.parse('atomic:use')));
  try {
    await ctx.atomic(() => writeThenThrow(ctx, 'sibling'));
  } catch {
    /* expected */
  }
  await ctx.atomic(() => {
    ctx.sql.exec("INSERT INTO atomic_rows (id, tag) VALUES ('sibling-ok', 'callee')");
  });
};

/** NESTED: the inner rolls back, the outer keeps going and commits. */
const atomicNested: OperationHandler<undefined, void> = async (ctx) => {
  assertAllowed(await ctx.check(permissionKey.parse('atomic:use')));
  await ctx.atomic(async () => {
    ctx.sql.exec("INSERT INTO atomic_rows (id, tag) VALUES ('outer', 'callee')");
    try {
      await ctx.atomic(() => writeThenThrow(ctx, 'nested'));
    } catch {
      /* expected */
    }
    ctx.sql.exec("INSERT INTO atomic_rows (id, tag) VALUES ('outer-after', 'callee')");
  });
};

/**
 * A sub-transaction's commit is PROVISIONAL: it succeeded, but the operation then
 * throws, so its writes go with everything else. `atomic` narrows what a caught
 * error destroys — it never promotes writes past the operation's own commit.
 */
const atomicProvisional: OperationHandler<undefined, void> = async (ctx) => {
  assertAllowed(await ctx.check(permissionKey.parse('atomic:use')));
  await ctx.atomic(() => {
    ctx.sql.exec("INSERT INTO atomic_rows (id, tag) VALUES ('provisional', 'callee')");
  });
  throw new Error('operation boom');
};

/**
 * The assertion today's suite cannot express, and the one a Postgres host must
 * satisfy (design note §1): a caller catches a STORAGE error raised inside an
 * atomic — a primary-key violation, not a thrown JS error — and the enclosing
 * transaction is still usable afterwards. Without the savepoint this is where
 * Postgres would already be poisoned (`25P02`).
 */
const atomicRecoverable: OperationHandler<undefined, { caught: boolean }> = async (ctx) => {
  assertAllowed(await ctx.check(permissionKey.parse('atomic:use')));
  let caught = false;
  try {
    await ctx.atomic(() => {
      ctx.sql.exec("INSERT INTO atomic_rows (id, tag) VALUES ('dup', 'callee')");
      ctx.sql.exec("INSERT INTO atomic_rows (id, tag) VALUES ('dup', 'callee')");
    });
  } catch {
    caught = true;
  }
  ctx.sql.exec("INSERT INTO atomic_rows (id, tag) VALUES ('recovered', 'caller')");
  return { caught };
};

/** Interleaving is not nesting: two atomics started concurrently must fail loudly. */
const atomicInterleaved: OperationHandler<undefined, void> = async (ctx) => {
  assertAllowed(await ctx.check(permissionKey.parse('atomic:use')));
  const slow = () =>
    ctx.atomic(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  await Promise.all([slow(), slow()]);
};

const atomicReadRows: OperationHandler<undefined, { id: string; tag: string }[]> = (ctx) =>
  ctx.sql.query('SELECT id, tag FROM atomic_rows ORDER BY id');

const atomicReadOutbox: OperationHandler<
  undefined,
  { type: string; authorization: string | null }[]
> = (ctx) => ctx.sql.query('SELECT type, authorization FROM _substrat_outbox ORDER BY id');

const atomicReadTuples: OperationHandler<undefined, { subject: string }[]> = (ctx) =>
  ctx.sql.query("SELECT subject FROM _substrat_tuples WHERE object = 'box:atomic-b1'");

const atomicReadIntents: OperationHandler<undefined, { kind: string }[]> = (ctx) =>
  ctx.sql.query('SELECT kind FROM _substrat_platform_requests ORDER BY requested_at');

const flowStep1Consumer: ConsumerHandler = (ctx, event) => {
  ctx.sql.exec('INSERT INTO flow_log (event_id, type) VALUES (?, ?)', [event.id, event.type]);
  ctx.emit({
    type: 'flow.step2',
    schemaVersion: 1,
    entity: event.entity,
    piiClass: 'none',
    payload: {},
  });
};

const flowStep2Consumer: ConsumerHandler = (ctx, event) => {
  ctx.sql.exec('INSERT INTO flow_log (event_id, type) VALUES (?, ?)', [event.id, event.type]);
};

// -- module registrations ----------------------------------------------------

export const testMod: ModuleRegistration = {
  manifest: testModManifest,
  migrations: [
    {
      // Deliberately exercises the migration splitter's hard cases, so EVERY suite
      // that provisions a scope guards against a naive `split(';')` regressing on
      // an adapter: a `;` inside a line comment, inside a block comment, and inside
      // a string-literal DEFAULT — plus a second statement, so a truncated split
      // would leave `testmod_notes` missing. A broken splitter fails provisioning
      // outright ("incomplete input"), which is unmissable.
      version: '0001-init',
      sql: `
        CREATE TABLE testmod_items (id TEXT PRIMARY KEY, box TEXT NOT NULL); -- items; keyed by id
        /* a block comment; with a semicolon */
        CREATE TABLE testmod_notes (
          id   TEXT PRIMARY KEY,
          body TEXT NOT NULL DEFAULT 'n/a; see item'  -- string default holds a semicolon
        );
      `,
    },
  ],
  operations: {
    'testmod/add': addItem as OperationHandler<never, unknown>,
    'testmod/relink': relinkItem as OperationHandler<never, unknown>,
    'testmod/link-undeclared': linkUndeclared as OperationHandler<never, unknown>,
    'testmod/read-journal': readJournal as OperationHandler<never, unknown>,
    'testmod/read-tuples': readTuples as OperationHandler<never, unknown>,
    // #954 — the spine guard's fixtures.
    'testmod/forge-tuple': forgeTuple as OperationHandler<never, unknown>,
    'testmod/forge-outbox': forgeOutbox as OperationHandler<never, unknown>,
    'testmod/forge-drop-journal': forgeDropJournal as OperationHandler<never, unknown>,
    'testmod/forge-quoted': forgeQuoted as OperationHandler<never, unknown>,
    'testmod/forge-trigger': forgeTrigger as OperationHandler<never, unknown>,
    'testmod/forge-returning': forgeReturning as OperationHandler<never, unknown>,
    'testmod/forge-after-write': forgeAfterWrite as OperationHandler<never, unknown>,
    'testmod/project-journal': projectJournal as OperationHandler<never, unknown>,
    'testmod/read-items': readItems as OperationHandler<never, unknown>,
    'testmod/read-notes': readNotes as OperationHandler<never, unknown>,
  },
};

export const atomicMod: ModuleRegistration = {
  manifest: atomicModManifest,
  migrations: [
    { version: '0001-init', sql: 'CREATE TABLE atomic_rows (id TEXT PRIMARY KEY, tag TEXT NOT NULL)' },
  ],
  operations: {
    'atomic/rollback': atomicRollback as OperationHandler<never, unknown>,
    'atomic/success': atomicSuccess as OperationHandler<never, unknown>,
    'atomic/stacked': atomicStacked as OperationHandler<never, unknown>,
    'atomic/nested': atomicNested as OperationHandler<never, unknown>,
    'atomic/provisional': atomicProvisional as OperationHandler<never, unknown>,
    'atomic/recoverable': atomicRecoverable as OperationHandler<never, unknown>,
    'atomic/interleaved': atomicInterleaved as OperationHandler<never, unknown>,
    'atomic/read-rows': atomicReadRows as OperationHandler<never, unknown>,
    'atomic/read-outbox': atomicReadOutbox as OperationHandler<never, unknown>,
    'atomic/read-tuples': atomicReadTuples as OperationHandler<never, unknown>,
    'atomic/read-intents': atomicReadIntents as OperationHandler<never, unknown>,
  },
};

export const scheduleMod: ModuleRegistration = {
  manifest: scheduleModManifest,
  migrations: [
    { version: '0001-init', sql: 'CREATE TABLE sched_ticks (n INTEGER NOT NULL)' },
  ],
  operations: {
    // The scheduled operation: check the granted permission, then emit + record a
    // tick. Under a system caller its emitted event's actor must be { system: … }.
    'sched/tick': (async (ctx) => {
      assertAllowed(await ctx.check('sched:tick' as PermissionKey));
      ctx.sql.exec('INSERT INTO sched_ticks (n) VALUES (1)');
      ctx.emit({
        type: 'sched.ticked',
        schemaVersion: 1,
        entity: { entityType: 'sched-thing', entityId: 'tick' },
        piiClass: 'none',
        payload: {},
      });
    }) as OperationHandler<never, unknown>,
    // Checks a permission the schedule never granted the system principal — invoked
    // directly through the system door, it must be DENIED, proving ctx.check is the gate.
    'sched/needs-admin': (async (ctx) => {
      assertAllowed(await ctx.check('sched:admin' as PermissionKey));
    }) as OperationHandler<never, unknown>,
    'sched/count': ((ctx) =>
      ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM sched_ticks')[0]!.n) as OperationHandler<
      never,
      unknown
    >,
    'sched/read-outbox': ((ctx) =>
      ctx.sql.query<{ type: string; actor: string }>(
        'SELECT type, actor FROM _substrat_outbox ORDER BY id',
      )) as OperationHandler<never, unknown>,
    'sched/schedule-state': ((ctx) =>
      ctx.sql.query<{ schedule_op: string; last_status: string }>(
        'SELECT schedule_op, last_status FROM _substrat_schedule_state ORDER BY schedule_op',
      )) as OperationHandler<never, unknown>,
  },
};

export const flowMod: ModuleRegistration = {
  manifest: flowModManifest,
  migrations: [
    {
      version: '0001-init',
      sql: 'CREATE TABLE flow_log (event_id TEXT PRIMARY KEY, type TEXT NOT NULL)',
    },
  ],
  operations: {
    'flow/produce': ((ctx) => {
      ctx.emit({
        type: 'flow.step1',
        schemaVersion: 1,
        entity: { entityType: 'flow-thing', entityId: 'f1' },
        piiClass: 'none',
        payload: {},
      });
    }) as OperationHandler<never, unknown>,
    'flow/log': ((ctx) =>
      ctx.sql.query('SELECT event_id, type FROM flow_log ORDER BY event_id')) as OperationHandler<
      never,
      unknown
    >,
    'flow/deliveries': ((ctx) =>
      ctx.sql.query(
        `SELECT event_id, consumer_module, error FROM _substrat_deliveries
         WHERE consumer_module = '@test/flow' ORDER BY event_id`,
      )) as OperationHandler<never, unknown>,
    'flow/step2-actors': ((ctx) =>
      ctx.sql.query(
        `SELECT actor FROM _substrat_outbox WHERE type = 'flow.step2'`,
      )) as OperationHandler<never, unknown>,
  },
  consumers: {
    'flow.step1': flowStep1Consumer,
    'flow.step2': flowStep2Consumer,
  },
};

export const guardedMod: ModuleRegistration = {
  manifest: guardedModManifest,
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE guarded_t (v TEXT NOT NULL)' }],
  operations: {
    'guarded/act': ((ctx, input: { flag?: string }) => {
      ctx.sql.exec('INSERT INTO guarded_t (v) VALUES (?)', [input?.flag ?? 'none']);
      ctx.emit({
        type: 'guarded.acted',
        schemaVersion: 1,
        entity: { entityType: 'guarded-thing', entityId: 'g1' },
        piiClass: 'none',
        payload: {},
      });
    }) as OperationHandler<never, unknown>,
    'guarded/orphan': (() => 'ran') as OperationHandler<never, unknown>,
    'guarded/rows': ((ctx) =>
      ctx.sql.query<{ v: string }>('SELECT v FROM guarded_t').map((r) => r.v)) as OperationHandler<
      never,
      unknown
    >,
    'guarded/events': ((ctx) =>
      ctx.sql.query('SELECT id FROM _substrat_outbox WHERE type = ?', ['guarded.acted'])
        .length) as OperationHandler<never, unknown>,
  },
};

export const gateMod: ModuleRegistration = {
  manifest: gateModManifest,
  predicates: {
    // The predicate sees ctx (its own transaction), the manifest config, and the
    // operation input. It THROWS to block, returns to allow.
    'gate/flag-set': (_ctx, config, input) => {
      const want = config.flag;
      const got = (input as { flag?: string } | undefined)?.flag;
      if (got !== want)
        throw new Error(`guard: expected flag '${String(want)}', got '${String(got)}'`);
    },
  },
};

export const withdrawEarlyMod: ModuleRegistration = { manifest: withdrawEarlyManifest };

export const victimMod: ModuleRegistration = {
  manifest: victimModManifest,
  operations: {
    'victim/a': (() => 'a') as OperationHandler<never, unknown>,
    'victim/b': (() => 'b') as OperationHandler<never, unknown>,
    'victim/c': (() => 'c') as OperationHandler<never, unknown>,
  },
};

export const withdrawLateMod: ModuleRegistration = { manifest: withdrawLateManifest };

export const lateMod: ModuleRegistration = {
  manifest: lateModManifest,
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE late_t (id TEXT PRIMARY KEY)' }],
  operations: {
    'late/check': ((ctx) =>
      ctx.sql.query(`SELECT name FROM sqlite_master WHERE name = 'late_t'`)
        .length) as OperationHandler<never, unknown>,
  },
};

export const billedMod: ModuleRegistration = {
  manifest: billedModManifest,
  operations: {
    'billed/act': (() => 'ran') as OperationHandler<never, unknown>,
    // #304: read the request-time entitlement view. Gated on 'billed' like every op in this
    // module, so the tenant holds 'billed' when it runs; the KEY read is the operation input,
    // letting a test read a held key, an absent key (→ null), or an expired one (→ null).
    'billed/read-entitlement': (async (ctx, key) =>
      ctx.entitlement(key as string)) as OperationHandler<string, unknown>,
    'billed/list-entitlements': (async (ctx) => ctx.entitlements()) as OperationHandler<never, unknown>,
  },
};

export const impersonationEchoMod: ModuleRegistration = {
  manifest: impersonationEchoManifest,
  migrations: [
    {
      version: '0001-init',
      sql: 'CREATE TABLE imp_echo (event_id TEXT PRIMARY KEY, impersonation TEXT)',
    },
  ],
  operations: {
    'imp-echo/seen': ((ctx) =>
      ctx.sql.query(
        'SELECT event_id, impersonation FROM imp_echo ORDER BY event_id',
      )) as OperationHandler<never, unknown>,
  },
  consumers: {
    // The stamp as the CONSUMER received it, JSON-encoded so an absent one and a
    // null one stay distinguishable in the assertion.
    'perm.acted': ((ctx, event) => {
      ctx.sql.exec('INSERT INTO imp_echo (event_id, impersonation) VALUES (?, ?)', [
        event.id,
        event.impersonation === undefined ? null : JSON.stringify(event.impersonation),
      ]);
    }) as ConsumerHandler,
  },
};

export const permMod: ModuleRegistration = {
  manifest: permModManifest,
  operations: {
    'perm/link': linkOp as OperationHandler<never, unknown>,
    'perm/probe': probeOp as OperationHandler<never, unknown>,
    'perm/authorized-emit': authorizedEmitOp as OperationHandler<never, unknown>,
    'perm/authorized-read': authorizedReadOp as OperationHandler<never, unknown>,
    'perm/read-outbox': readOutboxOp as OperationHandler<never, unknown>,
    'perm/read-denials': readDenialsOp as OperationHandler<never, unknown>,
    // K-42 (#868)
    'perm/write-note': noteWriteOp as OperationHandler<never, unknown>,
    'perm/read-notes': noteReadOp as OperationHandler<never, unknown>,
    'perm/request-intent': requestIntentOp as OperationHandler<never, unknown>,
    'perm/read-intents': readIntentsOp as OperationHandler<never, unknown>,
    'perm/whoami': whoAmIOp as OperationHandler<never, unknown>,
    // #304: read the request-time entitlement view — used by the scope-local (projected)
    // and CP-less path tests to prove a hosted vertical reads entitlements without a CP.
    'perm/read-entitlement': (async (ctx, key) =>
      ctx.entitlement(key as string)) as OperationHandler<string, unknown>,
    // #687: seal a value TO a connector — the write half of the contact carrier.
    // Deliberately UNGUARDED, like `perm/share` below and for the same reason: what
    // is under test is the seam itself, and a permission check in front of it would
    // only prove the check. Returns the envelope so a test can assert the shape and
    // hand it back through `conn.unseal` on the other side.
    'perm/seal-to-connection': (async (ctx, input) => {
      const i = input as { provider: string; plaintext: string };
      return ctx.sealToConnection(i.provider, i.plaintext);
    }) as OperationHandler<never, unknown>,
    // Runtime delegation (ctx.grant/ctx.revoke). Deliberately UNGUARDED by an
    // operation-level check: the guardrail under test lives inside the verb, so
    // wrapping it in one here would hide whether it works.
    'perm/share': (async (ctx, input) => {
      const i = input as { principal: string; permission: string; entity: EntityRef };
      await ctx.grant(
        principalId.parse(i.principal),
        permissionKey.parse(i.permission),
        i.entity,
      );
      return { granted: true };
    }) as OperationHandler<never, unknown>,
    // The §5.1 assignment bound. UNGUARDED for the same reason `perm/share` is: the
    // guardrail under test is inside the verb, and an operation-level check in front of
    // it would only prove the check.
    'perm/can-assign': (async (ctx, input) => {
      return ctx.canAssign((input as { roleKey: string }).roleKey);
    }) as OperationHandler<never, unknown>,
    'perm/unshare': (async (ctx, input) => {
      const i = input as { principal: string; permission: string; entity: EntityRef };
      await ctx.revoke(
        principalId.parse(i.principal),
        permissionKey.parse(i.permission),
        i.entity,
      );
      return { revoked: true };
    }) as OperationHandler<never, unknown>,
  },
};

export const connectorModManifest = moduleManifest.parse({
  id: '@test/connector',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'connector:use', description: 'connector permission' }],
  events: {
    emits: [
      { type: 'member.add-requested', schemaVersion: 1 },
      // #100's fixtures: an effect that can be made to fail on demand, so the
      // retry/dead-letter contract is exercised rather than described.
      { type: 'effect.requested', schemaVersion: 1 },
      { type: 'effect.doomed', schemaVersion: 1 },
      { type: 'outbound.requested', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'connector',
});

/**
 * The module half of the connector seam (K-22 §4.2). It records its own domain row
 * and emits a FAT event asking for a membership it cannot itself effect — membership
 * is tenant-wide and lives in the directory, outside this scope's transaction.
 *
 * `request-and-throw` exists to prove the property the seam is chosen for: the emit
 * commits WITH the domain write, so a rollback leaves no event and therefore nothing
 * for the executor to effect. An in-scope cross-DO write could not offer that.
 */
export const connectorMod: ModuleRegistration = {
  manifest: connectorModManifest,
  migrations: [
    {
      version: '0001-init',
      sql: 'CREATE TABLE connector_requests (id TEXT PRIMARY KEY, principal TEXT NOT NULL)',
    },
  ],
  operations: {
    'connector/request-member': ((ctx: OperationContext, input: { principal: string; orgId: string }) => {
      ctx.sql.exec('INSERT INTO connector_requests (id, principal) VALUES (?, ?)', [
        input.principal,
        input.principal,
      ]);
      ctx.emit({
        type: 'member.add-requested',
        schemaVersion: 1,
        entity: { entityType: 'membership', entityId: input.principal },
        piiClass: 'none',
        // Fat: the executor must never need a cross-module read to act.
        payload: { principal: input.principal, orgId: input.orgId, tenantId: ctx.tenantId },
      });
    }) as unknown as OperationHandler<never, unknown>,
    'connector/request-and-throw': ((ctx: OperationContext, input: { principal: string; orgId: string }) => {
      ctx.emit({
        type: 'member.add-requested',
        schemaVersion: 1,
        entity: { entityType: 'membership', entityId: input.principal },
        piiClass: 'none',
        payload: { principal: input.principal, orgId: input.orgId, tenantId: ctx.tenantId },
      });
      throw new Error('deliberate failure after emit');
    }) as unknown as OperationHandler<never, unknown>,
    /**
     * Ask for an effect, tagged. The suite's executor throws for any tag starting
     * `poison`, which is how a *selective* failure gets tested — a handler that
     * failed for everything could not show that one bad delivery leaves the
     * others alone.
     */
    'connector/request-effect': ((ctx: OperationContext, input: { tag: string }) => {
      ctx.emit({
        type: 'effect.requested',
        schemaVersion: 1,
        entity: { entityType: 'effect', entityId: input.tag },
        piiClass: 'none',
        payload: { tag: input.tag },
      });
    }) as unknown as OperationHandler<never, unknown>,
    /** Handled by an executor whose attempts are exhausted almost immediately. */
    'connector/request-doomed': ((ctx: OperationContext, input: { tag: string }) => {
      ctx.emit({
        type: 'effect.doomed',
        schemaVersion: 1,
        entity: { entityType: 'effect', entityId: input.tag },
        piiClass: 'none',
        payload: { tag: input.tag },
      });
    }) as unknown as OperationHandler<never, unknown>,
    /** Asks a CONNECTOR (not an executor) to call an external provider. */
    'connector/request-outbound': ((ctx: OperationContext, input: { tag: string }) => {
      ctx.emit({
        type: 'outbound.requested',
        schemaVersion: 1,
        entity: { entityType: 'effect', entityId: input.tag },
        piiClass: 'none',
        payload: { tag: input.tag },
      });
    }) as unknown as OperationHandler<never, unknown>,
    'connector/requests': ((ctx: OperationContext) =>
      ctx.sql.query('SELECT id FROM connector_requests')) as unknown as OperationHandler<
      never,
      unknown
    >,
  },
};

/**
 * The modules the scope-host suite's `beforeAll` registers, in the exact order
 * the original inline registration used — order carries meaning: the early
 * withdrawer precedes @test/victim, the late withdrawer follows it, and the
 * guarded module precedes the gate that supplies its predicate.
 */
export const contractTestInitialModules: ModuleRegistration[] = [
  connectorMod,
  testMod,
  flowMod,
  guardedMod,
  gateMod,
  withdrawEarlyMod,
  victimMod,
  withdrawLateMod,
];

/**
 * Every module a CF ScopeDO must carry to serve BOTH suites — the initial set
 * plus the ones the suites register mid-test (`lateMod`, `billedMod`) and the
 * permission suite's module. The DO closes over all of them at construction; the
 * facade still gates/withdraws exactly as each suite drives it.
 */
// -- search (#827) -----------------------------------------------------------

/**
 * A module whose entity is DECLARED searchable, so both adapters have to derive
 * the index, run the triggers and answer `ctx.search`.
 *
 * The manifest carries `table`/`idColumn` because `manifestEntities()` puts them
 * there — written out longhand here rather than pulling the registry into a
 * fixture, which is the one place the enrichment is worth restating.
 */
export const listModManifest = moduleManifest.parse({
  id: '@test/list',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'list:use', description: 'page the things' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'list',
  lists: [
    // `number` is unique, `status` deliberately is NOT — the tie-break only has
    // something to prove against a column with ties in it.
    {
      entityType: 'listorder',
      sortable: ['number', 'status', 'id'],
      filterable: ['status', 'kind'],
      table: 'list_orders',
      idColumn: 'id',
    },
  ],
});

export const listMod: ModuleRegistration = {
  manifest: listModManifest,
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE list_orders (
              id TEXT PRIMARY KEY, number TEXT NOT NULL,
              status TEXT NOT NULL, kind TEXT NOT NULL);`,
    },
  ],
  operations: {
    'list/add': (async (ctx, input) => {
      const i = input as { id: string; number: string; status: string; kind: string };
      ctx.sql.exec('INSERT INTO list_orders (id, number, status, kind) VALUES (?, ?, ?, ?)', [
        i.id,
        i.number,
        i.status,
        i.kind,
      ]);
      return { id: i.id };
    }) as OperationHandler<never, unknown>,
    // The read under test, passed straight through: the suite asserts on the
    // entries, the cursor and the total, which is where a naive keyset is wrong.
    'list/page': (async (ctx, input) => {
      const i = input as {
        limit: number;
        sort?: string;
        order?: 'asc' | 'desc';
        cursor?: string;
        filters?: Record<string, unknown>;
        total?: boolean;
      };
      return ctx.page<Record<string, unknown>>('listorder', i);
    }) as OperationHandler<never, unknown>,
    // Takes the entity type from the caller, so the suite can ask for one no
    // module declared and see `NotListable` rather than a guess.
    'list/page-of': (async (ctx, input) => {
      const i = input as { entityType: string; limit: number };
      return ctx.page<Record<string, unknown>>(i.entityType, { limit: i.limit });
    }) as OperationHandler<never, unknown>,
    // Write then page back INSIDE one operation — a page is a plain read of the
    // content table, so it must see the row the same transaction just wrote.
    'list/add-then-page': (async (ctx, input) => {
      const i = input as { id: string; number: string; status: string; kind: string };
      ctx.sql.exec('INSERT INTO list_orders (id, number, status, kind) VALUES (?, ?, ?, ?)', [
        i.id,
        i.number,
        i.status,
        i.kind,
      ]);
      return ctx.page<Record<string, unknown>>('listorder', { limit: 50 });
    }) as OperationHandler<never, unknown>,
  },
};

export const searchModManifest = moduleManifest.parse({
  id: '@test/search',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'search:use', description: 'search the things' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'search',
  searchables: [
    { entityType: 'searchcustomer', fields: ['name', 'number'], table: 'search_customers', idColumn: 'id' },
    // The same rows, matched inside the word — so the suite can hold the two
    // tokenizers to their documented difference rather than assuming it.
    { entityType: 'searchnote', fields: ['body'], table: 'search_notes', idColumn: 'id', tokenizer: 'substring' },
  ],
});

export const searchMod: ModuleRegistration = {
  manifest: searchModManifest,
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE search_customers (id TEXT PRIMARY KEY, number TEXT NOT NULL, name TEXT NOT NULL);
            CREATE TABLE search_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);`,
    },
  ],
  operations: {
    'search/add': (async (ctx, input) => {
      const i = input as { id: string; number: string; name: string };
      ctx.sql.exec('INSERT INTO search_customers (id, number, name) VALUES (?, ?, ?)', [
        i.id,
        i.number,
        i.name,
      ]);
      return { id: i.id };
    }) as OperationHandler<never, unknown>,
    'search/rename': (async (ctx, input) => {
      const i = input as { id: string; name: string };
      ctx.sql.exec('UPDATE search_customers SET name = ? WHERE id = ?', [i.name, i.id]);
      return { id: i.id };
    }) as OperationHandler<never, unknown>,
    'search/remove': (async (ctx, input) => {
      ctx.sql.exec('DELETE FROM search_customers WHERE id = ?', [(input as { id: string }).id]);
      return { removed: true };
    }) as OperationHandler<never, unknown>,
    'search/add-note': (async (ctx, input) => {
      const i = input as { id: string; body: string };
      ctx.sql.exec('INSERT INTO search_notes (id, body) VALUES (?, ?)', [i.id, i.body]);
      return { id: i.id };
    }) as OperationHandler<never, unknown>,
    // The read under test. Returns hits verbatim — the suite asserts on ids and
    // on the ORDER, which is the half a naive implementation gets wrong.
    'search/find': (async (ctx, input) => {
      const i = input as { entityType: string; term: string; limit?: number };
      return ctx.search(i.entityType, i.term, i.limit === undefined ? undefined : { limit: i.limit });
    }) as OperationHandler<never, unknown>,
    // Write and read back INSIDE one operation: the read-after-write guarantee
    // that picking triggers over event-sourced indexing exists to buy.
    'search/add-then-find': (async (ctx, input) => {
      const i = input as { id: string; number: string; name: string; term: string };
      ctx.sql.exec('INSERT INTO search_customers (id, number, name) VALUES (?, ?, ?)', [
        i.id,
        i.number,
        i.name,
      ]);
      return ctx.search('searchcustomer', i.term);
    }) as OperationHandler<never, unknown>,
  },
};

// -- #893: the declared input the HOST parses ---------------------------------

export const parseModManifest = moduleManifest.parse({
  id: '@test/parse',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'parse:use', description: 'the parse fixture permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'parse',
});

const PARSE_USE = permissionKey.parse('parse:use');

/**
 * Every handler here ECHOES what it was handed, and asserts nothing itself.
 *
 * That is deliberate: the contract under test is what the host does to an
 * invocation's input *before* module code runs, so the fixture's job is to make
 * that observable rather than to judge it. A handler that validated would prove
 * only that it agrees with itself — the same note `entityCheckConformanceSuite`
 * makes about minting grants through the vertical's own sharing operation.
 */
const echo: OperationHandler<unknown, unknown> = async (ctx, input) => {
  assertAllowed(await ctx.check(PARSE_USE));
  return { received: input ?? null };
};

/**
 * The declaration the fixture's schemas are derived from.
 *
 * A literal rather than a `defineOperations` call: `operationInputsOf` reads
 * `input`, `inputOptional` and `paged` and nothing else, and contracts' own
 * tests are where the declaration DSL is exercised. What this suite is for is
 * the HOST end — that the schema reaches the door and is applied there.
 */
const parseDeclaration = {
  // A required field, an optional one, and a default — the default is the case a
  // handler cannot fake: it must arrive SET without the caller sending it.
  'parse/echo': {
    input: z.object({
      name: z.string().min(1),
      tag: z.string().optional(),
      size: z.number().int().default(7),
    }),
  },
  // Declared `paged`: the platform's page trio must survive a strict parse, or a
  // paged read is handed an unpaged request (#811).
  'parse/paged': {
    input: z.object({ q: z.string().optional() }),
    paged: {},
  },
  // Declares nothing. The handler takes `undefined`, and the host must not
  // invent a `{}` for it.
  'parse/bare': {},
};

export const parseMod: ModuleRegistration = {
  manifest: parseModManifest,
  operations: {
    'parse/echo': echo as OperationHandler<never, unknown>,
    'parse/paged': echo as OperationHandler<never, unknown>,
    'parse/bare': echo as OperationHandler<never, unknown>,
  },
  operationInputs: operationInputsOf(parseDeclaration),
};

// -- #129: the precondition the HOST compares ---------------------------------

export const concurrencyModManifest = moduleManifest.parse({
  id: '@test/concurrency',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'conc:use', description: 'the concurrency fixture permission' },
    { key: 'conc:never', description: 'granted to nobody — the ordering probe' },
  ],
  events: { emits: [{ type: 'conc.changed', schemaVersion: 1 }], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'conc',
});

const CONC_USE = permissionKey.parse('conc:use');

/**
 * A guarded write: it announces what it did, so the version it is guarded on
 * moves. This is the shape `assertConcurrencyMovesVersion` requires, and the one
 * the suite drives both halves of — the refusal and the fresh tag.
 */
const concUpdate: OperationHandler<{ thingId: string; label?: string }, unknown> = async (ctx, input) => {
  assertAllowed(await ctx.check(CONC_USE));
  ctx.sql.exec('CREATE TABLE IF NOT EXISTS conc_things (id TEXT PRIMARY KEY, label TEXT)');
  ctx.sql.exec(
    'INSERT INTO conc_things (id, label) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label',
    [input.thingId, input.label ?? null],
  );
  ctx.emit({
    type: 'conc.changed',
    schemaVersion: 1,
    entity: { entityType: 'conc-thing', entityId: input.thingId },
    piiClass: 'none',
    payload: { label: input.label ?? null },
  });
  return { id: input.thingId, label: input.label ?? null };
};

/**
 * A guarded READ. No `emits`, and that is legal here: on a read the declaration
 * means "answer with the current tag", which is how a caller comes to hold one at
 * all. Nothing is serialised and nothing can be refused.
 */
const concRead: OperationHandler<{ thingId: string }, unknown> = async (ctx, input) => {
  assertAllowed(await ctx.check(CONC_USE));
  return { id: input.thingId };
};

/**
 * Guarded, and announces NOTHING — the inversion `assertConcurrencyMovesVersion`
 * refuses at declaration time.
 *
 * Declared here anyway, because the compile-time check and the host are separate
 * guarantees and this suite tests the host. What it pins is that the host does
 * not invent a version for a write that emitted none: the tag does not move, two
 * callers holding the same one both pass, and the lost update happens. That is
 * the behaviour the model-layer refusal exists to make undeclarable, and pinning
 * it is what stops someone "fixing" it here — where the fix would be to fabricate
 * a version the spine never recorded.
 */
const concSilent: OperationHandler<{ thingId: string; label?: string }, unknown> = async (ctx, input) => {
  assertAllowed(await ctx.check(CONC_USE));
  ctx.sql.exec('CREATE TABLE IF NOT EXISTS conc_things (id TEXT PRIMARY KEY, label TEXT)');
  ctx.sql.exec(
    'INSERT INTO conc_things (id, label) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label',
    [input.thingId, input.label ?? null],
  );
  return { id: input.thingId };
};

/**
 * Guarded, and refuses EVERY caller. The precondition must never answer ahead of
 * it — see the suite case, and the ordering note in both adapters.
 */
const concForbidden: OperationHandler<{ thingId: string }, unknown> = async (ctx, input) => {
  assertAllowed(await ctx.check(permissionKey.parse('conc:never')));
  return { id: input.thingId };
};

/** Declares no `concurrency` at all — an `If-Match` here must be refused, not ignored. */
const concUnguarded: OperationHandler<{ thingId: string }, unknown> = async (ctx, input) => {
  assertAllowed(await ctx.check(CONC_USE));
  return { id: input.thingId };
};

const concurrencyDeclaration = {
  'conc/update': {
    input: z.object({ thingId: z.string(), label: z.string().optional() }),
    concurrency: { over: 'conc-thing', idFrom: 'thingId' },
  },
  'conc/read': {
    input: z.object({ thingId: z.string() }),
    concurrency: { over: 'conc-thing', idFrom: 'thingId' },
  },
  'conc/silent': {
    input: z.object({ thingId: z.string(), label: z.string().optional() }),
    concurrency: { over: 'conc-thing', idFrom: 'thingId' },
  },
  // Guarded over a field the caller may omit — the case `concurrencyRef` refuses
  // rather than skips, since a precondition with no row reads as one that passed.
  'conc/keyless': {
    input: z.object({ thingId: z.string().optional() }),
    concurrency: { over: 'conc-thing', idFrom: 'thingId' },
  },
  'conc/forbidden': {
    input: z.object({ thingId: z.string() }),
    concurrency: { over: 'conc-thing', idFrom: 'thingId' },
  },
  'conc/unguarded': { input: z.object({ thingId: z.string() }) },
};

export const concurrencyMod: ModuleRegistration = {
  manifest: concurrencyModManifest,
  operations: {
    'conc/update': concUpdate as OperationHandler<never, unknown>,
    'conc/read': concRead as OperationHandler<never, unknown>,
    'conc/silent': concSilent as OperationHandler<never, unknown>,
    'conc/keyless': concRead as OperationHandler<never, unknown>,
    'conc/forbidden': concForbidden as OperationHandler<never, unknown>,
    'conc/unguarded': concUnguarded as OperationHandler<never, unknown>,
  },
  operationInputs: operationInputsOf(concurrencyDeclaration),
  operationConcurrency: operationConcurrencyOf(concurrencyDeclaration),
};

// -- #116: request idempotency ------------------------------------------------

export const idempotencyModManifest = moduleManifest.parse({
  id: '@test/idempotency',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'idem:use', description: 'the idempotency fixture permission' }],
  events: { emits: [{ type: 'idem.created', schemaVersion: 1 }], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'idem',
});

const IDEM_USE = permissionKey.parse('idem:use');

/**
 * The fixture that makes a duplicate VISIBLE.
 *
 * Every call appends a row, so "was this replayed?" is not answered by trusting
 * a flag the host set — it is answered by counting what the handler did. A suite
 * that asserted only on the returned value would pass just as happily against a
 * host that re-ran the operation and happened to produce the same answer, which
 * is precisely the bug (a second work order looks a lot like the first).
 */
const idemCreate: OperationHandler<{ thingId: string; label?: string }, unknown> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(IDEM_USE));
  ctx.sql.exec('CREATE TABLE IF NOT EXISTS idem_runs (run TEXT PRIMARY KEY, thing TEXT)');
  const run = ulid();
  ctx.sql.exec('INSERT INTO idem_runs (run, thing) VALUES (?, ?)', [run, input.thingId]);
  ctx.emit({
    type: 'idem.created',
    schemaVersion: 1,
    entity: { entityType: 'idem-thing', entityId: input.thingId },
    piiClass: 'none',
    payload: { label: input.label ?? null },
  });
  return { id: input.thingId, run, label: input.label ?? null };
};

/** Counts what actually ran — the suite's ground truth. */
const idemRuns: OperationHandler<Record<string, never>, unknown> = async (ctx) => {
  assertAllowed(await ctx.check(IDEM_USE));
  ctx.sql.exec('CREATE TABLE IF NOT EXISTS idem_runs (run TEXT PRIMARY KEY, thing TEXT)');
  const rows = ctx.sql.query('SELECT run FROM idem_runs') as { run: string }[];
  return { count: rows.length };
};

/**
 * Fails after writing, every time.
 *
 * The write matters: it proves the recording rolls back with the work rather
 * than merely never being reached. A retry must execute, because nothing
 * happened the first time.
 */
const idemFails: OperationHandler<{ thingId: string }, unknown> = async (ctx, input) => {
  assertAllowed(await ctx.check(IDEM_USE));
  ctx.sql.exec('CREATE TABLE IF NOT EXISTS idem_runs (run TEXT PRIMARY KEY, thing TEXT)');
  ctx.sql.exec('INSERT INTO idem_runs (run, thing) VALUES (?, ?)', [ulid(), input.thingId]);
  throw new Error('idem/fails always fails');
};

/** Returns more than `IDEMPOTENCY_RESULT_LIMIT` — the recording that cannot be kept. */
const idemBig: OperationHandler<{ thingId: string }, unknown> = async (ctx, input) => {
  assertAllowed(await ctx.check(IDEM_USE));
  ctx.sql.exec('CREATE TABLE IF NOT EXISTS idem_runs (run TEXT PRIMARY KEY, thing TEXT)');
  ctx.sql.exec('INSERT INTO idem_runs (run, thing) VALUES (?, ?)', [ulid(), input.thingId]);
  return { id: input.thingId, blob: 'x'.repeat(IDEMPOTENCY_RESULT_LIMIT + 1) };
};

/**
 * Declares `idempotency: false` — its response is a credential in the story this
 * fixture tells, and must not be recorded. A key here is REFUSED.
 */
const idemSecret: OperationHandler<{ thingId: string }, unknown> = async (ctx, input) => {
  assertAllowed(await ctx.check(IDEM_USE));
  ctx.sql.exec('CREATE TABLE IF NOT EXISTS idem_runs (run TEXT PRIMARY KEY, thing TEXT)');
  ctx.sql.exec('INSERT INTO idem_runs (run, thing) VALUES (?, ?)', [ulid(), input.thingId]);
  return { id: input.thingId, secret: 'never-recorded' };
};

const idempotencyDeclaration = {
  'idem/create': {
    input: z.object({ thingId: z.string(), label: z.string().optional() }),
  },
  // Guarded AND idempotent — the two seams on one operation, which is the case
  // that proves a replay hands back the original's tag rather than no tag.
  'idem/create-guarded': {
    input: z.object({ thingId: z.string(), label: z.string().optional() }),
    concurrency: { over: 'idem-thing', idFrom: 'thingId' },
  },
  'idem/runs': { input: z.object({}) },
  'idem/fails': { input: z.object({ thingId: z.string() }) },
  'idem/big': { input: z.object({ thingId: z.string() }) },
  'idem/secret': { input: z.object({ thingId: z.string() }), idempotency: false as const },
};

export const idempotencyMod: ModuleRegistration = {
  manifest: idempotencyModManifest,
  operations: {
    'idem/create': idemCreate as OperationHandler<never, unknown>,
    'idem/create-guarded': idemCreate as OperationHandler<never, unknown>,
    'idem/runs': idemRuns as OperationHandler<never, unknown>,
    'idem/fails': idemFails as OperationHandler<never, unknown>,
    'idem/big': idemBig as OperationHandler<never, unknown>,
    'idem/secret': idemSecret as OperationHandler<never, unknown>,
  },
  operationInputs: operationInputsOf(idempotencyDeclaration),
  operationConcurrency: operationConcurrencyOf(idempotencyDeclaration),
  operationIdempotencyOptOuts: operationIdempotencyOptOutsOf(idempotencyDeclaration),
};

export const contractTestModules: ModuleRegistration[] = [
  ...contractTestInitialModules,
  lateMod,
  billedMod,
  permMod,
  // K-42 (#868): the consumer that proves the two-actor stamp survives the outbox
  // read. It consumes `perm.acted` and writes one row per delivery; nothing else
  // in the kit reads `imp_echo`, so it is inert for every other suite.
  impersonationEchoMod,
  connectorMod,
  scheduleMod,
  atomicMod,
  searchMod,
  listMod,
  parseMod,
  concurrencyMod,
  idempotencyMod,
];

export const brokenModManifest = moduleManifest.parse({
  id: '@test/broken',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'broken:use', description: 'broken module permission' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'broken',
});

/**
 * A module whose migration cannot apply (§5.3 "failure is per-scope and fails
 * closed"). Deliberately NOT in `contractTestModules` — every scope shares a
 * module set, so a broken migration there would fail every scope in every suite.
 * Adapters host it on a SEPARATE scope-host/DO to exercise the failure path.
 *
 * The second migration is the one that throws, so a partial apply is observable:
 * `0001-ok` lands and is journaled, `0002-broken` rolls back. That is what makes
 * the projected `schemaVersion` on the failure path meaningful rather than 0.
 */
export const brokenMod: ModuleRegistration = {
  manifest: brokenModManifest,
  migrations: [
    { version: '0001-ok', sql: 'CREATE TABLE broken_ok (id TEXT PRIMARY KEY)' },
    { version: '0002-broken', sql: 'CREATE TABLE broken_t (' },
  ],
  operations: {
    'broken/act': (() => 'ran') as OperationHandler<never, unknown>,
  },
};
