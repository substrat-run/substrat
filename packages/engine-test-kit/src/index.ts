import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  moduleManifest,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type DomainEventInput,
  type PermissionKey,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  type ScopeStub,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';

/**
 * A kernel-backed fixture for testing an engine **directly**.
 *
 * Why this exists: engines are published packages whose invariants were, until
 * this kit, asserted only as a side effect of a demo vertical's scenario test.
 * That is how a defect in `underlagTotal` survived — nothing called it. An
 * engine deserves a test target that does not require inventing a whole world.
 *
 * What it is NOT: a mock. The host, the migrations, the permission checker, the
 * transaction boundary and the event dispatch are all real. The only synthetic
 * thing is the **probe** (below), which stands in for whichever vertical would
 * normally produce an event.
 */

// ---------------------------------------------------------------------------
// The probe — a stand-in producer
// ---------------------------------------------------------------------------

/**
 * Engines mostly react to events they never produce. Testing a consumer
 * therefore needs *something* to emit, and the honest way to get one is a real
 * module going through real kernel dispatch — not a hand-built `ctx`.
 *
 * The probe is that module: one operation that emits whatever event it is
 * handed. The kernel does not validate emitted types against `manifest.emits`,
 * so a single probe can stand in for any producer.
 */
const PROBE_PERM = 'probe:emit' as PermissionKey;

/**
 * The probe's manifest is built per-harness because it also carries the
 * **entity relations** a test needs.
 *
 * This is not a workaround — it mirrors the topology. An engine deliberately
 * does not know which entity types a vertical will hang off it: `engine-protocol`
 * has never heard of a work order, and the kernel refuses `ctx.link` across an
 * edge no manifest declares. In a real deployment the *vertical* declares
 * `protocol → workorder`. The probe stands in for the vertical, so it declares
 * the edges the vertical would.
 */
function buildProbeManifest(entityRelations: { entityType: string; parentType: string }[]) {
  return moduleManifest.parse({
    id: '@substrat-run/engine-test-kit-probe',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: PROBE_PERM, description: 'Emit an arbitrary event (test probe)' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entityRelations,
    entitlementKey: 'probe',
  });
}

const emitOp: OperationHandler<DomainEventInput, { emitted: true }> = async (ctx, input) => {
  // Deliberately no ctx.check: the probe is the test harness's own hand, not a
  // surface under test. Engines' own permission checks still run on their ops.
  ctx.emit(input);
  return { emitted: true };
};

/**
 * Thunks awaiting a real `OperationContext`.
 *
 * An engine's **exported in-scope functions** are the first of its five public
 * surfaces (D-28) — `createWorkOrder(ctx, …)` is how a vertical actually creates
 * a work order, since the engine registers no create operation. Those functions
 * take a ctx, and a ctx only exists inside an operation. So the probe carries a
 * second operation that runs a caller-supplied function with the real thing:
 * real transaction, real `ctx.sql`, real `ctx.emit`, real `ctx.check`.
 *
 * Passing a closure by id (rather than by value) keeps this honest about its
 * limits: it works because the SQLite host runs in-process. A Durable Object
 * cannot receive a closure over RPC, which is why `contract-tests` bundles
 * static fixture modules instead. This kit is deliberately SQLite-only.
 */
const thunks = new Map<string, (ctx: OperationContext) => unknown>();

const runOp: OperationHandler<{ thunkId: string }, unknown> = async (ctx, input) => {
  const fn = thunks.get(input.thunkId);
  if (!fn) throw new Error(`engine-test-kit: no thunk registered for ${input.thunkId}`);
  return await fn(ctx);
};

const buildProbeModule = (
  entityRelations: { entityType: string; parentType: string }[],
): ModuleRegistration => ({
  manifest: buildProbeManifest(entityRelations),
  migrations: [],
  operations: { 'probe/emit': emitOp as never, 'probe/run': runOp as never },
});

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface EngineHarness {
  host: SqliteScopeHost;
  tenant: TenantId;
  scope: ScopeId;
  /** The scope host's directory — inspect the raw SQLite file if a test must. */
  dir: string;
  /**
   * A stub for a fresh principal holding exactly `permissions` — nothing more.
   * Pass `[]` to get a principal that should be refused everything, which is how
   * you assert an engine's default-deny rather than assuming it.
   */
  as(permissions: PermissionKey[]): Promise<ScopeStub>;
  /**
   * Fire an event into the scope so the engine's registered consumers see it,
   * through the real dispatch path. `entity`, `piiClass` and `schemaVersion` are
   * the producer's business, so they are required — a test that fakes them
   * loosely is a test that proves less than it looks.
   */
  emit(event: DomainEventInput): Promise<void>;
  /**
   * Run `fn` with a real `OperationContext` — the way to test an engine's
   * exported in-scope functions, which are its primary public surface and are
   * frequently reachable no other way (an engine may register no operation for
   * them at all).
   *
   * `permissions` is what the calling principal holds, so `ctx.check` inside the
   * function under test answers truthfully.
   */
  run<T>(fn: (ctx: OperationContext) => T | Promise<T>, permissions?: PermissionKey[]): Promise<T>;
  /**
   * Failed consumer deliveries, from the kernel's own journal.
   *
   * A consumer that throws does NOT fail the producer: dispatch is post-commit,
   * each consumer runs in its own transaction, and a throw rolls that
   * transaction back and dead-letters the delivery (adapter-sqlite `dispatch`).
   * So `await emit(...)` resolving proves nothing about whether the consumer
   * succeeded — this is how a test tells the difference.
   */
  deadLetters(): DeadLetter[];
  /**
   * Events the engine has emitted, from the kernel outbox, oldest first.
   *
   * What an engine emits is part of its public contract (D-28: payload fields
   * are frozen once shipped), so it deserves assertions as much as what it
   * stores. Reading the outbox is also the only way to see an event nothing
   * consumes — which is every invoicing event today.
   */
  eventsOfType(type: string): EmittedEvent[];
  close(): Promise<void>;
}

export interface DeadLetter {
  eventId: string;
  consumerModule: string;
  error: string;
}

export interface EmittedEvent {
  id: string;
  type: string;
  schemaVersion: number;
  entity: { entityType: string; entityId: string };
  /**
   * The GDPR classification and the subject it keys on (§5.3). Exposed because
   * `subjectId` is what crypto-shredding erases by, and it is NOT always the
   * acting principal: `engines/booking` names a participant with no account,
   * and `engines/protocol` names an external BankID signatory the same way. A
   * test that cannot see this cannot tell those apart from self-attribution.
   */
  piiClass: string;
  subjectId: string | null;
  payload: unknown;
}

export interface EngineHarnessOptions {
  /** The engine(s) under test, in registration order. */
  modules: ModuleRegistration[];
  /**
   * Entitlement keys to grant. Defaults to every module's own
   * `manifest.entitlementKey`, because a test that forgets one gets a
   * default-deny that looks like a permission bug (§4.3, control-plane).
   */
  entitlements?: string[];
  /**
   * Entity relations the *vertical* would declare, e.g.
   * `{ entityType: 'protocol', parentType: 'workorder' }`. The kernel refuses to
   * link across an undeclared edge, and an engine cannot declare edges to types
   * it has never heard of — that refusal is the star topology being enforced,
   * not an obstacle to route around.
   */
  entityRelations?: { entityType: string; parentType: string }[];
  /**
   * Bind the scope to a vertical and mint that vertical's attachment blob store.
   *
   * Off by default, and opt-in rather than always-on because a scope with no
   * vertical is the leaner fixture and every test that predates this needs
   * nothing from one. Turn it on to test an engine's `attachmentTargets`: bytes
   * live in the per-tenant store the PLATFORM provisions for (tenant, vertical),
   * so without a vertical there is nowhere for an attachment to go and
   * `host.attachments(...)` refuses — which is correct, and used to mean an
   * engine's declared attachment targets could not be exercised here at all.
   *
   * The harness plays the vertical's part, exactly as `entityRelations` does.
   */
  attachments?: boolean | { vertical: string };
}

/**
 * Build a real scope host with `modules` registered, one tenant, one scope, and
 * entitlements granted. Call `close()` in `afterAll` — it removes the temp dir.
 */
export async function engineHarness(opts: EngineHarnessOptions): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-engine-kit-'));
  const host = new SqliteScopeHost({ dir });

  const modules = [...opts.modules, buildProbeModule(opts.entityRelations ?? [])];
  for (const m of modules) host.registerModule(m);

  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  await host.admin.createTenant(staff, { id: t, slug: `kit-${t.slice(0, 8).toLowerCase()}`, name: 'Engine test kit tenant' });

  const keys = opts.entitlements ?? modules.map((m) => m.manifest.entitlementKey).filter((k): k is string => !!k);
  for (const key of [...new Set(keys)]) await host.admin.grantEntitlement(staff, t, key);

  const vertical =
    opts.attachments === undefined || opts.attachments === false
      ? undefined
      : opts.attachments === true
        ? 'kit'
        : opts.attachments.vertical;
  await host.provisionScope(staff, {
    tenantId: t,
    scopeId: s,
    jurisdiction: 'eu',
    ...(vertical ? { vertical } : {}),
  });
  // Provisioned rows are inert until confirmed (K-31). In a harness the platform and
  // the vertical are the same process, so the confirmation is immediate.
  await host.admin.activateScope(staff, t, s);
  // The per-tenant attachment store, minted by the platform for (tenant, vertical) —
  // the same shape a real deployment provisions, so `host.attachments` resolves it
  // by the same rule (`ATTACHMENTS` is the documented binding name).
  if (vertical) {
    await host.provisionBlobStore(staff, { tenantId: t, vertical, binding: 'ATTACHMENTS' });
  }

  /**
   * One throwaway role per permission set — roles are cheap, isolation is not.
   *
   * The role key uses the WHOLE ulid, not a slice: a ULID's first 10 characters
   * are the timestamp and only the last 16 are random, so `slice(0, 10)` yields
   * the same key for every role minted in the same millisecond. Two `as()` calls
   * would then define and redefine ONE role, and every principal would hold the
   * last permission set written — a fixture that hands out more authority than
   * the test asked for, which is the exact bug a permission test cannot afford.
   */
  const as = async (permissions: PermissionKey[]): Promise<ScopeStub> => {
    const principal = principalId.parse(ulid());
    // A principal with no role at all — `roleDefinition.permissions` is min(1),
    // so "holds nothing" cannot be expressed as an empty role. Assigning no role
    // is the truer model of it anyway: no tuples, so the checker denies by
    // default rather than by an empty list.
    if (permissions.length === 0) return host.getScope(principal, t, s);

    const roleKey = `kit-role-${ulid().toLowerCase()}`;
    await host.admin.defineRole(staff, t, { key: roleKey, permissions, source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: principal, roleKey, node: { tenantId: t, scopeId: s } });
    return host.getScope(principal, t, s);
  };

  const probe = await as([PROBE_PERM]);

  return {
    host,
    tenant: t,
    scope: s,
    dir,
    as,
    emit: async (event) => {
      await probe.invoke('probe/emit', event);
    },
    run: async <T,>(fn: (ctx: OperationContext) => T | Promise<T>, permissions?: PermissionKey[]) => {
      const thunkId = ulid();
      thunks.set(thunkId, fn as (ctx: OperationContext) => unknown);
      try {
        const caller = permissions ? await as([...permissions, PROBE_PERM]) : probe;
        return (await caller.invoke('probe/run', { thunkId })) as T;
      } finally {
        thunks.delete(thunkId);
      }
    },
    eventsOfType: (type) => {
      const db = new Database(join(dir, `${t}__${s}.sqlite`), { readonly: true });
      try {
        return db
          .prepare(
            `SELECT id, type, schema_version, entity_type, entity_id,
                    pii_class, subject_id, payload
               FROM _substrat_outbox WHERE type = ? ORDER BY id`,
          )
          .all(type)
          .map((r) => {
            const row = r as {
              id: string;
              type: string;
              schema_version: number;
              entity_type: string;
              entity_id: string;
              pii_class: string;
              subject_id: string | null;
              payload: string | null;
            };
            return {
              id: row.id,
              type: row.type,
              schemaVersion: row.schema_version,
              entity: { entityType: row.entity_type, entityId: row.entity_id },
              piiClass: row.pii_class,
              subjectId: row.subject_id,
              payload: row.payload ? (JSON.parse(row.payload) as unknown) : null,
            };
          });
      } finally {
        db.close();
      }
    },
    deadLetters: () => {
      // Read-only peek at the kernel's delivery journal. Harness code, so the
      // raw-SQLite ban on module code does not apply; reads of `_substrat_*` are
      // permitted regardless (writes would forge the spine).
      const db = new Database(join(dir, `${t}__${s}.sqlite`), { readonly: true });
      try {
        return db
          .prepare(
            `SELECT event_id, consumer_module, error FROM _substrat_deliveries
              WHERE error IS NOT NULL ORDER BY delivered_at`,
          )
          .all()
          .map((r) => {
            const row = r as { event_id: string; consumer_module: string; error: string };
            return { eventId: row.event_id, consumerModule: row.consumer_module, error: row.error };
          });
      } finally {
        db.close();
      }
    },
    close: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type { PrincipalId, ScopeId, TenantId };
