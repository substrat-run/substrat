import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  type PermissionKey,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
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
    ],
    consumes: [{ from: BOARD_VERTICAL, type: 'board.association-linked', schemaVersion: 1 }],
    exports: [
      { type: 'crm.customer-created', schemaVersion: 1, readPermission: 'customer:read' },
      { type: 'crm.customer-touched', schemaVersion: 1, readPermission: 'customer:read' },
    ],
  },
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

export const crmExportMod: ModuleRegistration = {
  manifest: crmExportModManifest,
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE crm_customers (id TEXT PRIMARY KEY, name TEXT NOT NULL)' }],
  operations: {
    'crm/create': crmCreate as OperationHandler<never, unknown>,
    'crm/note': crmNote as OperationHandler<never, unknown>,
    'crm/touch': crmTouch as OperationHandler<never, unknown>,
  },
  imports: {
    [BOARD_VERTICAL]: {
      // The loop's other half: every link board announces is answered with a touch.
      'board.association-linked': async (ctx, event) => {
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
  describe(`cross-vertical events (#1705): ${adapterName}`, () => {
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
    const reach: CrossVerticalReach = {
      importState: async (t, s) => (await hostOf(t, s)).admin.importState(staff, t, s),
      readExports: async (t, s, input) => (await hostOf(t, s)).admin.readExportedEvents(staff, t, s, input),
      deliver: async (t, s, batch) => (await hostOf(t, s)).deliverToPeer(t, s, batch),
    };

    const newTenant = async (): Promise<TenantId> => {
      const t = tenantId.parse(ulid());
      await fx.producer.admin.createTenant(staff, { id: t, slug: `ve-${t.toLowerCase()}`, name: 'Vertical events' });
      await fx.producer.admin.grantEntitlement(staff, t, 'crm-export');
      await fx.producer.admin.grantEntitlement(staff, t, 'board-import');
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
