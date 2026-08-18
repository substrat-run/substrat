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
  permissionKey,
  principalId,
  type EntityRef,
  type PermissionKey,
} from '@substrat-run/contracts';
import {
  assertAllowed,
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
  'test/read-outbox': ((ctx) =>
    ctx.sql.query<OutboxRow>('SELECT * FROM _substrat_outbox ORDER BY id')) as OperationHandler<
    never,
    unknown
  >,
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

const readOutboxOp: OperationHandler<undefined, unknown> = (ctx) =>
  ctx.sql.query('SELECT id, type, authorization FROM _substrat_outbox ORDER BY id');

const readDenialsOp: OperationHandler<undefined, unknown> = (ctx) =>
  ctx.sql.query(
    'SELECT actor, permission, tenant_id, scope_id, operation FROM _substrat_denials ORDER BY id',
  );

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

export const permMod: ModuleRegistration = {
  manifest: permModManifest,
  operations: {
    'perm/link': linkOp as OperationHandler<never, unknown>,
    'perm/probe': probeOp as OperationHandler<never, unknown>,
    'perm/authorized-emit': authorizedEmitOp as OperationHandler<never, unknown>,
    'perm/read-outbox': readOutboxOp as OperationHandler<never, unknown>,
    'perm/read-denials': readDenialsOp as OperationHandler<never, unknown>,
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
export const contractTestModules: ModuleRegistration[] = [
  ...contractTestInitialModules,
  lateMod,
  billedMod,
  permMod,
  connectorMod,
  scheduleMod,
  atomicMod,
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
