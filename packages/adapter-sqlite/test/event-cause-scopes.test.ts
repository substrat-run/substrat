/**
 * The delivery cause is a fact about ONE scope, so it is held on that scope's
 * runtime (#1237).
 *
 * `SqliteScopeHost` serves every scope in the process, but each has its own
 * `ScopeActor` — serialization is per scope, never host-wide. So the moment a
 * consumer awaits (`ctx.check` is async, which is the first line of most of them),
 * the loop is free to run another scope's operation. A host-wide "currently
 * delivering" field would be read by that operation's `emit`, and its own event —
 * caused by nothing, emitted directly by an operation — would be written down as
 * caused by an event in a different scope entirely. That is a recorded fact that is
 * false, which is strictly worse than the NULL the column uses for "unrecorded", and
 * no later reader could tell the two apart.
 *
 * Lives here rather than in the shared contract suite because it needs two scopes to
 * interleave inside one host, and the Cloudflare adapter cannot reproduce the shape:
 * there, one Durable Object IS one scope, so the field is per-scope by construction.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  moduleManifest,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import {
  ulid,
  type ConsumerHandler,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

interface CauseRow {
  id: string;
  type: string;
  scope_id: string;
  caused_by: string | null;
}

/** Resolved when the consumer has entered and is parked mid-delivery. */
let entered!: () => void;
let hasEntered!: Promise<void>;
/** Awaited by the consumer before it emits — the window the other scope runs in. */
let release!: () => void;
let parked!: Promise<void>;
/** Only the FIRST delivery parks; the second scope's own consumer must not block. */
let parkedOnce = false;

const causeManifest = moduleManifest.parse({
  id: '@test/cause',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'cause:use', description: 'cause permission' }],
  events: {
    emits: [
      { type: 'cause.first', schemaVersion: 1 },
      { type: 'cause.second', schemaVersion: 1 },
    ],
    consumes: [{ type: 'cause.first', schemaVersion: 1 }],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'cause',
});

/** Awaits BEFORE emitting — the yield point a host-wide field cannot survive. */
const causeConsumer: ConsumerHandler = async (ctx, event) => {
  if (!parkedOnce) {
    parkedOnce = true;
    entered();
    await parked;
  }
  ctx.emit({
    type: 'cause.second',
    schemaVersion: 1,
    entity: event.entity,
    piiClass: 'none',
    payload: {},
  });
};

const causeMod: ModuleRegistration = {
  manifest: causeManifest,
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE cause_log (v TEXT NOT NULL)' }],
  operations: {
    'cause/produce': ((ctx) => {
      ctx.emit({
        type: 'cause.first',
        schemaVersion: 1,
        entity: { entityType: 'cause-thing', entityId: 'c1' },
        piiClass: 'none',
        payload: {},
      });
    }) as OperationHandler<never, unknown>,
    'cause/read': ((ctx) =>
      ctx.sql.query(
        `SELECT id, type, scope_id, caused_by FROM _substrat_outbox ORDER BY id`,
      )) as OperationHandler<never, unknown>,
  },
  consumers: { 'cause.first': causeConsumer },
};

describe('the delivery cause belongs to one scope (#1237)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const sA = scopeId.parse(ulid());
  const sB = scopeId.parse(ulid());
  const anna: PrincipalId = principalId.parse(ulid());
  /** Scope A's parked invocation, held here so teardown can settle it. */
  let inFlight: Promise<unknown> = Promise.resolve();

  beforeEach(async () => {
    inFlight = Promise.resolve();
    parkedOnce = false;
    hasEntered = new Promise<void>((resolve) => (entered = resolve));
    parked = new Promise<void>((resolve) => (release = resolve));
    dir = mkdtempSync(join(tmpdir(), 'substrat-event-cause-'));
    host = new SqliteScopeHost({ dir });
    host.registerModule(causeMod);
    await host.admin.createTenant(staff, { id: t1, slug: 'cause-tenant', name: 'Cause' });
    await host.admin.grantEntitlement(staff, t1, 'cause');
    for (const s of [sA, sB]) {
      await host.provisionScope(staff, { tenantId: t1, scopeId: s, vertical: 'cause-vertical' });
      await host.admin.activateScope(staff, t1, s);
    }
  });

  afterEach(async () => {
    // Release and SETTLE before closing. A parked consumer resumes into `ctx.emit`, and
    // closing the scope databases under it would fail the teardown on a path where the
    // test itself had already failed — burying the real assertion under a SQLite error.
    release();
    await Promise.allSettled([inFlight]);
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("one scope's delivery never stamps another scope's emit", async () => {
    const a = await host.getScope(anna, t1, sA);
    const b = await host.getScope(anna, t1, sB);

    // Scope A parks INSIDE its consumer, mid-delivery, holding a cause.
    inFlight = a.invoke('cause/produce');
    await hasEntered;
    try {
      // Scope B emits in that window — a plain operation emit, caused by nothing. Its
      // actor is a different one, so nothing serializes it behind A.
      await b.invoke('cause/produce');
    } finally {
      // In `finally`, so a failing B still unparks A rather than leaving it holding a
      // transaction open into the teardown.
      release();
      await inFlight;
    }

    const inB = (await b.invoke('cause/read')) as CauseRow[];
    const first = inB.find((r) => r.type === 'cause.first')!;
    // THE ASSERTION. On a host-wide field this reads A's `cause.first` id.
    expect(first.caused_by).toBeNull();
    expect(first.scope_id).toBe(sB);

    // …and A's own consumer emit, which resumed after B ran, still names its cause —
    // so the fix is scoping, not a field that gets cleared into uselessness.
    const inA = (await a.invoke('cause/read')) as CauseRow[];
    const cause = inA.find((r) => r.type === 'cause.first')!;
    const reaction = inA.find((r) => r.type === 'cause.second')!;
    expect(reaction.caused_by).toBe(cause.id);
  });
});
