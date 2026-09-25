import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  dataSubjectId,
  eventId,
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  z,
  type ImportBatch,
  type ImportCursorMove,
  type ImportCursorMoved,
  type PermissionKey,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  crossVerticalHealth,
  runPlatformSweep,
  ulid,
  type CrossVerticalReach,
  type FetchLike,
  type ModuleRegistration,
  type OperationHandler,
  type PlatformSweepReport,
  type ScopeHost,
  type SweepRunInput,
} from '@substrat-run/kernel';

// -- the two fixture verticals ------------------------------------------------
//
// Named as the verticals of one tenant would be: a CRM that owns customers, and a board-room
// app that keeps an association per customer. They live in two DEPLOYMENTS (two hosts over
// one directory), so every decision the suite asserts is made by the code of the side that
// owns it: what leaves by the producer's own exports, and what runs by the consumer's own
// imports.
//
// A ping-pong is built in on purpose: board exports `board.association-linked`, crm imports
// it and answers with `crm.customer-touched`, which crm exports and board imports. Only
// `crm/touch` starts it. It is the loop the hop cap exists to break.

export const CRM_VERTICAL = 'acme/crm';
export const BOARD_VERTICAL = 'acme/board';

const key = (k: string): PermissionKey => permissionKey.parse(k);

export const crmExportModManifest = moduleManifest.parse({
  id: '@test/crm-export',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'customer:read', description: 'read customers — what a receiving vertical must hold' },
    { key: 'customer:write', description: 'create customers' },
  ],
  events: {
    emits: [
      { type: 'crm.customer-created', schemaVersion: 1 },
      { type: 'crm.customer-noted', schemaVersion: 1 },
      { type: 'crm.customer-touched', schemaVersion: 1 },
      // #1705 PR 2: not exported. Its local consumer answers with an exported type, which is
      // how the kick's signal is shown to count a consumer's emit in the invoke's tail.
      { type: 'crm.customer-flagged', schemaVersion: 1 },
    ],
    consumes: [
      { from: BOARD_VERTICAL, type: 'board.association-linked', schemaVersion: 1 },
      { type: 'crm.customer-flagged', schemaVersion: 1 },
    ],
    exports: [
      { type: 'crm.customer-created', schemaVersion: 1, readPermission: 'customer:read' },
      { type: 'crm.customer-touched', schemaVersion: 1, readPermission: 'customer:read' },
    ],
  },
  // #1706's grant, used for both directions of the edge. board holds `customer:read` here,
  // which releases crm's exports to it. It is admitted as a peer when it delivers into crm (the
  // loop's return leg), where its handler checks `customer:write`. It may invoke nothing.
  peers: [{ vertical: BOARD_VERTICAL, operations: [], permissions: ['customer:read', 'customer:write'] }],
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'crm-export',
});

const createInput = z.object({
  name: z.string().min(1),
  pii: z.enum(['none', 'direct']).optional(),
  schemaVersion: z.number().int().positive().optional(),
});

const crmCreate: OperationHandler<z.infer<typeof createInput>, { id: string }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(key('customer:write')));
  const input = createInput.parse(raw);
  const id = ulid();
  ctx.sql.exec('INSERT INTO crm_customers (id, name) VALUES (?, ?)', [id, input.name]);
  const entity = { entityType: 'customer', entityId: id };
  const payload = { id, name: input.name };
  const schemaVersion = input.schemaVersion ?? 1;
  if (input.pii === 'direct') {
    ctx.emit({
      type: 'crm.customer-created',
      schemaVersion,
      entity,
      piiClass: 'direct',
      subjectId: dataSubjectId.parse(id),
      payload,
    });
  } else {
    ctx.emit({ type: 'crm.customer-created', schemaVersion, entity, piiClass: 'none', payload });
  }
  return { id };
};

/** Emits a type crm does NOT export. Asked for by board all the same. */
const crmNote: OperationHandler<{ id: string }, void> = async (ctx, input) => {
  assertAllowed(await ctx.check(key('customer:write')));
  ctx.emit({
    type: 'crm.customer-noted',
    schemaVersion: 1,
    entity: { entityType: 'customer', entityId: input.id },
    piiClass: 'none',
    payload: { id: input.id },
  });
};

/** Starts the ping-pong. */
const crmTouch: OperationHandler<{ id: string }, void> = async (ctx, input) => {
  assertAllowed(await ctx.check(key('customer:write')));
  ctx.emit({
    type: 'crm.customer-touched',
    schemaVersion: 1,
    entity: { entityType: 'customer', entityId: input.id },
    piiClass: 'none',
    payload: { id: input.id },
  });
};

/** Emits an exported type, then throws: the kick's signal must not survive the rollback. */
const crmCreateThenFail: OperationHandler<{ name: string }, void> = async (ctx, input) => {
  assertAllowed(await ctx.check(key('customer:write')));
  const id = ulid();
  ctx.emit({
    type: 'crm.customer-created',
    schemaVersion: 1,
    entity: { entityType: 'customer', entityId: id },
    piiClass: 'none',
    payload: { id, name: input.name },
  });
  throw new Error('crm/create-then-fail fails after emitting, by design');
};

/** Emits a type crm does NOT export; its local consumer answers with one it does. */
const crmFlag: OperationHandler<{ id: string }, void> = async (ctx, input) => {
  assertAllowed(await ctx.check(key('customer:write')));
  ctx.emit({
    type: 'crm.customer-flagged',
    schemaVersion: 1,
    entity: { entityType: 'customer', entityId: input.id },
    piiClass: 'none',
    payload: { id: input.id },
  });
};

export const crmExportMod: ModuleRegistration = {
  manifest: crmExportModManifest,
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE crm_customers (id TEXT PRIMARY KEY, name TEXT NOT NULL)' }],
  operations: {
    'crm/create': crmCreate as OperationHandler<never, unknown>,
    'crm/note': crmNote as OperationHandler<never, unknown>,
    'crm/touch': crmTouch as OperationHandler<never, unknown>,
    'crm/create-then-fail': crmCreateThenFail as OperationHandler<never, unknown>,
    'crm/flag': crmFlag as OperationHandler<never, unknown>,
  },
  consumers: {
    // In the invoke's post-commit tail: an exported type committed by a consumer, not the operation.
    'crm.customer-flagged': async (ctx, event) => {
      const { id } = z.object({ id: z.string() }).parse(event.payload);
      ctx.emit({
        type: 'crm.customer-created',
        schemaVersion: 1,
        entity: { entityType: 'customer', entityId: id },
        piiClass: 'none',
        payload: { id, name: 'Flagged' },
      });
    },
  },
  imports: {
    [BOARD_VERTICAL]: {
      // The loop's other half: every link board announces is answered with a touch.
      'board.association-linked': async (ctx, event) => {
        assertAllowed(await ctx.check(key('customer:write')));
        const { crmId } = z.object({ crmId: z.string() }).parse(event.payload);
        ctx.emit({
          type: 'crm.customer-touched',
          schemaVersion: 1,
          entity: { entityType: 'customer', entityId: crmId },
          piiClass: 'none',
          payload: { id: crmId },
        });
      },
    },
  },
};

export const boardImportModManifest = moduleManifest.parse({
  id: '@test/board-import',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'association:read', description: 'read associations' },
    { key: 'association:sync', description: 'keep associations in step with the CRM' },
  ],
  events: {
    emits: [
      { type: 'board.association-created', schemaVersion: 1 },
      { type: 'board.association-linked', schemaVersion: 1 },
    ],
    consumes: [
      { from: CRM_VERTICAL, type: 'crm.customer-created', schemaVersion: 1 },
      // crm emits this and does not export it. Declaring it must not be enough to receive it.
      { from: CRM_VERTICAL, type: 'crm.customer-noted', schemaVersion: 1 },
      { from: CRM_VERTICAL, type: 'crm.customer-touched', schemaVersion: 1 },
    ],
    exports: [{ type: 'board.association-linked', schemaVersion: 1, readPermission: 'association:read' }],
  },
  // crm is admitted to deliver here, and its handlers' checks run against `association:sync`.
  // `association:read` releases board's own export back to crm.
  peers: [{ vertical: CRM_VERTICAL, operations: [], permissions: ['association:sync', 'association:read'] }],
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'board-import',
});

const customerCreated = z.object({ id: z.string(), name: z.string() });

/** Everything the suite reads back from a board scope, through ordinary module reads. */
interface BoardView {
  associations: { crm_id: string; name: string }[];
  noted: number;
  imports: { event_id: string; source_vertical: string; source_scope_id: string; type: string; hops: number; withheld: string | null }[];
  deliveries: { event_id: string; consumer_module: string; error: string | null }[];
  outbox: { id: string; type: string; caused_by: string | null; actor: string }[];
  /** #1705 PR 3: what a replay moved aside, never deleted. */
  replays: { replay_id: string; kind: string; event_id: string; consumer_module: string }[];
}

const boardRead: OperationHandler<undefined, BoardView> = async (ctx) => {
  assertAllowed(await ctx.check(key('association:read')));
  return {
    associations: ctx.sql.query('SELECT crm_id, name FROM board_associations ORDER BY rowid'),
    noted: (ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM board_noted')[0]?.n ?? 0),
    // Module code may READ the spine (rule 3); these reads are what an operator's view is.
    imports: ctx.sql.query(
      'SELECT event_id, source_vertical, source_scope_id, type, hops, withheld FROM _substrat_imports ORDER BY event_id',
    ),
    deliveries: ctx.sql.query(
      'SELECT event_id, consumer_module, error FROM _substrat_deliveries ORDER BY event_id, consumer_module',
    ),
    outbox: ctx.sql.query('SELECT id, type, caused_by, actor FROM _substrat_outbox ORDER BY id'),
    replays: ctx.sql.query(
      'SELECT replay_id, kind, event_id, consumer_module FROM _substrat_import_replays ORDER BY kind, event_id',
    ),
  };
};

export const boardImportMod: ModuleRegistration = {
  manifest: boardImportModManifest,
  migrations: [
    {
      version: '0001-init',
      sql: `
        CREATE TABLE board_associations (crm_id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE board_noted (event_id TEXT PRIMARY KEY);
      `,
    },
  ],
  operations: { 'board/read': boardRead as OperationHandler<never, unknown> },
  imports: {
    [CRM_VERTICAL]: {
      'crm.customer-created': async (ctx, event) => {
        assertAllowed(await ctx.check(key('association:sync')));
        const c = customerCreated.parse(event.payload);
        if (c.name === 'poison') throw new Error('board refuses the poison customer');
        ctx.sql.exec(
          `INSERT INTO board_associations (crm_id, name) VALUES (?, ?)
           ON CONFLICT (crm_id) DO UPDATE SET name = excluded.name`,
          [c.id, c.name],
        );
        ctx.emit({
          type: 'board.association-created',
          schemaVersion: 1,
          entity: { entityType: 'association', entityId: c.id },
          piiClass: 'none',
          payload: { crmId: c.id },
        });
      },
      'crm.customer-noted': async (ctx, event) => {
        // Never runs: crm does not export the type. Recorded if it ever does.
        ctx.sql.exec('INSERT INTO board_noted (event_id) VALUES (?)', [event.id]);
      },
      'crm.customer-touched': async (ctx, event) => {
        assertAllowed(await ctx.check(key('association:sync')));
        const { id } = z.object({ id: z.string() }).parse(event.payload);
        ctx.emit({
          type: 'board.association-linked',
          schemaVersion: 1,
          entity: { entityType: 'association', entityId: id },
          piiClass: 'none',
          payload: { crmId: id },
        });
      },
    },
  },
};

// -- the suite ------------------------------------------------------------------

/**
 * Two deployments over ONE directory: `producer` registers `crmExportMod` and serves every
 * scope provisioned as `acme/crm`, `consumer` registers `boardImportMod` and serves every
 * `acme/board` scope. That is the hosted shape (a vertical is its own deployment) without the
 * `/internal` hop, which is the hosted transport's to prove.
 */
export interface VerticalEventsFixture {
  producer: ScopeHost;
  consumer: ScopeHost;
  cleanup: () => Promise<void>;
  /**
   * How the phase reaches the two scopes of an edge (#1705 PR 2). Absent, each scope is
   * reached through the host serving it, in process. The hosted fixture passes the control
   * plane's own reach instead, over each deployment's `/internal` surface, so every claim
   * below is also held across the wire. The suite keeps its own `candidates`, which scope
   * each test's passes to the tenants it created.
   */
  transport?: Omit<CrossVerticalReach, 'candidates'>;
  /**
   * Called once a scope is installed through the directory (#1705 PR 2): the half of a hosted
   * install the vertical's own deployment does (`/internal/provision`). Absent, installing
   * through the directory is the whole install.
   */
  afterInstall?: (tenantId: TenantId, scopeId: ScopeId, vertical: string) => Promise<void>;
  /**
   * How the replay lever is pulled (#1705 PR 3). Absent, through the consumer host's own
   * `admin.moveImportCursor`. The hosted fixture pulls it on a control-plane host whose
   * delegation crosses the consumer deployment's `/internal/import-cursor`.
   */
  lever?: (tenantId: TenantId, scopeId: ScopeId, move: ImportCursorMove) => Promise<ImportCursorMoved>;
  /**
   * How edge health reads the consumer's door (#1705 PR 3). Absent, the health read's default
   * (`admin.peerGrantsStatus` on the consumer host).
   */
  door?: (
    tenantId: TenantId,
    scopeId: ScopeId,
  ) => Promise<readonly { vertical: string; calls: string; switchedOff?: { reason: string } | null }[]>;
}

const noFetch: FetchLike = async () => new Response('unused', { status: 200 });

/**
 * Cross-vertical event delivery (#1705), against a real pair of deployments. Every claim the
 * design rests on is here with its positive twin:
 *
 * - same-tenant only: a consumer receives its own tenant's producer, never another's;
 * - not exported, not delivered, whatever the consumer declares;
 * - only `piiClass: 'none'` crosses, and a classified instance is named but never carried;
 * - at-least-once across the edge, one effect per (event, module): a redelivered batch runs
 *   nothing twice, and a handler that throws does not stop the events behind it;
 * - the watermark belongs to the consumer and moves only forward, under a compare-and-set;
 * - backfill: a consumer installed after the producer receives the history;
 * - `caused_by` crosses the edge and resolves to its source;
 * - a P ↔ C loop is cut at the hop cap;
 * - a fork is neither read nor fed, and two primary installs are refused, not guessed.
 */
export function verticalEventsContractSuite(
  adapterName: string,
  makeFixture: () => Promise<VerticalEventsFixture>,
): void {
  // A sweep pass is real work on workerd (every active scope in the directory is looked at),
  // and a slow CI runner is several times slower than a laptop, so the suite gets room.
  describe(`cross-vertical events (#1705): ${adapterName}`, { timeout: 30_000 }, () => {
    let fx: VerticalEventsFixture;
    const staff = platformActorId.parse(ulid());
    const writer: PrincipalId = principalId.parse(ulid());
    const reader: PrincipalId = principalId.parse(ulid());

    beforeAll(async () => {
      fx = await makeFixture();
    });
    afterAll(async () => {
      await fx.cleanup();
    });

    const hostFor = (vertical: string): ScopeHost => (vertical === CRM_VERTICAL ? fx.producer : fx.consumer);
    const hostOf = async (t: TenantId, s: ScopeId): Promise<ScopeHost> => {
      const rec = await fx.consumer.admin.getScopeRecord(staff, t, s);
      return hostFor(rec?.vertical ?? '');
    };
    // The reach a deployment-per-vertical platform has: each scope reached through the
    // deployment serving it, resolved from the directory. The control plane does the same
    // over `/internal`.
    //
    // Scoped to the tenants THIS test created. The directory is shared, so without this a
    // test's passes would also move every earlier test's edges. Worse, a test that timed out
    // keeps sweeping in the background (vitest does not cancel it), and would deliver the next
    // test's events before that test's own pass could.
    // The scoping is the phase's own narrowing hook (`candidates`), the one the control plane
    // fills from the registry, so the suite also proves that a scope it drops is never called.
    const current = new Set<string>();
    beforeEach(() => current.clear());
    const inProcess: Omit<CrossVerticalReach, 'candidates'> = {
      importState: async (t, s) => (await hostOf(t, s)).admin.importState(staff, t, s),
      readExports: async (t, s, input) => (await hostOf(t, s)).admin.readExportedEvents(staff, t, s, input),
      deliver: async (t, s, batch) => (await hostOf(t, s)).deliverToPeer(t, s, batch),
    };
    // Resolved per call, because the fixture is built in `beforeAll`.
    const reach: CrossVerticalReach = {
      candidates: (scopes) => scopes.filter((s) => current.has(s.tenantId)),
      importState: (t, s) => (fx.transport ?? inProcess).importState(t, s),
      readExports: (t, s, input) => (fx.transport ?? inProcess).readExports(t, s, input),
      deliver: (t, s, batch) => (fx.transport ?? inProcess).deliver(t, s, batch),
    };

    const newTenant = async (): Promise<TenantId> => {
      const t = tenantId.parse(ulid());
      await fx.producer.admin.createTenant(staff, { id: t, slug: `ve-${t.toLowerCase()}`, name: 'Vertical events' });
      await fx.producer.admin.grantEntitlement(staff, t, 'crm-export');
      await fx.producer.admin.grantEntitlement(staff, t, 'board-import');
      current.add(t);
      return t;
    };
    const install = async (t: TenantId, vertical: string): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      const host = hostFor(vertical);
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
      await host.admin.activateScope(staff, t, s);
      const perms = vertical === CRM_VERTICAL ? ['customer:write'] : ['association:read'];
      for (const p of perms) {
        await host.admin.grant(staff, {
          principalId: vertical === CRM_VERTICAL ? writer : reader,
          permission: key(p),
          node: { tenantId: t, scopeId: s },
          grantedBy: writer,
        });
      }
      await fx.afterInstall?.(t, s, vertical);
      return s;
    };
    const crm = async (t: TenantId, s: ScopeId, op: string, input: unknown): Promise<unknown> =>
      (await fx.producer.getScope(writer, t, s)).invoke(op, input);
    const create = async (t: TenantId, s: ScopeId, name: string, extra: object = {}): Promise<string> =>
      ((await crm(t, s, 'crm/create', { name, ...extra })) as { id: string }).id;
    const board = async (t: TenantId, s: ScopeId): Promise<BoardView> =>
      (await (await fx.consumer.getScope(reader, t, s)).invoke('board/read', undefined)) as BoardView;

    const sweep = async (): Promise<{ report: PlatformSweepReport; runs: SweepRunInput[] }> => {
      const runs: SweepRunInput[] = [];
      const report = await runPlatformSweep(fx.consumer, {
        actor: staff,
        fetch: noFetch,
        sweepers: {},
        // Only this phase: the others would open scopes through whichever host the sweep
        // was handed, which in a two-deployment world is the wrong one for half of them.
        drainRetries: false,
        gcSnapshots: false,
        reconcileMigrations: false,
        runSchedules: false,
        recordSweepRun: (e) => runs.push(e),
        crossVertical: { reach },
      });
      return { report, runs };
    };
    const lever = (t: TenantId, s: ScopeId, move: ImportCursorMove): Promise<ImportCursorMoved> =>
      fx.lever ? fx.lever(t, s, move) : fx.consumer.admin.moveImportCursor(staff, t, s, move);
    const replay = (after: string | null): ImportCursorMove => ({
      mode: 'replay',
      from: CRM_VERTICAL,
      after: after === null ? null : eventId.parse(after),
      acknowledge: 'rerun-handlers',
      reason: 'the board app lost a day of associations',
    });
    const skip = (through: string): ImportCursorMove => ({
      mode: 'skip',
      from: CRM_VERTICAL,
      through: through === 'now' ? 'now' : eventId.parse(through),
      acknowledge: 'skip-events',
      reason: 'the board app starts from today',
    });
    const refusal = (x: Promise<unknown>): Promise<unknown> => x.then(() => undefined, (e: unknown) => e);
    /**
     * Let the clock pass the millisecond an event was minted in. "Skip to now" passes over earlier
     * milliseconds only, so a test that needs an event skipped must not share the skip's. A timer,
     * not a spin: on workerd the clock does not move without I/O.
     */
    const nextMillisecond = () => new Promise<void>((r) => setTimeout(r, 2));
    const edgesOf = (report: PlatformSweepReport, t: TenantId) =>
      (report.crossVertical?.edges ?? []).filter((e) => e.tenantId === t);
    /** The edge INTO one consumer scope. crm imports from board too, so a tenant has two. */
    const into = (report: PlatformSweepReport, consumer: ScopeId) =>
      (report.crossVertical?.edges ?? []).find((e) => e.consumer.scopeId === consumer);

    it('delivers an exported event to the same tenant\'s consumer, in order, and moves the consumer\'s watermark', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      const a = await create(t, p, 'Alpha');
      const b = await create(t, p, 'Beta');

      const { report } = await sweep();
      expect(into(report, c)).toMatchObject({
        state: 'delivered',
        delivered: 2,
        producer: { vertical: CRM_VERTICAL, scopeId: p },
      });
      expect((await board(t, c)).associations).toEqual([
        { crm_id: a, name: 'Alpha' },
        { crm_id: b, name: 'Beta' },
      ]);
      const state = await fx.consumer.admin.importState(staff, t, c);
      expect(state.cursors).toEqual([expect.objectContaining({ source: p, vertical: CRM_VERTICAL })]);

      // Caught up: the next pass is idle and moves nothing.
      const again = edgesOf((await sweep()).report, t);
      expect(again.length).toBeGreaterThan(0);
      expect(again.every((e) => e.state === 'idle' && e.delivered === 0)).toBe(true);
      expect((await board(t, c)).associations).toHaveLength(2);
    });

    it('the stub reports a committed exported type, and nothing else — the router kick\'s signal (#1705 PR 2)', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      await install(t, BOARD_VERTICAL);
      const seen: number[] = [];
      const stub = await fx.producer.getScope(writer, t, p, { onExportedEvents: (n) => seen.push(n) });
      const id = ((await stub.invoke('crm/create', { name: 'Kicked' })) as { id: string }).id;
      expect(seen).toEqual([1]);
      // A type crm emits but does not export is no reason to run its edges.
      await stub.invoke('crm/note', { id });
      expect(seen).toEqual([1]);
      // Nor is an invoke that committed nothing: refused before it could emit.
      const refused = await fx.producer.getScope(reader, t, p, { onExportedEvents: (n) => seen.push(n) });
      await expect(refused.invoke('crm/create', { name: 'Refused' })).rejects.toThrow();
      expect(seen).toEqual([1]);
      // Each exported type counts, whichever operation committed it.
      await stub.invoke('crm/touch', { id });
      expect(seen).toEqual([1, 1]);
    });

    it('the kick\'s signal: never for a rolled-back invoke or a read-only session, and a consumer\'s tail counts (#1705 PR 2)', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const seen: number[] = [];
      const stub = await fx.producer.getScope(writer, t, p, { onExportedEvents: (n) => seen.push(n) });
      // Emitted an exported type, then threw: the event rolled back, so there is nothing to kick.
      await expect(stub.invoke('crm/create-then-fail', { name: 'Gone' })).rejects.toThrow(/by design/);
      expect(seen).toEqual([]);
      // The operation emits an unexported type; its local consumer, in the tail, an exported one.
      await stub.invoke('crm/flag', { id: ulid() });
      expect(seen).toEqual([1]);
      // A read-only support session commits nothing, whatever the operation emits.
      const readOnly = await fx.producer.admin.beginImpersonation(staff, {
        tenantId: t,
        scopeId: p,
        principal: writer,
        reason: 'ticket #1705 — checking the kick signal',
        mode: 'read-only',
      });
      // The kernel refuses its emit outright (K-42), so the invoke fails and nothing is raised.
      const ro = await fx.producer.getImpersonatedScope(readOnly.id, t, p, { onExportedEvents: (n) => seen.push(n) });
      await expect(ro.invoke('crm/create', { name: 'Looked at' })).rejects.toThrow(/read-only/);
      expect(seen).toEqual([1]);
      // The twin: a WRITE session that commits the same operation does raise it.
      const write = await fx.producer.admin.beginImpersonation(staff, {
        tenantId: t,
        scopeId: p,
        principal: writer,
        reason: 'ticket #1705 — the write twin',
        mode: 'write',
      });
      const rw = await fx.producer.getImpersonatedScope(write.id, t, p, { onExportedEvents: (n) => seen.push(n) });
      await rw.invoke('crm/create', { name: 'Written' });
      expect(seen).toEqual([1, 1]);
    });

    it('never crosses a tenant: each consumer receives its own tenant\'s producer, and none from another', async () => {
      const t = await newTenant();
      const u = await newTenant();
      const v = await newTenant();
      const pt = await install(t, CRM_VERTICAL);
      const ct = await install(t, BOARD_VERTICAL);
      const pu = await install(u, CRM_VERTICAL);
      const cu = await install(u, BOARD_VERTICAL);
      const cv = await install(v, BOARD_VERTICAL); // a board with NO crm in its tenant
      await create(t, pt, 'Only-T');
      await create(u, pu, 'Only-U');

      const { report, runs } = await sweep();
      expect((await board(t, ct)).associations.map((r) => r.name)).toEqual(['Only-T']);
      expect((await board(u, cu)).associations.map((r) => r.name)).toEqual(['Only-U']);
      // The tenant with no producer receives nothing, and the edge says why.
      expect((await board(v, cv)).associations).toEqual([]);
      expect(into(report, cv)).toMatchObject({
        state: 'unresolved',
        reason: `'${CRM_VERTICAL}' is not installed in this tenant`,
      });
      // ...durably, where a person reads it.
      expect(runs).toContainEqual(
        expect.objectContaining({
          kind: 'vertical-events',
          unit: `${cv}:${CRM_VERTICAL}`,
          outcome: 'skipped',
          error: `'${CRM_VERTICAL}' is not installed in this tenant`,
        }),
      );
    });

    it('an event its producer does not export is never delivered, however it is asked for', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      const id = await create(t, p, 'Exported');
      await crm(t, p, 'crm/note', { id });

      const { report } = await sweep();
      const view = await board(t, c);
      expect(view.associations.map((r) => r.name)).toEqual(['Exported']); // positive twin
      expect(view.noted).toBe(0);
      expect(view.imports.map((i) => i.type)).toEqual(['crm.customer-created']);
      expect(into(report, c)?.unexported).toEqual([{ type: 'crm.customer-noted', schemaVersion: 1 }]);

      // Asked for directly, with nothing else: the producer's own code refuses it.
      const direct = await fx.producer.admin.readExportedEvents(staff, t, p, {
        consumer: BOARD_VERTICAL,
        after: null,
        wants: [{ type: 'crm.customer-noted', schemaVersion: 1 }],
        limit: 100,
      });
      expect(direct).toMatchObject({ events: [], withheld: [], unexported: [{ type: 'crm.customer-noted', schemaVersion: 1 }] });
    });

    it('only piiClass none crosses: a classified instance is withheld, named at the consumer, never carried', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      const person = await create(t, p, 'A Person', { pii: 'direct' });
      const org = await create(t, p, 'An Association'); // positive twin

      const { report } = await sweep();
      const view = await board(t, c);
      expect(view.associations).toEqual([{ crm_id: org, name: 'An Association' }]);
      expect(into(report, c)).toMatchObject({ state: 'delivered', delivered: 1, withheld: 1 });
      const withheld = view.imports.find((i) => i.withheld !== null);
      expect(withheld).toMatchObject({ type: 'crm.customer-created', withheld: 'pii' });
      // The dead letter says what happened and carries nothing of the person.
      const dead = view.deliveries.find((d) => d.event_id === withheld!.event_id);
      expect(dead?.error).toMatch(/withheld by 'acme\/crm'.*personal data/);
      expect(dead?.error).not.toContain('A Person');
      expect(JSON.stringify(view)).not.toContain('A Person');
      expect(person).toBeTruthy();

      // The operator's dead-letter read shows the withheld import beside local ones.
      const letters = await fx.consumer.admin.deadLetters(staff, t, c, {});
      expect(letters.entries).toContainEqual(
        expect.objectContaining({ eventId: withheld!.event_id, eventType: 'crm.customer-created' }),
      );
    });

    it('a version other than the one declared is withheld, never handed to a handler (K-39)', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Version two', { schemaVersion: 2 });
      await create(t, p, 'Version one'); // positive twin

      await sweep();
      const view = await board(t, c);
      expect(view.associations.map((r) => r.name)).toEqual(['Version one']);
      expect(view.imports.filter((i) => i.withheld === 'version')).toHaveLength(1);
    });

    it('a handler that throws is dead-lettered, and the events behind it still arrive', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      const poison = await create(t, p, 'poison');
      await create(t, p, 'After the poison');

      const { report } = await sweep();
      expect(into(report, c)).toMatchObject({ state: 'delivered', delivered: 1, deadLettered: 1 });
      const view = await board(t, c);
      expect(view.associations.map((r) => r.name)).toEqual(['After the poison']);
      const refused = view.imports.find((i) => i.type === 'crm.customer-created' && i.withheld === null && view.deliveries.some((d) => d.event_id === i.event_id && d.error?.includes('poison')));
      expect(refused).toBeTruthy();
      expect(poison).toBeTruthy();
    });

    it('at-least-once across the edge: a batch delivered twice runs each handler once', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Once');
      const read = await fx.producer.admin.readExportedEvents(staff, t, p, {
        consumer: BOARD_VERTICAL,
        after: null,
        wants: [{ type: 'crm.customer-created', schemaVersion: 1 }],
        limit: 100,
      });
      const batch: ImportBatch = {
        source: { vertical: CRM_VERTICAL, scopeId: p },
        after: null,
        next: read.next!,
        events: read.events,
        withheld: read.withheld,
      };
      const first = await fx.consumer.deliverToPeer(t, c, batch);
      expect(first).toMatchObject({ delivered: 1, duplicates: 0, stale: false, cursor: read.next });

      // The same batch again, from where the watermark now stands: every event is already
      // journaled, so nothing runs a second time.
      const second = await fx.consumer.deliverToPeer(t, c, { ...batch, after: read.next });
      expect(second).toMatchObject({ delivered: 0, duplicates: 1, stale: false });
      const view = await board(t, c);
      expect(view.associations).toHaveLength(1);
      expect(view.outbox.filter((o) => o.type === 'board.association-created')).toHaveLength(1);

      // A pass that read from a stale watermark is refused whole, and moves nothing backwards.
      const stale = await fx.consumer.deliverToPeer(t, c, batch);
      expect(stale).toMatchObject({ stale: true, delivered: 0, cursor: read.next });
    });

    it('backfill: a consumer installed after the producer receives the exported history', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const early = [await create(t, p, 'Early 1'), await create(t, p, 'Early 2'), await create(t, p, 'Early 3')];
      const c = await install(t, BOARD_VERTICAL);

      await sweep();
      expect((await board(t, c)).associations.map((r) => r.crm_id)).toEqual(early);
    });

    it('causedBy crosses the edge: what the handler emits names the producer\'s event, which resolves to its source', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Caused');

      await sweep();
      const view = await board(t, c);
      const imported = view.imports.find((i) => i.withheld === null)!;
      const reaction = view.outbox.find((o) => o.type === 'board.association-created')!;
      expect(reaction.caused_by).toBe(imported.event_id);
      // The producer acted here, through the door, as itself (#1706's actor) — not as a person,
      // and not as this module's own system principal.
      expect(JSON.parse(reaction.actor)).toEqual({ vertical: CRM_VERTICAL, scope: p });
      expect(imported).toMatchObject({ source_vertical: CRM_VERTICAL, source_scope_id: p, hops: 1 });
      // The walk says where the trail went, rather than calling the record broken.
      const chain = await fx.consumer.admin.eventCause(staff, t, c, { eventId: eventId.parse(reaction.id) });
      expect(chain).toMatchObject({
        terminal: 'imported',
        imported: { eventId: imported.event_id, vertical: CRM_VERTICAL, scopeId: p },
      });
    });

    it('a ping-pong between two verticals is cut at the hop cap, and the cut is visible', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      const id = await create(t, p, 'Looped');
      await crm(t, p, 'crm/touch', { id });

      let quiet = false;
      for (let pass = 0; pass < 20 && !quiet; pass++) {
        const edges = edgesOf((await sweep()).report, t);
        quiet = edges.every((e) => e.state === 'idle');
      }
      expect(quiet).toBe(true); // it stopped
      // A touch crosses crm → board on the odd hops, a link board → crm on the even ones, so
      // the ninth crossing, the first past the cap of 8, is a touch arriving at board.
      const view = await board(t, c);
      const touches = view.imports.filter((i) => i.type === 'crm.customer-touched');
      expect(touches.filter((i) => i.withheld === null).map((i) => i.hops)).toEqual([1, 3, 5, 7]);
      expect(touches.filter((i) => i.withheld === 'cascade')).toHaveLength(1);
      // Cut where the operator of the receiving app will see it.
      const letters = await fx.consumer.admin.deadLetters(staff, t, c, {});
      expect(letters.entries.some((l) => l.error.includes('vertical boundaries'))).toBe(true);
    });

    it('a peer switched off on the PRODUCER pauses the edge, and nothing is lost when it is switched back on', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      const reason = 'incident: pause exports to the board app';
      await fx.producer.admin.revokeFromPeer(staff, { vertical: BOARD_VERTICAL, node: { tenantId: t, scopeId: p }, reason });
      const during = await create(t, p, 'While paused');

      const paused = await sweep();
      expect(into(paused.report, c)).toMatchObject({
        state: 'paused',
        reason: expect.stringContaining(`does not grant vertical:${BOARD_VERTICAL} customer:read`),
      });
      expect((await board(t, c)).associations).toEqual([]);
      // Nothing was read, so the watermark did not move past what arrived while paused.
      expect((await fx.consumer.admin.importState(staff, t, c)).cursors).toEqual([]);
      // Visible where a person reads it, not only in a report nobody keeps.
      expect(paused.runs).toContainEqual(
        expect.objectContaining({ kind: 'vertical-events', unit: `${c}:${CRM_VERTICAL}`, outcome: 'skipped' }),
      );

      await fx.producer.admin.restoreToPeer(staff, {
        vertical: BOARD_VERTICAL,
        node: { tenantId: t, scopeId: p },
        reason: 'resolved',
      });
      const after = await create(t, p, 'After restore');
      expect(into((await sweep()).report, c)).toMatchObject({ state: 'delivered', delivered: 2 });
      expect((await board(t, c)).associations.map((r) => r.crm_id)).toEqual([during, after]);
    });

    it('a peer switched off on the CONSUMER is refused at its door, and nothing is lost when it is switched back on', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await fx.consumer.admin.revokeFromPeer(staff, {
        vertical: CRM_VERTICAL,
        node: { tenantId: t, scopeId: c },
        reason: 'the board app stops taking CRM changes for now',
      });
      const during = await create(t, p, 'While refused');

      const refused = await sweep();
      expect(into(refused.report, c)).toMatchObject({
        state: 'paused',
        reason: expect.stringContaining(`consumer '${BOARD_VERTICAL}' refused '${CRM_VERTICAL}'`),
      });
      const view = await board(t, c);
      expect(view.associations).toEqual([]);
      expect(view.imports).toEqual([]); // not even journaled: the door refused before anything ran

      await fx.consumer.admin.restoreToPeer(staff, {
        vertical: CRM_VERTICAL,
        node: { tenantId: t, scopeId: c },
        reason: 'resolved',
      });
      await sweep();
      expect((await board(t, c)).associations.map((r) => r.crm_id)).toEqual([during]);
    });

    // -- the replay lever (#1705 PR 3) ---------------------------------------------------------

    it('replay from the start: every handler runs again, and the first delivery\'s record is moved aside, not deleted', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Alpha');
      await create(t, p, 'Beta');
      await sweep();
      const before = await board(t, c);
      const created = (v: BoardView) => v.outbox.filter((o) => o.type === 'board.association-created');
      expect(created(before)).toHaveLength(2);

      const moved = await lever(t, c, replay(null));
      expect(moved).toMatchObject({ mode: 'replay', cursor: null, source: { vertical: CRM_VERTICAL, scopeId: p } });
      expect(moved.previous).not.toBeNull();
      expect(moved.archived).toEqual({ journal: 2, deliveries: 2 });
      // The evidence of the first delivery stays, under the act that moved it.
      const aside = await board(t, c);
      expect(aside.replays.filter((r) => r.kind === 'journal').map((r) => r.event_id)).toEqual(
        before.imports.map((i) => i.event_id),
      );
      expect(aside.replays.filter((r) => r.kind === 'delivery')).toHaveLength(2);
      expect(new Set(aside.replays.map((r) => r.replay_id))).toEqual(new Set([moved.replayId]));
      // ...and it has left the LIVE journal, so the redelivery journals each event afresh: an event
      // first withheld for its version is decided again rather than kept as withheld forever.
      expect(aside.imports).toEqual([]);
      expect(aside.deliveries).toEqual([]);
      // The admin log names the act, its reason and what it moved.
      const log = await fx.consumer.admin.auditLog(staff, { tenantId: t, action: ['moveImportCursor'] });
      expect(log.map((e) => (e.after as { phase?: string }).phase).sort()).toEqual(['applied', 'intent']);
      expect(log.every((e) => (e.after as { replayId?: string }).replayId === moved.replayId)).toBe(true);

      // The next pass delivers both again, and each handler RUNS again: that is what a replay is.
      const { report } = await sweep();
      expect(into(report, c)).toMatchObject({ state: 'delivered', delivered: 2, duplicates: 0 });
      const after = await board(t, c);
      expect(created(after)).toHaveLength(4);
      expect(after.associations.map((r) => r.name)).toEqual(['Alpha', 'Beta']);
      expect(after.imports.map((i) => i.event_id)).toEqual(before.imports.map((i) => i.event_id));
    });

    it('replay from a point: only the events after it run again', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Kept');
      await create(t, p, 'Replayed');
      await sweep();
      const [first, second] = (await board(t, c)).imports;

      const moved = await lever(t, c, replay(first!.event_id));
      expect(moved).toMatchObject({ cursor: first!.event_id, archived: { journal: 1, deliveries: 1 } });
      await sweep();
      const view = await board(t, c);
      // The positive twin of the whole-history replay: the first event's handler did not run again.
      const createdFor = (id: string) =>
        view.outbox.filter((o) => o.type === 'board.association-created' && o.caused_by === id).length;
      expect(createdFor(first!.event_id)).toBe(1);
      expect(createdFor(second!.event_id)).toBe(2);
    });

    it('skip to now: nothing before the skip is delivered, what comes after is, and a replay reaches back', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Before the skip');
      await nextMillisecond();
      const moved = await lever(t, c, skip('now'));
      expect(moved).toMatchObject({ mode: 'skip', previous: null, archived: { journal: 0, deliveries: 0 } });
      expect(moved.cursor).not.toBeNull();

      await sweep();
      expect((await board(t, c)).associations).toEqual([]);
      await create(t, p, 'After the skip');
      await sweep();
      expect((await board(t, c)).associations.map((r) => r.name)).toEqual(['After the skip']);

      // Recoverable: the producer's outbox kept what was skipped.
      await lever(t, c, replay(null));
      await sweep();
      expect((await board(t, c)).associations.map((r) => r.name).sort()).toEqual(['After the skip', 'Before the skip']);
    });

    it('a pass that read before a move is refused by the watermark\'s compare-and-set, and cannot undo it', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Read before the skip');
      await nextMillisecond();
      const read = await fx.producer.admin.readExportedEvents(staff, t, p, {
        consumer: BOARD_VERTICAL,
        after: null,
        wants: [{ type: 'crm.customer-created', schemaVersion: 1 }],
        limit: 100,
      });
      const moved = await lever(t, c, skip('now'));
      const late = await fx.consumer.deliverToPeer(t, c, {
        source: { vertical: CRM_VERTICAL, scopeId: p },
        after: null,
        next: read.next!,
        events: read.events,
        withheld: read.withheld,
      });
      expect(late).toMatchObject({ stale: true, delivered: 0, cursor: moved.cursor });
      expect((await board(t, c)).associations).toEqual([]);
    });

    it('the lever holds each mode to its direction, and a replay needs something to replay', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      // Nothing taken yet: there is nothing to run again.
      expect(String(await refusal(lever(t, c, replay(null))))).toMatch(/nothing to replay/);
      await create(t, p, 'One');
      await create(t, p, 'Two');
      await sweep();
      const [first, second] = (await board(t, c)).imports;
      // A skip behind the watermark is a replay, and a replay ahead of it is a skip.
      expect(String(await refusal(lever(t, c, skip(first!.event_id))))).toMatch(/skip moves the watermark forward/);
      expect(String(await refusal(lever(t, c, replay(ulid()))))).toMatch(/replay moves the watermark back/);
      // Neither refusal moved anything: the next pass is idle.
      expect(into((await sweep()).report, c)).toMatchObject({ state: 'idle' });
      // The positive twins, each in its own direction.
      await expect(lever(t, c, replay(first!.event_id))).resolves.toMatchObject({ cursor: first!.event_id });
      await expect(lever(t, c, skip(second!.event_id))).resolves.toMatchObject({ cursor: second!.event_id });
    });

    it('a skip cannot be aimed past now: the future is refused, and the edge still reads behind', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Waiting');
      // The greatest ULID there is: a watermark past every event ever to be written.
      expect(String(await refusal(lever(t, c, skip('7ZZZZZZZZZZZZZZZZZZZZZZZZZ'))))).toMatch(/at most now.*future/);
      expect((await fx.consumer.admin.importState(staff, t, c)).cursors).toEqual([]);
      expect(await healthOf(t, c)).toMatchObject({ state: 'behind' });
      // The twin: to now, it moves, and an event written after it still arrives.
      await nextMillisecond();
      await lever(t, c, skip('now'));
      await create(t, p, 'After');
      await sweep();
      expect((await board(t, c)).associations.map((r) => r.name)).toEqual(['After']);
    });

    it('skip to now never drops an event of its own millisecond: on the boundary it delivers', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      const moved = await lever(t, c, skip('now'));
      // Whatever is written next, however soon, sorts after the watermark: it cannot have been
      // minted in a millisecond earlier than the skip's.
      await create(t, p, 'Right after');
      await sweep();
      expect((await board(t, c)).associations.map((r) => r.name)).toEqual(['Right after']);
      expect(moved.cursor! < ulid()).toBe(true);
    });

    it('the replay history is part of the scope: a dump carries it, and a restore puts it back or takes it away', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Dumped');
      await sweep();
      const beforeReplay = await fx.consumer.admin.exportScope(staff, t, c);
      const moved = await lever(t, c, replay(null));
      const afterReplay = await fx.consumer.admin.exportScope(staff, t, c);
      const table = afterReplay.tables.find((x) => x.name === '_substrat_import_replays');
      expect(table?.rows.length).toBe(2);
      // Restoring the dump from before the replay takes the history away, as it rewinds the data.
      await fx.consumer.restoreScope(staff, t, c, beforeReplay);
      expect((await board(t, c)).replays).toEqual([]);
      // Restoring the dump from after it puts the history back, under the same act.
      await fx.consumer.restoreScope(staff, t, c, afterReplay);
      const back = (await board(t, c)).replays;
      expect(back).toHaveLength(2);
      expect(new Set(back.map((r) => r.replay_id))).toEqual(new Set([moved.replayId]));
    });

    it('the lever moves only an edge the consumer imports: a skip cannot plant a watermark for one that does not exist', async () => {
      const t = await newTenant();
      await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      // Installed in the tenant, and imported by nobody.
      await install(t, 'acme/ledger');
      const plant = { ...skip('now'), from: 'acme/ledger' } as ImportCursorMove;
      expect(String(await refusal(lever(t, c, plant)))).toMatch(/imports nothing from 'acme\/ledger'/);
      expect((await fx.consumer.admin.importState(staff, t, c)).cursors).toEqual([]);
      // The twin: the edge it does import moves.
      await expect(lever(t, c, skip('now'))).resolves.toMatchObject({ source: { vertical: CRM_VERTICAL } });
    });

    it('a replay without its acknowledgement never reaches the store', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Acknowledged');
      await sweep();
      const { acknowledge: _, ...bare } = replay(null) as ImportCursorMove & { mode: 'replay' };
      await expect(lever(t, c, bare as unknown as ImportCursorMove)).rejects.toThrow();
      const wrong = { ...replay(null), acknowledge: 'skip-events' } as unknown as ImportCursorMove;
      await expect(lever(t, c, wrong)).rejects.toThrow();
      expect((await board(t, c)).replays).toEqual([]);
      // The twin: acknowledged, it moves.
      await expect(lever(t, c, replay(null))).resolves.toMatchObject({ archived: { journal: 1 } });
    });

    it('the lever never crosses a tenant: another tenant\'s scope is not found, and the producer is the consumer\'s own tenant\'s', async () => {
      const t = await newTenant();
      const u = await newTenant();
      const pt = await install(t, CRM_VERTICAL);
      const ct = await install(t, BOARD_VERTICAL);
      const pu = await install(u, CRM_VERTICAL);
      const cu = await install(u, BOARD_VERTICAL);
      await create(t, pt, 'T');
      await create(u, pu, 'U');
      await sweep();
      const cursorOf = async (tt: TenantId, cc: ScopeId) =>
        (await fx.consumer.admin.importState(staff, tt, cc)).cursors.map((x) => [x.source, x.cursor]);
      const uBefore = await cursorOf(u, cu);

      // u's consumer scope named under t: not found, and nothing moved anywhere.
      expect(String(await refusal(lever(t, cu, replay(null))))).toMatch(/unknown scope|not found|conflict/i);
      expect(await cursorOf(u, cu)).toEqual(uBefore);
      // t's replay resolves t's producer, and moves t's edge only.
      const moved = await lever(t, ct, replay(null));
      expect(moved.source.scopeId).toBe(pt);
      expect(await cursorOf(u, cu)).toEqual(uBefore);
      // A tenant with no producer has no edge to move.
      const v = await newTenant();
      const cv = await install(v, BOARD_VERTICAL);
      expect(String(await refusal(lever(v, cv, skip('now'))))).toMatch(/not installed in this tenant/);
    });

    // -- edge health (#1705 PR 3) --------------------------------------------------------------

    const health = (t: TenantId, override: Partial<CrossVerticalReach> = {}) =>
      crossVerticalHealth(fx.consumer, {
        actor: staff,
        tenantId: t,
        crossVertical: { reach: { ...reach, ...override } },
        ...(fx.door ? { door: fx.door } : {}),
      });
    const healthOf = async (t: TenantId, c: ScopeId, override: Partial<CrossVerticalReach> = {}) =>
      (await health(t, override)).edges.find((e) => e.consumer.scopeId === c);

    it('edge health: behind before a pass (with its lag), caught up after, and the pass that delivered', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Waiting');

      const before = await healthOf(t, c);
      expect(before).toMatchObject({
        state: 'behind',
        producer: { vertical: CRM_VERTICAL, scopeId: p },
        watermark: null,
        lastDelivered: null,
      });
      expect(before?.oldestPending).not.toBeNull();
      expect(before?.lagMs).toBeGreaterThanOrEqual(0);
      // The probe delivered nothing: the view is a read.
      expect((await board(t, c)).associations).toEqual([]);

      await sweep();
      const after = await healthOf(t, c);
      expect(after).toMatchObject({ state: 'caught-up', oldestPending: null, lagMs: null, reason: null });
      expect(after?.watermark).not.toBeNull();
      // A door that cannot be read changes nothing about a caught-up edge: its reason stays null.
      const unreadDoor = await crossVerticalHealth(fx.consumer, {
        actor: staff,
        tenantId: t,
        crossVertical: { reach },
        door: async () => {
          throw new Error('door unreadable');
        },
      });
      expect(unreadDoor.edges.find((e) => e.consumer.scopeId === c)).toMatchObject({ state: 'caught-up', reason: null });
      // What the consumer asks for and the producer does not export, reported beside the state.
      // (The sweep-run history is covered where the rows are durable: the control plane's route.)
      expect(after?.unexported).toEqual([{ type: 'crm.customer-noted', schemaVersion: 1 }]);
    });

    it('edge health: paused by the producer, and paused at the consumer\'s door, each saying why', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Held');
      await fx.producer.admin.revokeFromPeer(staff, { vertical: BOARD_VERTICAL, node: { tenantId: t, scopeId: p }, reason: 'stop exports' });
      expect(await healthOf(t, c)).toMatchObject({
        state: 'paused',
        reason: expect.stringContaining(`does not grant vertical:${BOARD_VERTICAL} customer:read`),
      });
      await fx.producer.admin.restoreToPeer(staff, { vertical: BOARD_VERTICAL, node: { tenantId: t, scopeId: p }, reason: 'ok' });
      // The twin: granted again, the edge is merely behind.
      expect(await healthOf(t, c)).toMatchObject({ state: 'behind' });

      await fx.consumer.admin.revokeFromPeer(staff, {
        vertical: CRM_VERTICAL,
        node: { tenantId: t, scopeId: c },
        reason: 'board stops taking CRM changes',
      });
      expect(await healthOf(t, c)).toMatchObject({
        state: 'paused',
        reason: expect.stringContaining(`has '${CRM_VERTICAL}' switched off`),
      });
      // Paused at the door, the backlog is still dated.
      expect((await healthOf(t, c))?.oldestPending).not.toBeNull();
    });

    it('edge health: a producer missing from the tenant is unresolved, and a side that cannot be asked is unavailable, never healthy', async () => {
      const t = await newTenant();
      const c = await install(t, BOARD_VERTICAL);
      expect(await healthOf(t, c)).toMatchObject({
        state: 'unresolved',
        reason: `'${CRM_VERTICAL}' is not installed in this tenant`,
      });

      const u = await newTenant();
      const pu = await install(u, CRM_VERTICAL);
      const cu = await install(u, BOARD_VERTICAL);
      await create(u, pu, 'Unknown');
      // The consumer cannot be asked.
      const noConsumer = await healthOf(u, cu, {
        importState: async () => {
          throw new Error('the deployment serving this scope predates cross-vertical events — redeploy it');
        },
      });
      expect(noConsumer).toMatchObject({ state: 'unavailable', producer: { vertical: '*' }, reason: expect.stringMatching(/redeploy/) });
      // The producer cannot be asked.
      const noProducer = await healthOf(u, cu, {
        readExports: async () => {
          throw new Error('vertical unreachable');
        },
      });
      expect(noProducer).toMatchObject({ state: 'unavailable', producer: { vertical: CRM_VERTICAL }, reason: expect.stringMatching(/unreachable/) });
      // The twin: asked, it answers.
      expect(await healthOf(u, cu)).toMatchObject({ state: 'behind' });
    });

    it('edge health focused on one app shows its edges into it and out of it, and nothing else', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      const focused = (focus: ScopeId) =>
        crossVerticalHealth(fx.consumer, {
          actor: staff,
          tenantId: t,
          focus,
          crossVertical: { reach },
          ...(fx.door ? { door: fx.door } : {}),
        });
      const all = await health(t);
      // crm imports from board and board from crm: two edges in the tenant.
      expect(all.edges).toHaveLength(2);
      // On the board app, both touch it: board ← crm (into), crm ← board (out of).
      const onBoard = await focused(c);
      expect(onBoard.edges.map((e) => `${e.consumer.scopeId}:${e.producer.vertical}`).sort()).toEqual(
        [`${c}:${CRM_VERTICAL}`, `${p}:${BOARD_VERTICAL}`].sort(),
      );
      // A scope that is no install at all has no edges, and asks nothing.
      expect((await focused(scopeId.parse(ulid()))).edges).toEqual([]);

      // A consumer that cannot be asked stays on its PRODUCER's view, as a failure there: tagged
      // with the producer, since it names none itself, so a per-app filter keeps it.
      const unreachable = await crossVerticalHealth(fx.consumer, {
        actor: staff,
        tenantId: t,
        focus: p,
        crossVertical: {
          reach: {
            ...reach,
            importState: (tt, s) =>
              s === c ? Promise.reject(new Error('the board deployment is down')) : reach.importState(tt, s),
          },
        },
        ...(fx.door ? { door: fx.door } : {}),
      });
      const out = unreachable.edges.find((e) => e.consumer.scopeId === c);
      expect(out).toMatchObject({ state: 'unavailable', producer: { vertical: CRM_VERTICAL, scopeId: p } });
      expect(out?.reason).toMatch(/board deployment is down/);
      // Unfocused, the same failure names no producer: the tenant view shows it under '*'.
      const tenantWide = await health(t, {
        importState: (tt, s) => (s === c ? Promise.reject(new Error('down')) : reach.importState(tt, s)),
      });
      expect(tenantWide.edges.find((e) => e.consumer.scopeId === c)).toMatchObject({ producer: { vertical: '*', scopeId: null } });
    });

    it('edge health reads each edge\'s history on its own: a noisy edge cannot push out a quiet one\'s last delivery', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      const quiet = `${c}:${CRM_VERTICAL}`;
      const noisy = `${p}:${BOARD_VERTICAL}`;
      const row = (unit: string, outcome: 'ok' | 'failed', scope: ScopeId) => ({
        kind: 'vertical-events' as const,
        unit,
        outcome,
        tenantId: t,
        scopeId: scope,
        operation: 'sweep.vertical-events:test',
        error: outcome === 'ok' ? null : 'the producer is unreachable',
      });
      await fx.consumer.admin.recordSweepRun(row(quiet, 'ok', c));
      // Far more than any one tenant-wide window: the quiet edge's row is the oldest by far.
      for (let i = 0; i < 250; i++) await fx.consumer.admin.recordSweepRun(row(noisy, 'failed', p));
      const view = await health(t);
      expect(view.history.available).toBe(true);
      expect(view.edges.find((e) => e.consumer.scopeId === c)?.lastDelivered).not.toBeNull();
      expect(view.edges.find((e) => e.consumer.scopeId === p)).toMatchObject({
        lastDelivered: null,
        lastProblem: { outcome: 'failed', error: 'the producer is unreachable' },
      });
    });

    it('edge health never crosses a tenant: one tenant\'s view names only its own edges', async () => {
      const t = await newTenant();
      const u = await newTenant();
      await install(t, CRM_VERTICAL);
      const ct = await install(t, BOARD_VERTICAL);
      await install(u, CRM_VERTICAL);
      const cu = await install(u, BOARD_VERTICAL);
      const view = await health(t);
      expect(view.edges.some((e) => e.consumer.scopeId === ct)).toBe(true);
      expect(view.edges.every((e) => e.tenantId === t)).toBe(true);
      expect(view.edges.some((e) => e.consumer.scopeId === cu)).toBe(false);
    });

    // -- the promote refusal (#1705 PR 3) ------------------------------------------------------

    it('a promote that drops or re-versions an export an installed app imports is refused, and acknowledged it passes', async () => {
      // Fresh slugs: a channel is per vertical and fleet-wide, so this test must own its pair.
      const tag = ulid().slice(-8).toLowerCase();
      const producer = `acme/ex-${tag}`;
      const consumer = `acme/in-${tag}`;
      const TYPE = 'crm.customer-created';
      for (const slug of [producer, consumer]) {
        await fx.consumer.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
      }
      const registry = (extra: object) => JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [], ...extra } });
      const exporting = (v: number | null) =>
        registry(v === null ? {} : { exports: [{ type: TYPE, schemaVersion: v, readPermission: 'customer:read', declaredBy: ['@test/x'] }] });
      const publish = async (slug: string, manifestJson: string, perm = 'p') => {
        const id = ulid();
        await fx.consumer.admin.publishVersion(staff, {
          id,
          verticalSlug: slug,
          version: `1.0.${id.slice(-4).toLowerCase()}`,
          manifestDigest: `m-${id}`,
          permissionDigest: perm,
          migrationDigest: 'g',
          deploymentRef: null,
          manifestJson,
        });
        await fx.consumer.admin.admitVersion(staff, id);
        return id;
      };
      const prodOf = async (slug: string) =>
        (await fx.consumer.admin.listChannels(staff, slug)).find((ch) => ch.channel === 'prod')?.versionId;

      // The producer exports TYPE v1. A tenant runs it beside a consumer whose version imports it.
      const v1 = await publish(producer, exporting(1));
      await fx.consumer.admin.promoteVersion(staff, producer, 'prod', v1);
      const imports = registry({ imports: [{ from: producer, type: TYPE, schemaVersion: 1, declaredBy: ['@test/y'] }] });
      const consumerVersion = await publish(consumer, imports);
      const t = await newTenant();
      const u = await newTenant();
      const bindAt = async (tenant: TenantId, slug: string, version?: string) => {
        const sc = scopeId.parse(ulid());
        await fx.consumer.provisionScope(staff, { tenantId: tenant, scopeId: sc, vertical: slug });
        await fx.consumer.admin.activateScope(staff, tenant, sc);
        if (version) await fx.consumer.admin.bindScopeVersion(staff, tenant, sc, version);
        return sc;
      };
      await bindAt(t, producer, v1);
      const ct = await bindAt(t, consumer, consumerVersion);
      // A tenant that runs the consumer but not the producer has no edge, so nothing of it breaks.
      await bindAt(u, consumer, consumerVersion);

      // The twin first: a version that keeps the export promotes with no new acknowledgement.
      const same = await publish(producer, exporting(1));
      await expect(fx.consumer.admin.promotionImpact(staff, producer, 'prod', same)).resolves.toEqual([]);
      await fx.consumer.admin.promoteVersion(staff, producer, 'prod', same);

      // Dropped: refused, the channel unmoved, and the refusal counts without naming a tenant.
      const dropped = await publish(producer, exporting(null));
      const refused = await refusal(fx.consumer.admin.promoteVersion(staff, producer, 'prod', dropped));
      expect(String(refused)).toMatch(/drops or re-versions 1 exported event type\(s\) that 1 installed app\(s\) in 1 tenant\(s\)/);
      expect(String(refused)).not.toContain(t);
      expect(await prodOf(producer)).toBe(same);
      // The listing is the read beside it, and names exactly the app in the producer's tenant.
      expect(await fx.consumer.admin.promotionImpact(staff, producer, 'prod', dropped)).toEqual([
        { tenantId: t, scopeId: ct, vertical: consumer, version: consumerVersion, type: TYPE, schemaVersion: 1, incoming: null },
      ]);

      // Re-versioned is a break too, and says what it became.
      const bumped = await publish(producer, exporting(2));
      expect((await fx.consumer.admin.promotionImpact(staff, producer, 'prod', bumped))[0]).toMatchObject({ incoming: 2 });

      // Acknowledged, it promotes, and the admin log records the acknowledgement.
      await fx.consumer.admin.promoteVersion(staff, producer, 'prod', dropped, { exportBreak: true });
      expect(await prodOf(producer)).toBe(dropped);
      const log = await fx.consumer.admin.auditLog(staff, { action: 'promoteVersion' });
      expect(log.some((e) => JSON.stringify(e.after).includes('"exportBreak":true'))).toBe(true);
    });

    // #1756's fixtures. The registry decides what a version exports and imports, so each version
    // is a manifest published and admitted, and each app a scope provisioned, activated and bound.
    const BIND_TYPE = 'crm.customer-created';
    const registryJson = (extra: object) => JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [], ...extra } });
    const exportingJson = (v: number | null) =>
      registryJson(v === null ? {} : { exports: [{ type: BIND_TYPE, schemaVersion: v, readPermission: 'customer:read', declaredBy: ['@test/x'] }] });
    const importingJson = (from: string) =>
      registryJson({ imports: [{ from, type: BIND_TYPE, schemaVersion: 1, declaredBy: ['@test/y'] }] });
    const publishManifest = async (slug: string, manifestJson: string, migrationDigest = 'g') => {
      const id = ulid();
      await fx.consumer.admin.publishVersion(staff, {
        id, verticalSlug: slug, version: `1.0.${id.slice(-4).toLowerCase()}`, manifestDigest: `m-${id}`,
        permissionDigest: 'p', migrationDigest, deploymentRef: null, manifestJson,
      });
      await fx.consumer.admin.admitVersion(staff, id);
      return id;
    };
    const bindAt = async (tenant: TenantId, slug: string, version?: string, extra: object = {}) => {
      const sc = scopeId.parse(ulid());
      await fx.consumer.provisionScope(staff, { tenantId: tenant, scopeId: sc, vertical: slug, ...extra });
      await fx.consumer.admin.activateScope(staff, tenant, sc);
      if (version) await fx.consumer.admin.bindScopeVersion(staff, tenant, sc, version);
      return sc;
    };
    const boundTo = async (tenant: TenantId, sc: ScopeId) =>
      (await fx.consumer.admin.getScopeRecord(staff, tenant, sc))?.verticalVersionId;

    it('a bind that drops or re-versions an export an app in its tenant imports is refused, and acknowledged it binds (#1756)', async () => {
      const tag = ulid().slice(-8).toLowerCase();
      const producer = `acme/bx-${tag}`;
      const consumer = `acme/bi-${tag}`;
      for (const slug of [producer, consumer]) {
        await fx.consumer.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
      }
      const v1 = await publishManifest(producer, exportingJson(1));
      const kept = await publishManifest(producer, exportingJson(1));
      // Crosses a migration too, so a bind asking for a snapshot would take one.
      const dropped = await publishManifest(producer, exportingJson(null), 'g2');
      const bumped = await publishManifest(producer, exportingJson(2));
      const consumerVersion = await publishManifest(consumer, importingJson(producer));

      // Tenant t runs the producer at v1 beside an app that imports BIND_TYPE v1 from it. Tenant u
      // runs the same pair, so a break in t that named u's app would show here.
      const t = await newTenant();
      const u = await newTenant();
      const pt = await bindAt(t, producer, v1);
      const ct = await bindAt(t, consumer, consumerVersion);
      await bindAt(u, producer, v1);
      await bindAt(u, consumer, consumerVersion);

      // The twin first: a version that keeps the export binds with no acknowledgement.
      await expect(fx.consumer.admin.bindingImpact(staff, t, pt, kept)).resolves.toEqual([]);
      await fx.consumer.admin.bindScopeVersion(staff, t, pt, kept);
      expect(await boundTo(t, pt)).toBe(kept);

      // Dropped: refused, the pointer unmoved, and the listing names t's app and nothing of u's.
      const refused = await refusal(fx.consumer.admin.bindScopeVersion(staff, t, pt, dropped));
      expect(String(refused)).toMatch(/this bind drops or re-versions 1 exported event type\(s\) that 1 installed app\(s\) in this tenant/);
      expect(await boundTo(t, pt)).toBe(kept);
      expect(await fx.consumer.admin.bindingImpact(staff, t, pt, dropped)).toEqual([
        { tenantId: t, scopeId: ct, vertical: consumer, version: consumerVersion, type: BIND_TYPE, schemaVersion: 1, incoming: null },
      ]);
      // Refused with a snapshot asked for too, on a bind that crosses a migration: the refusal
      // comes first, so no archive is taken.
      const before = (await fx.consumer.admin.listScopes(staff, { tenantId: t })).length;
      await refusal(fx.consumer.admin.bindScopeVersion(staff, t, pt, dropped, { snapshot: true }));
      expect((await fx.consumer.admin.listScopes(staff, { tenantId: t })).length).toBe(before);
      // Re-versioned is a break too, and says what it became.
      expect((await fx.consumer.admin.bindingImpact(staff, t, pt, bumped))[0]).toMatchObject({ scopeId: ct, incoming: 2 });

      // A tenant whose producer has no app importing from it binds the same version unrefused.
      const lone = await newTenant();
      const pl = await bindAt(lone, producer, v1);
      await fx.consumer.admin.bindScopeVersion(staff, lone, pl, dropped);
      expect(await boundTo(lone, pl)).toBe(dropped);

      // A first bind runs nothing before it, so it promised nothing.
      const fresh = await bindAt(t, producer);
      await fx.consumer.admin.bindScopeVersion(staff, t, fresh, dropped);
      expect(await boundTo(t, fresh)).toBe(dropped);

      // A fork and a preview are never an edge's producer, so nothing they run can break one.
      for (const extra of [
        { kind: 'archive', forkedFrom: pt, forkedAt: new Date().toISOString() },
        { kind: 'preview' },
      ]) {
        const copy = await bindAt(t, producer, kept, extra);
        await fx.consumer.admin.bindScopeVersion(staff, t, copy, dropped);
        expect(await boundTo(t, copy)).toBe(dropped);
      }

      // Acknowledged, it binds, and the admin log records the acknowledgement. The snapshot the
      // refused binds above did not take is taken here, which is what made their count mean
      // something.
      const beforeAck = (await fx.consumer.admin.listScopes(staff, { tenantId: t })).length;
      await fx.consumer.admin.bindScopeVersion(staff, t, pt, dropped, { snapshot: true, acknowledge: { exportBreak: true } });
      expect(await boundTo(t, pt)).toBe(dropped);
      expect((await fx.consumer.admin.listScopes(staff, { tenantId: t })).length).toBe(beforeAck + 1);
      const log = await fx.consumer.admin.auditLog(staff, { action: 'bindScopeVersion' });
      expect(log.some((e) => e.scopeId === pt && JSON.stringify(e.after).includes('"exportBreak":true'))).toBe(true);
    });

    it('a bind is judged on what the scope RUNS: re-pointing a scope on its serving script changes nothing it exports (#1756)', async () => {
      const tag = ulid().slice(-8).toLowerCase();
      const producer = `acme/sx-${tag}`;
      const consumer = `acme/si-${tag}`;
      for (const slug of [producer, consumer]) {
        await fx.consumer.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
      }
      const v1 = await publishManifest(producer, exportingJson(1));
      const dropped = await publishManifest(producer, exportingJson(null));
      const consumerVersion = await publishManifest(consumer, importingJson(producer));
      const t = await newTenant();
      const pt = await bindAt(t, producer, v1);
      const ct = await bindAt(t, consumer, consumerVersion);

      // The vertical serves v1 in place, and the producer's scope runs that script. What it runs
      // is the serving version whatever its pointer says, so moving the pointer breaks nothing.
      // This is the shape of a tenant's Update of an install on the serving script, and of the
      // promote's own rebind of a private vertical's scopes.
      const ref = `serving-${tag}`;
      await fx.consumer.admin.setVerticalServing(staff, producer, { ref, versionId: v1, doClasses: [], migrationTag: 'g' });
      await fx.consumer.admin.setScopeServingRef(staff, t, pt, ref);
      await expect(fx.consumer.admin.bindingImpact(staff, t, pt, dropped)).resolves.toEqual([]);
      await fx.consumer.admin.bindScopeVersion(staff, t, pt, dropped);

      // Its twin: the same scope off the serving script runs its own pointer, so the same move is
      // a break — here from `dropped` back to v1's export and away again.
      await fx.consumer.admin.bindScopeVersion(staff, t, pt, v1);
      await fx.consumer.admin.setScopeServingRef(staff, t, pt, null);
      const refused = await refusal(fx.consumer.admin.bindScopeVersion(staff, t, pt, dropped));
      expect(String(refused)).toMatch(/this bind drops or re-versions/);
      expect(await boundTo(t, pt)).toBe(v1);
      expect((await fx.consumer.admin.bindingImpact(staff, t, pt, dropped)).map((b) => b.scopeId)).toEqual([ct]);
    });

    it("a private vertical's promote rebinds its owned scopes past the bind gate: the promote already judged the break (#1756)", async () => {
      const tag = ulid().slice(-8).toLowerCase();
      const producer = `acme/px-${tag}`;
      const consumer = `acme/pi-${tag}`;
      const t = await newTenant();
      // PRIVATE: owned by t and unlisted, so a prod promote re-points t's scopes in the same act.
      await fx.consumer.admin.registerVertical(staff, { slug: producer, name: producer, source: 'cli', ownerTenant: t });
      await fx.consumer.admin.registerVertical(staff, { slug: consumer, name: consumer, source: 'cli' });
      const v1 = await publishManifest(producer, exportingJson(1));
      const dropped = await publishManifest(producer, exportingJson(null));
      const consumerVersion = await publishManifest(consumer, importingJson(producer));
      await fx.consumer.admin.promoteVersion(staff, producer, 'prod', v1);
      const pt = await bindAt(t, producer, v1);
      await bindAt(t, consumer, consumerVersion);

      // The same move by bind alone is refused, which is what makes the next line mean something.
      expect(String(await refusal(fx.consumer.admin.bindScopeVersion(staff, t, pt, dropped)))).toMatch(/this bind drops/);
      // The promote is refused on the same break, and acknowledged it moves the owned scope too.
      expect(String(await refusal(fx.consumer.admin.promoteVersion(staff, producer, 'prod', dropped)))).toMatch(/promotion drops/);
      await fx.consumer.admin.promoteVersion(staff, producer, 'prod', dropped, { exportBreak: true });
      expect(await boundTo(t, pt)).toBe(dropped);
    });

    it('a fork is neither read nor fed, and two primary installs are refused rather than guessed between', async () => {
      const t = await newTenant();
      const p = await install(t, CRM_VERTICAL);
      const c = await install(t, BOARD_VERTICAL);
      await create(t, p, 'Before the fork');
      await fx.producer.snapshotScope(staff, t, p); // a copy of crm in the same tenant

      const first = await sweep();
      // The fork did not make the producer ambiguous, and was not read.
      expect(into(first.report, c)).toMatchObject({ state: 'delivered', producer: { scopeId: p } });
      expect((await board(t, c)).associations.map((r) => r.name)).toEqual(['Before the fork']);

      // A SECOND primary crm install: which one is "the" CRM is now a choice nobody made.
      await install(t, CRM_VERTICAL);
      await create(t, p, 'After the second install');
      const { report } = await sweep();
      expect(into(report, c)).toMatchObject({
        state: 'unresolved',
        reason: expect.stringContaining(`more than one primary instance of '${CRM_VERTICAL}'`),
      });
      expect((await board(t, c)).associations).toHaveLength(1);
    });
  });
}
