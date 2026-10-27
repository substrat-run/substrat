// The contract suites on the DO path, part 3 of 3: what a scope holds and how it is read — size and
// introspection reads, peers, attachments, provisioning and recovery, search, timelines, entity
// state, migrations, logs and the orphan sweep. Parts 1 and 2 are contract-hosts.test.ts and
// contract-switch.test.ts; CI runs each on its own shard (tools/ci-scope.mjs PARTS).
import { env, runInDurableObject } from 'cloudflare:test';
import { r2TenantBlobStore } from '../src/r2.js';
import { REWIND_REFUSED } from '../src/rewind-refusal.js';
import {
  CARRIED_AWAY_KEY,
  LOAD_STAMP_KEY,
  ORPHAN_SWEEP_GRACE_MS,
  attachmentBlobKey,
  attachmentSweepFenceKey,
  dumpMetaValue,
  promoteReviewDigest,
} from '@substrat-run/kernel';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { warmControlPlane, warmSwitchHolds } from './do-warmup.js';
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';
import { armRewind, awaitRestart, restartNow } from './pitr-emulation.js';
import {
  connectionId,
  errorCodeOf,
  fromWireFailure,
  SCOPE_GATE_REASONS,
  type SubstratError,
  toProblem,
  moduleId,
  permissionKey,
  platformActorId,
  eventId,
  principalId,
  projectedConnectionGrant,
  scopeId,
  tenantId,
  type EntitlementGrant,
  type ProjectedConnectionGrant,
  type RoleDefinition,
  type ScopeId,
  type ScopeTable,
  type TenantId,
} from '@substrat-run/contracts';
import {
  ATTACHMENT_TEXT_JOB,
  ATTACHMENT_TEXT_MODULE,
  PermissionDenied,
  ulid,
  UNSAFE_allowAllChecker,
  webCryptoSecretBox,
  type ModuleLogLine,
  type InvocationLogLine,
} from '@substrat-run/kernel';
import {
  capabilityAttachmentContractSuite,
  uploadLinkContractSuite,
  orphanSweepContractSuite,
  uploadLinkReplayContractSuite,
  type OrphanSweepFixture,
  uploadLinkMod,
  UPL_READ,
  UPL_WRITE,
  attachmentBytesContractSuite,
  attachmentRefusalContractSuite,
  attachmentTextContractSuite,
  type AttachmentTextHostOptions,
  billedMod,
  connectorTestFetch,
  sizeReadsContractSuite,
  wireNonceContractSuite,
  introspectionReadsContractSuite,
  introspectionReadsOf,
  introspectionReadCalls,
  TEST_LIFECYCLE,
  scheduleMod,
  peerContractSuite,
  verticalResolutionContractSuite,
  searchContractSuite,
  entityVersionContractSuite,
  timelineContractSuite,
  concurrencyContractSuite,
  emittedReportContractSuite,
  moduleLogContractSuite,
  checkTallyContractSuite,
  asyncLogContractSuite,
  idempotencyContractSuite,
  listContractSuite,
  migrationDigestContractSuite,
  heldVersion,
  entityStateContractSuite,
  entityStateMigrationContractSuite,
  entityTrashContractSuite,
  derivedHandlersContractSuite,
  updatedStampsContractSuite,
  TRASH_MODULE_ID,
  subjectErasureContractSuite,
  migrationCommentsContractSuite,
  manyMigrationsContractSuite,
  migrationFenceContractSuite,
  permMod,
  inputParseContractSuite,
  spineGuardContractSuite,
  sqlLimitsContractSuite,
} from '@substrat-run/contract-tests';
import { CloudflareScopeHost } from './test-host.js';
import type { DoReply } from '../src/do-reply.js';
import { ControlPlaneDO } from '../src/control-plane-do.js';
import {
  PROVISIONED_VERSIONS_SQL,
  installsReconciledOf,
  provisionedVersionsParams,
  runPlatformSweep,
  type ScopeHost,
} from '@substrat-run/kernel';
import { refuseAdminRows, refuseSwitchRecord } from './contract-support.js';

async function reviewFor(host: CloudflareScopeHost, staff: ReturnType<typeof platformActorId.parse>, slug: string, incoming: string) {
  const base = (await host.admin.listChannels(staff, slug)).find((c) => c.channel === 'prod')?.versionId ?? null;
  const side = async (id: string) => ({
    ...(await host.admin.getVersion(staff, id, slug))!,
    migrations: await host.admin.versionMigrations(staff, slug, id),
  });
  return { base, digest: await promoteReviewDigest(base ? await side(base) : null, await side(incoming)) };
}

// Absorb the inter-file DO reload before any suite's first directory call
// (see do-warmup.ts) — file-level, so it runs before every suite below.
beforeAll(() => warmControlPlane(env.CONTROL_PLANE));
// …and the #1819 hold object every schedule pass over SCOPE reads.
beforeAll(() => warmSwitchHolds(env.SCOPE));

// Addressing a DO constructs it, so it is listed whatever a read decides; what a refusal must
// leave is an object with no state in it, which `holdsScope` would read as held.
const scopeObjectHoldsNothing = async (s: ScopeId): Promise<boolean> => {
  const stub = env.SCOPE.get(env.SCOPE.idFromName(s));
  return runInDurableObject(stub, (_i, state) =>
    ['_substrat_meta', '_substrat_tuples', '_substrat_outbox', '_substrat_migrations', '_substrat_roles', '_substrat_schedule_state'].every(
      (table) =>
        state.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE name = ?`, table).toArray().length === 0 ||
        state.storage.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length === 0,
    ),
  );
};

// #2541: the vertical-side size reads hold the scope before they open its store. Here the host has
// a directory, which these reads do not consult: the scope's own storage is what says it is held.
sizeReadsContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  return {
    host,
    databaseSizeLocal: (s) => host.databaseSizeLocal(s),
    attachmentSizeLocal: (s) => host.attachmentSizeLocal(s),
    storeHoldsNothing: async (_t, s) => scopeObjectHoldsNothing(s),
    cleanup: async () => host.close(),
  };
});

// RFC wire-signing §4: the nonce store, the same on both adapters.
wireNonceContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  return {
    host,
    claimWireNonceLocal: (t, s, n, u) => host.claimWireNonceLocal(t, s, n, u),
    cleanup: async () => host.close(),
  };
});

// #2544: the introspection reads hold the scope before they read it, as the size reads do.
introspectionReadsContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  return {
    host,
    ...introspectionReadsOf(host),
    storeHoldsNothing: async (_t, s) => scopeObjectHoldsNothing(s),
    cleanup: async () => host.close(),
  };
});

// #2541: the held check and the read are ONE call into the scope's object, so nothing can land between them.
describe('vertical-side size reads are one call into the scope object (#2541)', () => {
  const staff = platformActorId.parse(ulid());
  const heldScope = async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `one-call-${t.slice(-8).toLowerCase()}`, name: 'One call' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'size-reads' });
    await host.admin.activateScope(staff, t, s);
    return { host, t, s };
  };
  type SizeStub = { databaseSizeIfHeld(): Promise<number | null>; attachmentBytesIfHeld(): Promise<number | null> };
  const objectOf = (s: ScopeId) => env.SCOPE.get(env.SCOPE.idFromName(s));
  const stubOf = (s: ScopeId) => objectOf(s) as unknown as SizeStub;

  it('each read makes exactly one RPC to the scope, so a reap cannot land between a check and a read', async () => {
    const { host, s } = await heldScope();
    onTestFinished(async () => host.close());
    const calls: string[] = [];
    const real = stubOf(s);
    const counted = {
      databaseSizeIfHeld: () => (calls.push('databaseSizeIfHeld'), real.databaseSizeIfHeld()),
      attachmentBytesIfHeld: () => (calls.push('attachmentBytesIfHeld'), real.attachmentBytesIfHeld()),
    };
    vi.spyOn(host as unknown as { scopeStub(id: ScopeId): unknown }, 'scopeStub').mockReturnValue(counted);
    expect(await host.databaseSizeLocal(s)).toBeGreaterThan(0);
    expect(await host.attachmentSizeLocal(s)).toBe(0);
    expect(calls).toEqual(['databaseSizeIfHeld', 'attachmentBytesIfHeld']);
  });

  it('the object answers "not held" in the same call that would have read: a reaped scope yields null, never a number', async () => {
    const { host, t, s } = await heldScope();
    onTestFinished(async () => host.close());
    expect(await stubOf(s).databaseSizeIfHeld()).toBeGreaterThan(0);
    await host.admin.archiveScope(staff, t, s);
    await host.admin.reapScope(staff, t, s, { force: true });
    expect(await stubOf(s).databaseSizeIfHeld()).toBeNull();
    expect(await stubOf(s).attachmentBytesIfHeld()).toBeNull();
  });

  it('a tombstoned object that still has its rows is not held', async () => {
    const { host, s } = await heldScope();
    onTestFinished(async () => host.close());
    await runInDurableObject(objectOf(s), async (_i, state) => {
      await state.storage.put('_substrat_reaped', true);
    });
    expect(await stubOf(s).databaseSizeIfHeld()).toBeNull();
    expect(await host.databaseSizeLocal(s).then(() => undefined, (e: unknown) => errorCodeOf(e))).toBe('conflict');
  });

  // #2544: a copy a carry wiped is refused by every introspection read, as a reaped scope is. Carrying
  // is a Cloudflare-only mechanism (the SQLite host has none), so the case lives here, not in the shared suite.
  it('a wiped carried copy is refused by every introspection read', async () => {
    const { host, s } = await heldScope();
    onTestFinished(async () => host.close());
    const calls = introspectionReadCalls(introspectionReadsOf(host));
    for (const read of Object.values(calls)) expect(await read(s).then(() => undefined, (e: unknown) => errorCodeOf(e))).toBeUndefined();
    const stamp = dumpMetaValue(await host.exportScopeLocal(s), LOAD_STAMP_KEY);
    expect(await host.wipeCarriedLocal(s, stamp, { to: 'elsewhere', at: '2026-10-10T00:00:00.000Z' })).toBe(true);
    for (const [name, read] of Object.entries(calls)) {
      expect([name, await read(s).then(() => undefined, (e: unknown) => errorCodeOf(e))]).toEqual([name, 'conflict']);
    }
  });

  // #2563: the guarded table page refuses that wiped copy, and the carry's tombstone read still answers
  // from it. A held scope answers the same on both.
  it('the tombstone read answers from a wiped carried copy that the guarded table page refuses', async () => {
    const { host, s } = await heldScope();
    onTestFinished(async () => host.close());
    const meta = { table: '_substrat_meta', limit: 100, offset: 0 };
    const keys = (page: { columns: string[]; rows: unknown[][] }) => page.rows.map((r) => r[page.columns.indexOf('key')]);
    expect(keys(await host.readTombstoneTable(s, meta))).not.toContain(CARRIED_AWAY_KEY);
    expect((await host.introspectScopeTable(s, meta)).table).toBe('_substrat_meta');
    const stamp = dumpMetaValue(await host.exportScopeLocal(s), LOAD_STAMP_KEY);
    expect(await host.wipeCarriedLocal(s, stamp, { to: 'elsewhere', at: '2026-10-10T00:00:00.000Z' })).toBe(true);
    expect(await host.introspectScopeTable(s, meta).then(() => undefined, (e: unknown) => errorCodeOf(e))).toBe('conflict');
    expect(keys(await host.readTombstoneTable(s, meta))).toContain(CARRIED_AWAY_KEY);
  });

  // #2544: the introspection reads follow the same shape. Every one of them reaches the object once,
  // by an `IfHeld` method, never by a check followed by a read (two RPCs a reap could land between).
  it('each introspection read makes exactly one RPC to the scope, an IfHeld one', async () => {
    const { host, s } = await heldScope();
    onTestFinished(async () => host.close());
    const calls: string[] = [];
    const real = objectOf(s) as unknown as Record<string, (...args: unknown[]) => unknown>;
    const counted = new Proxy(real, {
      get: (_target, name: string) => (...args: unknown[]) => (calls.push(name), real[name]!(...args)),
    });
    vi.spyOn(host as unknown as { scopeStub(id: ScopeId): unknown }, 'scopeStub').mockReturnValue(counted);
    const window = { since: new Date(Date.now() - 60_000).toISOString(), until: new Date(Date.now() + 60_000).toISOString() };
    await host.facetEventsLocal(s, { groupBy: { kind: 'type' } });
    await host.eventEffectsLocal(s, { eventId: eventId.parse(ulid()) });
    await host.invocationEventsLocal(s, { invocationId: ulid() });
    await host.deadLettersLocal(s, {});
    await host.lifecycleFlowLocal(s, { entityType: 'test-lifecycle', lifecycle: TEST_LIFECYCLE, ...window });
    await host.operationSeriesLocal(s, { moves: [{ entityType: 'test-lifecycle', operation: 'test/move' }], bucketMinutes: 1, since: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), until: new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000).toISOString() });
    await host.eventCauseLocal(s, { eventId: eventId.parse(ulid()) });
    await host.entityHistoryLocal(s, { entityType: 'test-thing', entityId: 'x1' });
    await host.appliedMigrationsLocal(s);
    await host.migrationBookmarksLocal(s);
    await host.introspectScopeTables(s);
    await host.introspectScopeTable(s, { table: '_substrat_outbox', limit: 10, offset: 0 });
    await host.introspectScopeQuery(s, { sql: 'SELECT 1 AS one' });
    await host.undrainedEventsLocal(s, 10);
    await host.redrainCountLocal(s, new Date().toISOString());
    expect(calls).toEqual([
      'facetEventsIfHeld',
      'eventEffectsIfHeld',
      'invocationEventsIfHeld',
      'deadLettersIfHeld',
      'lifecycleFlowIfHeld',
      'operationSeriesIfHeld',
      'eventCauseIfHeld',
      'entityHistoryIfHeld',
      'appliedMigrationsIfHeld',
      'migrationBookmarksIfHeld',
      'introspectTablesIfHeld',
      'introspectTableIfHeld',
      'introspectQueryIfHeld',
      'undrainedEventsReadIfHeld',
      'redrainCountIfHeld',
    ]);
  });
});
// #1706: the peer door, on the DO path — the coordinator threads the platform's `caller` to the
// ScopeDO, which admits it inside its queue on every invoke and acknowledges it; and the
// instance resolution, answered by the ControlPlaneDO's directory. CP-full and co-located, so the
// switch and `peerCovers` reach this namespace's own ScopeDO. DO SQLite is not node SQLite: the
// seat, the switch's marker predicate and the admission's reads run here as they run hosted.

const peerFixture = async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  // #2030: the directory's tenant tuple, then the projection every tenant-level write fans out
  // to the tenant's scopes. No platform verb grants a peer tenant-wide yet, so the fixture does.
  const internals = host as unknown as {
    cp: { writeTenantTuple(t: string, s: string, r: string, o: string, e: string | null): Promise<unknown> };
    fanOut(t: string): Promise<void>;
  };
  const seatTenantGrant = async (tenant: string, subject: string, permission: string) => {
    await internals.cp.writeTenantTuple(tenant, subject, `granted:${permission}`, `tenant:${tenant}`, null);
    await internals.fanOut(tenant);
  };
  return { host, seatTenantGrant, refuseAdminRows, refuseSwitchRecord, cleanup: async () => host.close() };
};
peerContractSuite('adapter-cloudflare', peerFixture);
verticalResolutionContractSuite('adapter-cloudflare', peerFixture);

// #1686: attachments through a capability, on the DO path — the ScopeDO resolves the
// session hash inside its queue and checks each read as `{ capability }`; the coordinator
// holds the bytes. The per-tenant bucket is an in-memory `R2Bucket` slice and the bucket
// manager a stub, as in `attachments.test.ts`: what is under test is the gate, not R2.
const attachmentHostFixture = async (options: AttachmentTextHostOptions = {}) => {
  const objs = new Map<string, { body: Uint8Array; contentType?: string }>();
  const bucket = {
    put: async (key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) => {
      objs.set(key, { body: new Uint8Array(value), contentType: options?.httpMetadata?.contentType });
    },
    get: async (key: string) => {
      const o = objs.get(key);
      if (!o) return null;
      return {
        arrayBuffer: async () => o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength),
        httpMetadata: o.contentType ? { contentType: o.contentType } : undefined,
      };
    },
    delete: async (key: string) => {
      objs.delete(key);
    },
    list: async () => ({ objects: [...objs.keys()].map((key) => ({ key })), truncated: false as const }),
  };
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    blobStores: { create: async (name) => name, remove: async () => {} },
    attachmentBuckets: () => bucket,
    // K-43: the host's parsers, passed in at the composition root.
    attachmentExtractors: options.attachmentExtractors ?? defaultAttachmentExtractors(),
    attachmentTextBounds: options.attachmentTextBounds,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  const forgetAttachmentText = async (_tenant: TenantId, scope: ScopeId) =>
    // Straight to the DO's storage, as a scope from before extraction would hold it.
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_, state) => {
      state.storage.sql.exec('DELETE FROM _substrat_search__attachment_text');
      state.storage.sql.exec(
        'DELETE FROM _substrat_job_runs WHERE module_id = ? AND job = ?',
        ATTACHMENT_TEXT_MODULE,
        ATTACHMENT_TEXT_JOB,
      );
    });
  const plantIndexedAttachments = async (
    _tenant: TenantId,
    scope: ScopeId,
    rows: readonly { id: string; entityId: string; filename: string; text: string }[],
  ) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_, state) => {
      const at = '2026-10-01T00:00:00.000Z';
      for (const r of rows) {
        const bytes = new TextEncoder().encode(r.text).length;
        state.storage.sql.exec(
          `INSERT INTO _substrat_attachments (id, entity_type, entity_id, filename, content_type, size, sha256, visibility, created_by, created_at)
         VALUES (?, 'item', ?, ?, 'text/plain', ?, ?, 'internal', 'planted', ?)`,
          r.id, r.entityId, r.filename, bytes, '0'.repeat(64), at,
        );
        state.storage.sql.exec(
          `INSERT INTO _substrat_search__attachment_text (attachment_id, status, extractor, body, body_bytes, truncated, updated_at)
         VALUES (?, 'indexed', 'text', ?, ?, 0, ?)`,
          r.id, r.text, bytes, at,
        );
      }
    });
  return { host, forgetAttachmentText, plantIndexedAttachments, cleanup: async () => host.close() };
};
capabilityAttachmentContractSuite('adapter-cloudflare', attachmentHostFixture);

// Upload links, on the DO path: the link row and the spend live in the ScopeDO, the bytes in the bucket.
uploadLinkContractSuite('adapter-cloudflare', attachmentHostFixture);

// #2314: the orphan-byte sweep, judged by the real ScopeDO (the tombstone, the insert's and the
// load's refusals, the copy refusal) over a bucket whose puts a test can hold. Its listing
// ignores the prefix, as the shared fake's does, so the sweep's own key filter is what is held.
const orphanSweepFixture = async (): Promise<OrphanSweepFixture> => {
  const objs = new Map<string, { body: Uint8Array; contentType?: string }>();
  let hook: ((key: string) => Promise<void>) | null = null;
  let ahead = 0;
  const raw = {
    put: async (key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) => {
      objs.set(key, { body: new Uint8Array(value), contentType: options?.httpMetadata?.contentType });
    },
    get: async (key: string) => {
      const o = objs.get(key);
      if (!o) return null;
      return {
        arrayBuffer: async () => o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength),
        httpMetadata: o.contentType ? { contentType: o.contentType } : undefined,
      };
    },
    delete: async (key: string) => {
      objs.delete(key);
    },
    list: async () => ({ objects: [...objs.keys()].map((key) => ({ key })), truncated: false as const }),
  };
  const held = {
    ...raw,
    put: async (key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) => {
      await raw.put(key, value, options);
      if (hook) await hook(key);
    },
  };
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    blobStores: { create: async (name) => name, remove: async () => {} },
    attachmentBuckets: () => held,
    orphanSweepClock: () => new Date(Date.now() + ahead).toISOString(),
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    blobs: async () => r2TenantBlobStore(raw),
    afterPut: (next) => {
      hook = next;
    },
    clockAhead: (ms) => {
      ahead = ms;
    },
    // The ledger is the directory's; no public door writes an entry without a move behind it.
    recordCopy: async (tenant, scope, state) => {
      await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), (_, state_) => {
        state_.storage.sql.exec(
          `INSERT INTO scope_script_copies (tenant_id, scope_id, script_ref, move_id, state) VALUES (?, ?, 'old-script', ?, ?)`,
          tenant,
          scope,
          ulid(),
          state,
        );
      });
    },
    // Read twice: the first export of a store stamps it, a write of its own (#1722).
    writeRevision: async (_tenant, scope) => {
      await host.exportScopeStampedLocal(scope);
      return (await host.exportScopeStampedLocal(scope)).revision;
    },
    cleanup: async () => host.close(),
  };
};
orphanSweepContractSuite('adapter-cloudflare', orphanSweepFixture);
// #2315: a retry of a redemption with its Idempotency-Key, against the same held, raw store.
uploadLinkReplayContractSuite('adapter-cloudflare', orphanSweepFixture);

// #113: an attachment refusal crosses the ScopeDO hop as data, so it reaches the caller typed.
attachmentRefusalContractSuite('adapter-cloudflare', attachmentHostFixture);

// #2501: a scope's attachment bytes, from the upload to the storage gauge.
attachmentBytesContractSuite('adapter-cloudflare', attachmentHostFixture);

// #1575: attachment text — the extraction job driven by the coordinator against the real
// ScopeDO, the FTS5 table and its triggers on DO SQLite, the search gate in the DO.
attachmentTextContractSuite('adapter-cloudflare', attachmentHostFixture);

/**
 * #355 regression: `provisionScopeLocal` must apply the bundled modules' migrations
 * AS PART OF provisioning — not lazily on the first `getScope`. The field symptom was
 * a hosted vertical whose scope had roles projected but `_substrat_migrations = 0` and
 * no own tables. This pins the invariant that provision alone lands the schema, so a
 * freshly-provisioned scope is never born content-less.
 */
describe('provisionScopeLocal applies module migrations at provision (#355)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const READ = permissionKey.parse('perm:read');

  it("creates the modules' own tables and journals them — before any getScope", async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    // Read the DO directly: a CP-less host has no `admin.listScopeTables` (it throws).
    // No `getScope`/`invoke` has run against this fresh scope id, so anything present
    // here was applied by `provisionScopeLocal` itself, not by a lazy first open.
    const stub = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as {
      introspectTables(): Promise<ScopeTable[]>;
    };
    const tables = await stub.introspectTables();
    const journal = tables.find((tab) => tab.name === '_substrat_migrations');
    expect(journal?.rowCount ?? 0).toBeGreaterThan(0); // the field bug was rowCount = 0
    expect(tables.some((tab) => !tab.system)).toBe(true); // own tables exist, not just the spine
    await host.close();
  });
});

/**
 * #304, the hosted-vertical case: a CP-less scope enforces + reads its entitlements from the
 * PROJECTION passed at provision, with no control-plane binding. This is the whole point —
 * the coordinator's `cp.tenantHoldsEntitlement` is a trusting no-op here, so the DO's projected
 * view is the only source of truth. Registers `billedMod` on the coordinator so its operations
 * carry `requiredEntitlement` (the DO already closes over it), the one thing the ad-hoc Phase 3
 * host above does not do.
 */
describe('scope-local entitlements — a CP-less hosted vertical (#304)', () => {
  let host: CloudflareScopeHost;
  const owner = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const enforced = scopeId.parse(ulid()); // provisioned WITH 'billed' → strict, held
  const strict = scopeId.parse(ulid()); // provisioned WITH entitlements:[] → strict, NOT held
  const legacy = scopeId.parse(ulid()); // provisioned WITHOUT entitlements → trust-upstream
  const grant = (entitlementKey: string, over: Partial<EntitlementGrant> = {}): EntitlementGrant => ({
    entitlementKey,
    expiresAt: null,
    quota: null,
    plan: null,
    grantedAt: null,
    grantedBy: null,
    ...over,
  });
  const provision = (scopeId: typeof enforced, entitlements?: EntitlementGrant[]) =>
    host.provisionScopeLocal({
      tenantId: t,
      scopeId,
      owner,
      roles: [{ key: 'office-admin', permissions: [permissionKey.parse('billed:use')], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
      entitlements,
    });

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(billedMod); // populates the coordinator's operation→SKU map
    await provision(enforced, [grant('billed', { quota: 250, plan: 'pro' })]);
    await provision(strict, []); // entitlements projected, but 'billed' not among them
    await provision(legacy); // no entitlements projected — pre-#304 shape
  });

  afterAll(async () => host.close());

  it('runs a gated operation and reads the projected grant via ctx.entitlement — no CP', async () => {
    const stub = await host.getScope(owner, t, enforced);
    await expect(stub.invoke<string>('billed/act')).resolves.toBe('ran');
    expect(await stub.invoke('billed/read-entitlement', 'billed')).toEqual({
      key: 'billed',
      plan: 'pro',
      quota: 250,
      expiresAt: null,
    });
  });

  it('fails closed on a projected scope that does NOT hold the SKU (strict enforcement)', async () => {
    const stub = await host.getScope(owner, t, strict);
    await expect(stub.invoke('billed/act')).rejects.toThrow(/not entitled/);
  });

  it('trusts upstream on a scope provisioned before entitlements were projected (no false denial)', async () => {
    const stub = await host.getScope(owner, t, legacy);
    await expect(stub.invoke<string>('billed/act')).resolves.toBe('ran');
  });
});

/**
 * #406: identity links ride the tenant projection, so a scope resolves
 * `(provider, externalId) → principal` from its OWN storage — the runtime identity
 * directory a CP-less vertical never had (its alternative was a login map compiled
 * into the bundle: offboarding by deploy, revocation undone by version rollback).
 * Two delivery paths, both asserted here: the CP-full fan-out on link/unlink, and
 * the CP-less delivery WITH provisioning (#310's channel).
 */
describe('identity-link projection — logins resolve scope-locally (#406)', () => {
  const staff = platformActorId.parse(ulid());
  const PROVIDER = 'oidc:authhero-test';

  describe('CP-full: link/unlink fan out into the tenant’s scopes', () => {
    let host: CloudflareScopeHost;
    const t = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid());
    const erin = principalId.parse(ulid());

    beforeAll(async () => {
      host = new CloudflareScopeHost({
        scope: env.SCOPE,
        controlPlane: env.CONTROL_PLANE,
        secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
        scopeLocalPermissions: true,
      });
      await host.admin.createTenant(staff, { id: t, slug: `id-${t.toLowerCase()}`, name: 'Id Co' });
      await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
      for (const s of [s1, s2]) {
        await host.provisionScope(staff, { tenantId: t, scopeId: s });
        await host.admin.activateScope(staff, t, s);
      }
    });

    afterAll(async () => host.close());

    it('a link lands in every scope of the tenant; an unknown login stays undefined', async () => {
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-erin', principal: erin, tenantId: t });
      expect((await host.resolveIdentityLocal(t, s1, PROVIDER, 'sub-erin'))?.principal).toBe(erin);
      expect((await host.resolveIdentityLocal(t, s2, PROVIDER, 'sub-erin'))?.principal).toBe(erin);
      expect(await host.resolveIdentityLocal(t, s1, PROVIDER, 'sub-nobody')).toBeUndefined();
    });

    it('an unlink fans out — the severed login stops resolving everywhere, durably', async () => {
      await host.admin.unlinkIdentity(staff, t, erin);
      expect(await host.resolveIdentityLocal(t, s1, PROVIDER, 'sub-erin')).toBeUndefined();
      expect(await host.resolveIdentityLocal(t, s2, PROVIDER, 'sub-erin')).toBeUndefined();
      // …and listIdentityLinks (the delivery gather) agrees with the projection.
      expect(await host.admin.listIdentityLinks(staff, t)).toHaveLength(0);
    });

    it('reconcileTenantProjection repairs a scope whose identity projection drifted', async () => {
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-erin', principal: erin, tenantId: t });
      // Simulate a dropped fan-out: wipe s2's identity projection directly.
      const stub = env.SCOPE.get(env.SCOPE.idFromName(s2)) as unknown as {
        applyProjection(
          tenantId: string,
          roles: unknown[],
          tuples: unknown[],
          entitlements?: unknown[],
          scopeTuples?: unknown[],
          identities?: unknown[],
        ): Promise<void>;
      };
      await stub.applyProjection(t, [], [], undefined, undefined, []);
      expect(await host.resolveIdentityLocal(t, s2, PROVIDER, 'sub-erin')).toBeUndefined(); // stale → deny
      await host.reconcileTenantProjection(t);
      expect((await host.resolveIdentityLocal(t, s2, PROVIDER, 'sub-erin'))?.principal).toBe(erin); // repaired
    });
  });

  describe('CP-less: links delivered WITH provisioning, preserved across re-provision', () => {
    let host: CloudflareScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    const frank = principalId.parse(ulid());
    const READ = permissionKey.parse('perm:read');

    const provision = (identityLinks?: { provider: string; externalId: string; principal: typeof owner; scopeId?: typeof s }[]) =>
      host.provisionScopeLocal({
        tenantId: t,
        scopeId: s,
        owner,
        roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
        ownerRoleKey: 'office-admin',
        identityLinks,
      });

    beforeAll(async () => {
      // No `controlPlane` — the null-object stand-in; the ONLY identity source is the projection.
      host = new CloudflareScopeHost({
        scope: env.SCOPE,
        secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      });
    });

    afterAll(async () => host.close());

    it('resolves a delivered link from the scope alone — tenant-level and scope-homed', async () => {
      await provision([
        { provider: PROVIDER, externalId: 'sub-owner', principal: owner },
        { provider: PROVIDER, externalId: 'sub-frank', principal: frank, scopeId: s },
      ]);
      const ownerHit = await host.resolveIdentityLocal(t, s, PROVIDER, 'sub-owner');
      expect(ownerHit?.principal).toBe(owner);
      expect(ownerHit?.scopeId).toBeNull(); // tenant-level home
      const frankHit = await host.resolveIdentityLocal(t, s, PROVIDER, 'sub-frank');
      expect(frankHit?.principal).toBe(frank);
      expect(frankHit?.scopeId).toBe(s); // scope-homed
    });

    it('a re-provision WITHOUT identityLinks preserves them (preserve-on-undefined)', async () => {
      await provision(); // e.g. an older platform re-running the idempotent provision
      expect((await host.resolveIdentityLocal(t, s, PROVIDER, 'sub-owner'))?.principal).toBe(owner);
    });

    it('a re-delivery with the link REMOVED stops it resolving — offboarding without a deploy', async () => {
      await provision([{ provider: PROVIDER, externalId: 'sub-owner', principal: owner }]);
      expect(await host.resolveIdentityLocal(t, s, PROVIDER, 'sub-frank')).toBeUndefined();
      expect((await host.resolveIdentityLocal(t, s, PROVIDER, 'sub-owner'))?.principal).toBe(owner);
    });
  });
});

/**
 * #332: a CP-less scope can be left "role definitions projected, permission_source = 'local',
 * zero tuples" — a scope enforcing nothing but denials, unfixable from inside (the owner is
 * signed in and linked to a principal that holds no role). Two guarantees close the hole:
 * `provisionScopeLocal` writes the owner's grant in the SAME unit as the enforcement flip (so a
 * partial write can never brick it), and a reconcile — re-running provisioning with the owner the
 * vertical still remembers — repairs a scope that reached the bricked state another way (e.g. a
 * promote that recreated the scope-DO storage, #321).
 */
describe('#332 — recovery from a scope bricked to zero tuples (CP-less)', () => {
  let host: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const ADMIN = permissionKey.parse('perm:admin');

  const provision = (scope: typeof s): Promise<unknown> =>
    host.provisionScopeLocal({
      tenantId: t,
      scopeId: scope,
      owner,
      roles: [{ key: 'office-admin', permissions: [ADMIN], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  const probe = async (): Promise<boolean> =>
    (await (await host.getScope(owner, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: ADMIN }))
      .allowed;

  // Raw DO stub — reproduce the brick and read the enforcement flag exactly as #332 diagnosed it.
  type RawStub = {
    revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean>;
    applyProjection(
      tenantId: string,
      roles: { role_key: string; permissions: string; source: string }[],
      tuples: unknown[],
      entitlements?: unknown[],
      scopeTuples?: { subject: string; relation: string; object: string; expires_at: string | null }[],
    ): Promise<void>;
    introspectQuery(sql: string): Promise<{ rows: unknown[][] }>;
  };
  const rawStub = (scope: string): RawStub => env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as RawStub;
  const permissionSource = async (scope: string): Promise<string | undefined> =>
    (
      await rawStub(scope).introspectQuery("SELECT value FROM _substrat_meta WHERE key = 'permission_source'")
    ).rows[0]?.[0] as string | undefined;

  beforeAll(async () => {
    // No control plane — the CP-less hosted-vertical shape the issue is about.
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await provision(s);
  });
  afterAll(async () => host.close());

  it('provisions atomically — owner served and enforcement flipped to local in one unit', async () => {
    expect(await probe()).toBe(true);
    expect(await permissionSource(s)).toBe('local');
  });

  it('reproduces the lockout: with the owner grant revoked, every check denies', async () => {
    // A scope-DO storage wipe leaves role defs projected + source = 'local' but no principal→role
    // tuple. Tombstoning the owner grant is that exact state — the scope enforces against nothing.
    await rawStub(s).revokeTuple(`principal:${owner}`, `role:office-admin`, `scope:${s}`, new Date().toISOString());
    expect(await probe()).toBe(false);
  });

  it('a reconcile (re-provision with the owner the vertical still knows) restores access', async () => {
    await provision(s); // what the builder-triggered /internal/reconcile does after reading owner_of_record
    expect(await probe()).toBe(true);
  });

  it('applyProjection refuses to switch on strict enforcement against an empty tuple table', async () => {
    const fresh = scopeId.parse(ulid());
    const roleDef = { role_key: 'office-admin', permissions: JSON.stringify([ADMIN]), source: 'vertical' };
    // Roles projected but nobody holds one → the flip is refused (else every check fails closed).
    await rawStub(fresh).applyProjection(t, [roleDef], []);
    expect(await permissionSource(fresh)).toBeUndefined();
    // The same projection carrying the owner grant in the same unit → now safe, and it flips.
    await rawStub(fresh).applyProjection(t, [roleDef], [], undefined, [
      { subject: `principal:${owner}`, relation: 'role:office-admin', object: `scope:${fresh}`, expires_at: null },
    ]);
    expect(await permissionSource(fresh)).toBe('local');
  });
});

/**
 * #1659: a reconcile keeps an operator's revoke. `provisionScopeLocal` SEATS its tuples —
 * the owner's role, each `system:<module>` schedule grant, each connection grant — so a
 * missing one is recreated (#332's repair) and a revoked one is left revoked. It used to
 * `INSERT OR REPLACE … revoked_at = NULL`, and since #1653 every listed promote reconciles
 * every install, so the schedule kill switch and a removed owner came back within one
 * rollout, silently.
 *
 * The one exception is the owner-of-record's seat on a scope that would otherwise hold no
 * EFFECTIVE role grant (a live tuple whose role the vertical still defines): the #332
 * lockout, which a reconcile exists to repair — so the #332 block
 * above stands exactly as it was written, and the twins here pin both sides of it.
 *
 * Every re-grant path stays a grant: `assignScopeRole` and `connectorGrantLocal` clear a
 * tombstone, because a re-grant that silently kept one would lock out someone an admin just
 * let back in.
 */
describe('#1659 — a reconcile keeps an operator’s revoke (CP-less)', () => {
  let host: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  const ADMIN = permissionKey.parse('perm:admin');
  const READ = permissionKey.parse('perm:read');
  /** A fixed revoke instant, so "the tombstone was left alone" is an equality, not a guess. */
  const REVOKED_AT = '2026-09-01T00:00:00.000Z';

  const OFFICE_ADMIN: RoleDefinition = { key: 'office-admin', permissions: [ADMIN, READ], source: 'vertical' };
  /** A second role the vertical defines — until a later version drops it (the stale case). */
  const READER: RoleDefinition = { key: 'reader', permissions: [READ], source: 'vertical' };
  const provision = (
    scope: string,
    connectionGrants?: ProjectedConnectionGrant[],
    roles: RoleDefinition[] = [OFFICE_ADMIN],
  ): Promise<unknown> =>
    host.provisionScopeLocal({
      tenantId: t,
      scopeId: scopeId.parse(scope),
      owner,
      roles,
      ownerRoleKey: 'office-admin',
      connectionGrants,
    });
  const probe = async (who: typeof owner, scope: string, perm: typeof ADMIN = ADMIN): Promise<boolean> =>
    (
      await (await host.getScope(who, t, scopeId.parse(scope))).invoke<{ allowed: boolean }>('perm/probe', {
        permission: perm,
      })
    ).allowed;
  /** Whether the schedule ran or was even considered — 0 ⇔ the grant-is-the-switch said no. */
  const scheduleConsidered = async (scope: string): Promise<number> => {
    const report = await host.runDueSchedules(SCHED, t, scopeId.parse(scope));
    expect(report.errors).toEqual([]);
    return report.fired + report.skipped;
  };

  type RawStub = {
    revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean>;
    seatTuple(subject: string, relation: string, object: string, expiresAt: string | null): Promise<void>;
    applyProjection(
      tenantId: string,
      roles: { role_key: string; permissions: string; source: string }[],
      tuples: unknown[],
      entitlements?: unknown[],
      scopeTuples?: {
        subject: string;
        relation: string;
        object: string;
        expires_at: string | null;
        lockout_reseat?: boolean;
      }[],
    ): Promise<void>;
    importDump(tables: unknown[]): Promise<void>;
    listConnectionGrants(now: string): Promise<{ subject: string; relation: string; expires_at: string | null }[]>;
    introspectQuery(sql: string): Promise<{ rows: unknown[][] }>;
  };
  const rawStub = (scope: string): RawStub => env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as RawStub;
  /** The tuple's row as stored — `undefined` when there is no row at all. */
  const tupleRow = async (
    scope: string,
    subject: string,
    relation: string,
  ): Promise<{ revokedAt: unknown; expiresAt: unknown } | undefined> => {
    const row = (
      await rawStub(scope).introspectQuery(
        `SELECT revoked_at, expires_at FROM _substrat_tuples
          WHERE subject = '${subject}' AND relation = '${relation}' AND object = 'scope:${scope}'`,
      )
    ).rows[0];
    return row ? { revokedAt: row[0], expiresAt: row[1] } : undefined;
  };
  const permissionSource = async (scope: string): Promise<string | undefined> =>
    (
      await rawStub(scope).introspectQuery("SELECT value FROM _substrat_meta WHERE key = 'permission_source'")
    ).rows[0]?.[0] as string | undefined;

  beforeAll(async () => {
    // No control plane — the hosted-vertical shape `/internal/reconcile` runs on.
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    // Its schedule is what puts a `system:@test/sched` grant into the provisioned tuples.
    host.registerModule(scheduleMod);
  });
  afterAll(async () => host.close());

  it('a revoked `system:` schedule grant stays revoked across a reconcile — the kill switch holds', async () => {
    const s = ulid();
    await provision(s);
    expect(await scheduleConsidered(s)).toBeGreaterThan(0); // positive control: the grant is live
    expect(await rawStub(s).revokeTuple(`system:${SCHED}`, 'granted:sched:tick', `scope:${s}`, REVOKED_AT)).toBe(
      true,
    );
    expect(await scheduleConsidered(s)).toBe(0); // the switch is off…

    await provision(s); // …what every listed promote now runs on every install (#1653)
    expect(await scheduleConsidered(s)).toBe(0); // …and stays off
    // The tombstone itself is untouched — same instant, not a fresh revoke over a re-grant.
    expect(await tupleRow(s, `system:${SCHED}`, 'granted:sched:tick')).toEqual({
      revokedAt: REVOKED_AT,
      expiresAt: null,
    });
    // The rest of the reconcile still happened: the owner is seated and served.
    expect(await probe(owner, s)).toBe(true);
  });

  it('a revoked owner stays revoked when another principal holds a live role — a hand-over holds', async () => {
    const s = ulid();
    const successor = principalId.parse(ulid());
    await provision(s);
    await host.assignScopeRole(scopeId.parse(s), successor, 'office-admin'); // successor seated FIRST
    expect(await host.revokeScopeRole(scopeId.parse(s), owner, 'office-admin')).toBe(true);
    const revoked = await tupleRow(s, `principal:${owner}`, 'role:office-admin');
    expect(revoked?.revokedAt).toEqual(expect.any(String));
    expect(await probe(owner, s)).toBe(false);

    await provision(s); // the reconcile re-sources the SAME owner from owner_of_record
    expect(await probe(owner, s)).toBe(false); // the revoke stands
    expect(await probe(successor, s)).toBe(true); // and the successor is untouched
    expect(await tupleRow(s, `principal:${owner}`, 'role:office-admin')).toEqual(revoked);

    // The re-grant guarantee: an explicit assign is a grant, whatever the reconcile kept.
    await host.assignScopeRole(scopeId.parse(s), owner, 'office-admin');
    expect(await probe(owner, s)).toBe(true);
    await provision(s); // and a later reconcile does not take a live seat away
    expect(await probe(owner, s)).toBe(true);
  });

  it('declared services retain their roles while a human lockout is repaired (#1896)', async () => {
    const s = scopeId.parse(ulid());
    const service = principalId.parse(ulid());
    const local = new CloudflareScopeHost({
      scope: env.SCOPE,
      servicePrincipals: async (tenant, scope) => {
        expect(tenant).toBe(t);
        expect(scope).toBe(s);
        return [service];
      },
    });
    local.registerModule(scheduleMod);
    const reconcile = () => local.provisionScopeLocal({ tenantId: t, scopeId: s, owner, roles: [OFFICE_ADMIN], ownerRoleKey: 'office-admin' });
    await reconcile();
    await local.assignScopeRole(s, service, 'office-admin');
    await local.revokeScopeRole(s, owner, 'office-admin');
    expect(await probe(owner, s)).toBe(false);
    expect(await probe(service, s)).toBe(true);
    await reconcile();
    expect(await probe(owner, s)).toBe(true);
    expect(await probe(service, s)).toBe(true);
    const successor = principalId.parse(ulid());
    await local.assignScopeRole(s, successor, 'office-admin');
    await local.revokeScopeRole(s, owner, 'office-admin');
    await reconcile();
    expect(await probe(owner, s)).toBe(false);
    expect(await probe(successor, s)).toBe(true);
  });

  it('a revoked owner with NO other live holder is re-seated — the #332 lockout is still repaired', async () => {
    const s = ulid();
    await provision(s);
    // The schedule switch is turned off too, so the one reconcile below answers both halves:
    // the lockout exception is the OWNER's seat, not a licence to re-seat everything.
    await rawStub(s).revokeTuple(`system:${SCHED}`, 'granted:sched:tick', `scope:${s}`, REVOKED_AT);
    expect(await host.revokeScopeRole(scopeId.parse(s), owner, 'office-admin')).toBe(true);
    expect(await probe(owner, s)).toBe(false); // locked out: nobody here passes a check

    await provision(s);
    expect(await probe(owner, s)).toBe(true); // re-seated
    expect(await tupleRow(s, `principal:${owner}`, 'role:office-admin')).toEqual({
      revokedAt: null,
      expiresAt: null,
    });
    expect(await scheduleConsidered(s)).toBe(0); // the kill switch did NOT come back with it
  });

  it('a revoked owner whose only other holder has a role the vertical DROPPED is re-seated — a stale grant is no holder', async () => {
    // Review finding on this PR: a live tuple for a role the vertical no longer defines passes
    // no check (the checker expands a role only through its definition), so it must not count
    // as "someone else holds a role" — or this scope stays locked out, which is the one case
    // the owner re-seat exists for.
    const s = ulid();
    const member = principalId.parse(ulid());
    await provision(s, undefined, [OFFICE_ADMIN, READER]); // this version defines `reader`
    await host.assignScopeRole(scopeId.parse(s), member, 'reader');
    expect(await probe(member, s, READ)).toBe(true); // positive control: `reader` is effective here
    expect(await host.revokeScopeRole(scopeId.parse(s), owner, 'office-admin')).toBe(true);
    expect(await probe(owner, s)).toBe(false);

    await provision(s, undefined, [OFFICE_ADMIN]); // a later version dropped `reader`
    expect(await probe(member, s, READ)).toBe(false); // the member's live tuple is now stale: it grants nothing
    expect(await probe(owner, s)).toBe(true); // so nobody could act here, and the owner is re-seated
  });

  it('…and its twin: the other holder’s role is still defined, so the owner’s revoke stands', async () => {
    const s = ulid();
    const member = principalId.parse(ulid());
    await provision(s, undefined, [OFFICE_ADMIN, READER]);
    await host.assignScopeRole(scopeId.parse(s), member, 'reader');
    expect(await host.revokeScopeRole(scopeId.parse(s), owner, 'office-admin')).toBe(true);

    await provision(s, undefined, [OFFICE_ADMIN, READER]); // same roles: `reader` is still current
    expect(await probe(member, s, READ)).toBe(true); // an effective holder…
    expect(await probe(owner, s)).toBe(false); // …so the revoke holds
  });

  it('the #332 flip guard reads the same predicate: a STALE-only role tuple refuses the flip', async () => {
    const s = ulid();
    const holder = `principal:${principalId.parse(ulid())}`;
    const roleDef = { role_key: 'office-admin', permissions: JSON.stringify([ADMIN]), source: 'vertical' };
    await rawStub(s).seatTuple(holder, 'role:retired', `scope:${s}`, null); // live, but for no defined role
    await rawStub(s).applyProjection(t, [roleDef], [], undefined, []);
    expect(await permissionSource(s)).toBeUndefined(); // refused: nobody here passes a check

    // The twin: the same holder in a role the projection defines, and the flip goes through.
    await rawStub(s).seatTuple(holder, 'role:office-admin', `scope:${s}`, null);
    await rawStub(s).applyProjection(t, [roleDef], [], undefined, []);
    expect(await permissionSource(s)).toBe('local');
  });

  it('a wiped scope is recreated by a reconcile — a MISSING row is not a revoke (#332)', async () => {
    const s = ulid();
    await provision(s);
    // Storage recreated empty (#321's shape): an empty dump drops every table, and the spine
    // comes back with no rows. Not `destroyStorage`, which is a reap and fences writes off.
    await rawStub(s).importDump([]);
    expect(await tupleRow(s, `principal:${owner}`, 'role:office-admin')).toBeUndefined();
    expect(await tupleRow(s, `system:${SCHED}`, 'granted:sched:tick')).toBeUndefined();
    expect(await probe(owner, s)).toBe(false); // negative control: the wipe really took the seat

    await provision(s);
    expect(await probe(owner, s)).toBe(true);
    expect(await scheduleConsidered(s)).toBeGreaterThan(0);
    expect(await tupleRow(s, `system:${SCHED}`, 'granted:sched:tick')).toEqual({ revokedAt: null, expiresAt: null });
  });

  it('a revoked connection grant stays revoked on re-delivery; `connectorGrantLocal` grants it again', async () => {
    const s = ulid();
    const conn = connectionId.parse(ulid());
    const LATER = '2099-01-01T00:00:00.000Z';
    const LATEST = '2099-06-01T00:00:00.000Z';
    const live = async (): Promise<string[]> =>
      (await rawStub(s).listConnectionGrants(new Date().toISOString())).map((g) => `${g.subject} ${g.expires_at}`);
    const delivered = (expiresAt: string): ProjectedConnectionGrant[] => [
      projectedConnectionGrant.parse({ connectionId: conn, permission: READ, expiresAt }),
    ];

    await provision(s, delivered(LATER));
    expect(await live()).toEqual([`connection:${conn} ${LATER}`]);
    // A LIVE grant's expiry still follows the platform's on re-delivery (#592), as before.
    await provision(s, delivered(LATEST));
    expect(await live()).toEqual([`connection:${conn} ${LATEST}`]);

    await rawStub(s).revokeTuple(`connection:${conn}`, `granted:${READ}`, `scope:${s}`, REVOKED_AT);
    await provision(s, delivered(LATER));
    expect(await live()).toEqual([]);
    // Untouched, expiry included — the re-delivery's LATER did not land on the tombstone.
    expect(await tupleRow(s, `connection:${conn}`, `granted:${READ}`)).toEqual({
      revokedAt: REVOKED_AT,
      expiresAt: LATEST,
    });

    await host.connectorGrantLocal(conn, scopeId.parse(s), READ, LATER); // the explicit grant
    expect(await live()).toEqual([`connection:${conn} ${LATER}`]);
  });

  it('the invite-create rollback still holds: a revoked invitee seat stays revoked through a reconcile', async () => {
    // `vertical-auth`'s invite route grants a freshly minted principal, and revokes it when
    // the invite row cannot be written. Provisioning never seated that principal, so no
    // reconcile brings it back — before this change or after it.
    const s = ulid();
    const invitee = principalId.parse(ulid());
    await provision(s);
    await host.assignScopeRole(scopeId.parse(s), invitee, 'office-admin');
    expect(await host.revokeScopeRole(scopeId.parse(s), invitee, 'office-admin')).toBe(true);
    await provision(s);
    expect(await probe(invitee, s, READ)).toBe(false);
    expect(await probe(owner, s)).toBe(true);
  });

  it('the #332 flip guard: a KEPT tombstone is no live grant, so the flip stays refused', async () => {
    // Zero live grants, reached the #1659 way: the only role tuple is revoked, and the
    // projection names it again. Seating keeps the tombstone, so the guard must still say no.
    const s = ulid();
    const roleDef = { role_key: 'office-admin', permissions: JSON.stringify([ADMIN]), source: 'vertical' };
    const ownerSeat = { subject: `principal:${owner}`, relation: 'role:office-admin', object: `scope:${s}`, expires_at: null };
    await rawStub(s).seatTuple(ownerSeat.subject, ownerSeat.relation, ownerSeat.object, null);
    await rawStub(s).revokeTuple(ownerSeat.subject, ownerSeat.relation, ownerSeat.object, REVOKED_AT);

    await rawStub(s).applyProjection(t, [roleDef], [], undefined, [ownerSeat]);
    expect(await permissionSource(s)).toBeUndefined(); // refused
    expect((await tupleRow(s, ownerSeat.subject, ownerSeat.relation))?.revokedAt).toBe(REVOKED_AT);

    // The twin: the same projection marking it as the lockout seat re-seats it in the same
    // unit, and the guard — reading the same predicate — now lets the flip through.
    await rawStub(s).applyProjection(t, [roleDef], [], undefined, [{ ...ownerSeat, lockout_reseat: true }]);
    expect(await permissionSource(s)).toBe('local');
    expect((await tupleRow(s, ownerSeat.subject, ownerSeat.relation))?.revokedAt).toBeNull();
  });
});

/**
 * #1659 on the CP-FULL path: `provisionScope` seats each module's `system:` grant through
 * the same statement, so a re-provision keeps a revoked grant revoked — and `grantToSystem`,
 * the explicit grant, clears its tombstone. The pure adapter asserts the same.
 *
 * The tombstone here is a raw write of ONE tuple, not the kill switch: with no OFF marker
 * the gate reads grants alone, which is why the re-grant turns these schedules back on.
 * The switch proper (#1666, `revokeFromSystem`) is NOT undone by a grant — that is pinned
 * in `systemSwitchContractSuite`.
 */
describe('#1659 — a re-provision keeps a revoked schedule grant (CP-full)', () => {
  it('re-provision leaves the revoke; `grantToSystem` re-grants; a wiped grant is recreated', async () => {
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const SCHED = moduleId.parse('@test/sched');
    const REVOKED_AT = '2026-09-01T00:00:00.000Z';
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    const raw = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as {
      revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean>;
      importDump(tables: unknown[]): Promise<void>;
      introspectQuery(sql: string): Promise<{ rows: unknown[][] }>;
    };
    const revokedAt = async (): Promise<unknown> =>
      (
        await raw.introspectQuery(
          `SELECT revoked_at FROM _substrat_tuples WHERE subject = 'system:${SCHED}' AND relation = 'granted:sched:tick'`,
        )
      ).rows[0]?.[0];
    const considered = async (): Promise<number> => {
      const report = await host.runDueSchedules(SCHED, t, s);
      expect(report.errors).toEqual([]);
      return report.fired + report.skipped;
    };
    try {
      await host.admin.createTenant(staff, { id: t, slug: `seat-${t.toLowerCase()}`, name: 'Seat Co' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
      await host.admin.activateScope(staff, t, s);
      expect(await considered()).toBeGreaterThan(0);

      await raw.revokeTuple(`system:${SCHED}`, 'granted:sched:tick', `scope:${s}`, REVOKED_AT);
      expect(await considered()).toBe(0);
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
      expect(await considered()).toBe(0); // the kill switch survived the re-provision
      expect(await revokedAt()).toBe(REVOKED_AT);

      await host.admin.grantToSystem(staff, {
        moduleId: SCHED,
        permission: permissionKey.parse('sched:tick'),
        node: { tenantId: t, scopeId: s },
        grantedBy: staff,
      });
      expect(await revokedAt()).toBeNull(); // the explicit grant cleared the tombstone
      expect(await considered()).toBeGreaterThan(0);

      await raw.importDump([]); // storage recreated: the row is gone, not revoked
      expect(await revokedAt()).toBeUndefined();
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
      expect(await revokedAt()).toBeNull();
      expect(await considered()).toBeGreaterThan(0);
    } finally {
      await host.close();
    }
  });
});

/**
 * #1743, the interleaving the shared suite cannot drive: a scope switched OFF between the
 * tenant-level grant's CHECK and its WRITE. The shared suite awaits each call in turn, so
 * a host that read the record in one control-plane call and wrote the tenant tuple in a
 * second would pass it. Here the OFF is driven from inside that gap: the control-plane stub
 * runs it immediately before forwarding the grant's WRITE call — whichever method that is.
 *
 * Today the check and the write are ONE call (`ControlPlaneDO.writeTenantSystemGrant`, a
 * synchronous method, so nothing can run inside it), and the injected OFF necessarily lands
 * before that unit: the grant must be refused. A host split into read-then-write would have
 * already read "nothing off" when the OFF lands, and would write — this goes red.
 */
describe('#1743 — an OFF landing between a tenant grant’s check and its write never lets it through', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  const WRITES = new Set(['writeTenantTuple', 'writeTenantSystemGrant']);

  it('the OFF is injected before the write call, and the grant is refused', async () => {
    let beforeWrite: (() => Promise<unknown>) | null = null;
    const hooked = {
      idFromName: (name: string) => env.CONTROL_PLANE.idFromName(name),
      get: (id: DurableObjectId) => {
        const real = env.CONTROL_PLANE.get(id) as unknown as Record<string, (...a: unknown[]) => unknown>;
        return new Proxy(real, {
          get: (target, prop) => {
            const value = target[prop as string];
            if (typeof value !== 'function') return value;
            return async (...a: unknown[]) => {
              // A write called through `reply` (#2526) names its method in the first argument.
              const method = prop === 'reply' ? String(a[0]) : String(prop);
              if (beforeWrite && WRITES.has(method)) {
                const hook = beforeWrite;
                beforeWrite = null; // one-shot: the OFF's own calls pass straight through
                await hook();
              }
              return target[prop as string]!(...a);
            };
          },
        });
      },
    } as unknown as DurableObjectNamespace;
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: hooked,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const tenantGrant = () =>
      host.admin.grantToSystem(staff, {
        moduleId: SCHED,
        permission: permissionKey.parse('sched:admin'),
        node: { tenantId: t, scopeId: null },
        grantedBy: staff,
      });
    const node = { tenantId: t, scopeId: s };
    try {
      await host.admin.createTenant(staff, { id: t, slug: `gap-${t.slice(-10).toLowerCase()}`, name: 'Gap' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      await host.provisionScope(staff, node);
      await host.admin.activateScope(staff, t, s);

      let injected = false;
      beforeWrite = async () => {
        injected = true;
        await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'lands in the gap' });
      };
      const refused = await tenantGrant().then(
        () => null,
        (e: unknown) => e,
      );
      expect(injected).toBe(true); // the OFF really ran before the write call
      expect(errorCodeOf(refused)).toBe('conflict');
      expect(String(refused)).toContain(s);
      // Nothing was granted: no audit row, and restoring the scope lets the SAME grant in.
      expect(await host.admin.auditLog(staff, { tenantId: t, action: ['grantToSystem'] })).toEqual([]);
      await host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'resolved' });
      await tenantGrant();
      expect(await host.admin.auditLog(staff, { tenantId: t, action: ['grantToSystem'] })).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  it('the check-and-write is one SYNCHRONOUS DO method, so nothing can interleave inside it', async () => {
    // A DO runs one event at a time and yields only at an await, so a synchronous method is
    // indivisible. Pinned: the method answers a value, not a promise — making it async (the
    // only way to put a gap inside it) turns this red.
    const t = tenantId.parse(ulid());
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane'));
    const answer = await runInDurableObject(stub, (instance: unknown) => {
      const r = (
        instance as { writeTenantSystemGrant(t: string, m: string, rel: string, x: string | null): unknown }
      ).writeTenantSystemGrant(t, '@test/none', 'granted:none:x', null);
      return { isPromise: r instanceof Promise, value: Array.isArray(r) ? r : null };
    });
    expect(answer).toEqual({ isPromise: false, value: [] });
  });
});

/**
 * What an operation failure carries out of the ScopeDO — measured against workerd,
 * because the comment that used to describe it was wrong twice.
 *
 * Every other error test in the repo runs in one isolate, where the class survives and
 * `instanceof` works. That is exactly why the production bug (`instanceof
 * PermissionDenied` false on the Cloudflare adapter, forcing verticals to regex the
 * message) stayed invisible: nothing crossed the hop in a test.
 *
 * The measurement that settled the design: a THROW carries its message and nothing
 * else. `name` is not a second channel — setting it folds it into the message as
 * `"<name>: <message>"` and resets `name` to `'Error'`. So a failure crosses as a
 * VALUE now (#113 §3): the DO returns `{ failure }` and the coordinator rethrows a
 * rebuilt error, which is the only shape that keeps the code and its extensions.
 */
describe('what an operation failure carries across the ScopeDO boundary', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const nobody = principalId.parse(ulid()); // holds no role anywhere
  const PERM_USE = permissionKey.parse('perm:use');

  let host: CloudflareScopeHost;

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(permMod);
    await host.admin.createTenant(staff, {
      id: t,
      slug: `taxonomy-${ulid().toLowerCase().slice(0, 8)}`,
      name: 'Taxonomy',
    });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
  });

  const refused = async (): Promise<Error> => {
    const stub = await host.getScope(nobody, t, s);
    return stub.invoke('perm/authorized-emit', { permission: PERM_USE }).then(
      () => {
        throw new Error('the invoke should have been refused');
      },
      (err: Error) => err,
    );
  };

  it('delivers the message verbatim, with no class name folded into it', async () => {
    const err = await refused();
    expect(err.message).toBe('permission denied: perm:use');
    // The shapes a message-encoded carrier would leave behind. Either one reaching here
    // means every log line and UI string on this path just changed.
    expect(err.message).not.toMatch(/^PermissionDenied:/);
    expect(err.message).not.toContain('Substrat.');
  });

  // The whole point of the envelope, and the production bug it closes.
  it('delivers the code and the name, which a throw could not', async () => {
    const err = await refused();
    expect(errorCodeOf(err)).toBe('permission_denied');
    expect(err.name).toBe('PermissionDenied');
  });

  it('classifies to the same status a same-isolate throw would', async () => {
    const err = await refused();
    // A transport no longer has to know the class to get here — which is what lets
    // `vertical-host` stop matching on message text (its own suite covers that end).
    expect(toProblem(err).status).toBe(403);
  });

  // Deliberately still false, and documented as such: contracts cannot import the
  // kernel, so the rebuilt error is a SubstratError wearing the original name. Every
  // consumer in the repo reads the code or the name; none reads the constructor.
  it('does not resurrect the original class, and does not need to', async () => {
    const err = await refused();
    expect(err instanceof PermissionDenied).toBe(false);
    expect(err).toBeInstanceOf(Error);
  });

  /**
   * The compat claim, exercised.
   *
   * Everything above goes through the coordinator, which always asks for the envelope —
   * so without this, the `failureEnvelope`-absent branch is reached by no test at all,
   * and the argument that makes this change safe to deploy ("an old ScopeDO ignores the
   * flag and throws exactly as it always did") would be an assertion about code nothing
   * runs. This calls the DO directly, the way an older coordinator would.
   */
  describe('a caller that does not ask for the envelope', () => {
    const rawInvoke = (scope: string) =>
      env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as {
        invoke(
          operation: string,
          input: unknown,
          principal: string,
          tenantId: string,
          scopeId: string,
          connectionId?: string,
          requiredEntitlement?: string,
          systemModuleId?: string,
          failureEnvelope?: boolean,
        ): Promise<{ result: unknown; platformRequests: number; failure?: unknown }>;
      };

    it('still gets a throw, and a message it can still match on', async () => {
      const thrown = await rawInvoke(s)
        .invoke('perm/authorized-emit', { permission: PERM_USE }, nobody, t, s)
        .then(
          () => undefined,
          (err: Error) => err,
        );

      expect(thrown, 'the legacy path must reject, never resolve').toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('permission denied: perm:use');
    });

    it('never receives a failure smuggled into a resolved result', async () => {
      // The dangerous skew, ruled out: an older coordinator reads `.result` off the
      // resolved value. If the DO answered with an envelope here, a denial would read
      // as a successful operation returning undefined.
      const settled = await rawInvoke(s)
        .invoke('perm/authorized-emit', { permission: PERM_USE }, nobody, t, s)
        .then(
          (value) => ({ resolved: true as const, value }),
          () => ({ resolved: false as const }),
        );
      expect(settled.resolved).toBe(false);
    });

    it('answers the envelope only when it is asked to', async () => {
      const envelope = await rawInvoke(s).invoke(
        'perm/authorized-emit',
        { permission: PERM_USE },
        nobody,
        t,
        s,
        undefined,
        undefined,
        undefined,
        true,
      );
      expect(envelope.failure).toBeDefined();
      expect(envelope.result).toBeUndefined();
    });
  });
});

// #827: the derived FTS index, on the substrate where it is least obvious that it
// works. Durable Object SQLite ships FTS5, but it also runs every statement past a
// regulator that decides whether a trigger may fire at all — so "it works in
// better-sqlite3" is not evidence about this host, and this suite is the evidence.
searchContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #901: the entity-version read on the DO host. The query is ordinary SQL, but
// the index behind it is spine DDL that workerd's regulator has to permit — the
// same reason every other derived-DDL suite runs on both hosts.
entityVersionContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #800: the supported read of an entity's history. The DEFAULT checker, because
// the history half asserts K-34 `authorization` — the checks the emitting
// operation passed — and an allow-all cannot answer a real `ctx.check` at all
// (it interpolates the subject, which is a structured actor).
timelineContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      });
  // #1242: env is script-wide, so every ScopeDO in this harness runs "as" the
  // wrangler var — declared here so the suite asserts history surfaces it.
  return { host, versionId: env.SUBSTRAT_VERSION_ID, cleanup: async () => host.close() };
});

// #811: `ctx.page` on the DO host — same suite, and the only place the derived
// index DDL meets workerd's regulator.
listContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #2066: the journal's SQL digest on the DO host — the column, the ALTER and the refusal in
// workerd's SQLite. `listMod` is in `contractTestModules`, so the ScopeDO carries it at code time.
migrationDigestContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #119: archive and trash on the DO host — the derived ALTERs and the partial indexes meet
// workerd's regulator here and nowhere else. The DEFAULT tuple checker, for the pure suite's
// reason: the kernel's check of the declared key is the property under test. `stateMod` is in
// `contractTestModules`, so the ScopeDO carries it at code time.
entityStateContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    return { host, cleanup: async () => host.close() };
  },
  // The scope DO's own storage, past `ctx.sql` — the trigger proven in workerd's SQLite.
  async (_tenant, scope, sql, params = []) => {
    await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_, state) => {
      state.storage.sql.exec(sql, ...(params as SqlStorageValue[]));
    });
  },
);

const scopeStub = (scope: string) => env.SCOPE.get(env.SCOPE.idFromName(scope));
// #2090: an authored rebuild of a table the kernel derived onto, on the DO's migration pass — the re-derived
// triggers and partial indexes proven in workerd's SQLite. `rebuildMod` is in
// `contractTestModules`, so the ScopeDO carries it at code time.
entityStateMigrationContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    return { host, cleanup: async () => host.close() };
  },
  {
    sql: (_tenant, scope, sql) =>
      runInDurableObject(scopeStub(scope), (_, state) =>
        state.storage.sql.exec(sql).toArray() as Record<string, unknown>[],
      ),
    // The journal row, and the instance's `applied` set that `retryMigrations` reads pending from.
    forget: (_tenant, scope, moduleId, version) =>
      runInDurableObject(scopeStub(scope), (instance, state) => {
        state.storage.sql.exec('DELETE FROM _substrat_migrations WHERE module_id = ? AND version = ?', moduleId, version);
        (instance as unknown as { applied: Set<string> }).applied.delete(`${moduleId}@${version}`);
      }),
  },
);

// #1773: the handlers the platform derives from a declaration, on a Durable Object's SQL. The
// DEFAULT tuple checker, for the pure suite's reason. `derivedMod` is in `contractTestModules`.
derivedHandlersContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #2166: the updated stamps the host holds on every write, on this adapter's SQL — a Durable Object's. `stampsMod` is in `contractTestModules`.
updatedStampsContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #119 PR 2: the host's trash refusal, the link refusal and the purge horizon, in workerd. The
// DEFAULT tuple checker, for the pure suite's reason. `trashMod` is in `contractTestModules`.
entityTrashContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    return { host, cleanup: async () => host.close() };
  },
  async (_tenant, scope, sql, params = []) => {
    await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_, state) => {
      state.storage.sql.exec(sql, ...(params as SqlStorageValue[]));
    });
  },
  {
    // Every suite in this file shares one control-plane directory, so a full platform sweep walks
    // all of their scopes. The preview case runs on the pure adapter, whose fixture owns its
    // directory; the exclusion it holds is the kernel sweep's, the same code here.
    platformSweep: false,
    // The Durable Object's own RPC, as any worker holding the SCOPE namespace binding reaches it —
    // pinned to the live instance, so the system door's own check passes and only purge is tested.
    direct: (() => {
      const scopeDo = (scope: ScopeId) => env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as {
        systemDoorState(moduleId: string): Promise<{ instance: string }>;
        invoke(...args: unknown[]): Promise<{ failure?: Parameters<typeof fromWireFailure>[0] }>;
        runPurgeSweep(operation: string, tenant: TenantId, scope: ScopeId, instance: string): Promise<{ purged: number; skipped: number; held?: string; errors: { entityId: string; error: string }[] }>;
        setLifecycle(next: unknown, tenant?: TenantId): Promise<unknown>;
        markCopy(): Promise<boolean>;
      };
      let revision = 0;
      return {
        claimPurge: async (tenant: TenantId, scope: ScopeId, operation: string, input: unknown) => {
          const stub = scopeDo(scope);
          const { instance } = await stub.systemDoorState(TRASH_MODULE_ID);
          // `invoke`'s whole positional surface, and one argument past it: the old `purge` slot.
          const reply = await stub.invoke(
            operation, input, TRASH_MODULE_ID, tenant, scope, undefined, undefined, TRASH_MODULE_ID, true,
            { invocationId: ulid(), purge: true }, undefined, undefined, undefined, instance, true,
          );
          return reply.failure ? (errorCodeOf(fromWireFailure(reply.failure)) ?? 'unknown') : 'ok';
        },
        runPurgeSweep: async (tenant: TenantId, scope: ScopeId, operation: string) => {
          const stub = scopeDo(scope);
          const { instance } = await stub.systemDoorState(TRASH_MODULE_ID);
          return stub.runPurgeSweep(operation, tenant, scope, instance);
        },
        // What a CP-less deployment's platform delivers into the scope (#1713, #2009): the inputs
        // the object's own gate reads. A directory-backed host's suspend never reaches the object.
        holdLifecycle: async (tenant: TenantId, scope: ScopeId, held: boolean) => {
          revision += 1;
          await scopeDo(scope).setLifecycle(
            { scope: held ? 'suspended' : 'active', tenant: 'active', at: new Date().toISOString(), revision: { epoch: 1, scope: revision, tenant: 0 } },
            tenant,
          );
        },
        // A delivered lifecycle back-fills the `provisioned_for` receipt of a scope holding data — the
        // CP-less path. This directory-backed fixture never writes one otherwise.
        recordTenant: async (tenant: TenantId, scope: ScopeId) => {
          revision += 1;
          await scopeDo(scope).setLifecycle(
            { scope: 'active', tenant: 'active', at: new Date().toISOString(), revision: { epoch: 1, scope: revision, tenant: 0 } },
            tenant,
          );
        },
        // No receipt on a directory-backed scope, so the object reads any tenant as `unknown` and lets it
        // through, as every door does. There the coordinator, holding the directory, is the authority.
        unrecordedTenant: 'admitted' as const,
        markCopy: async (_tenant: TenantId, scope: ScopeId) => {
          await scopeDo(scope).markCopy();
        },
        runPurgeSweepNaming: async (tenant: TenantId, scope: ScopeId, named: ScopeId, operation: string) => {
          const stub = scopeDo(scope);
          const { instance } = await stub.systemDoorState(TRASH_MODULE_ID);
          return stub.runPurgeSweep(operation, tenant, named, instance);
        },
      };
    })(),
  },
);

// #2068: subject erasure inside a module's own tables, on the DO host — the one transaction,
// the counts and FTS5 secure-delete proven in workerd's SQLite. `erasureMod` is in
// `contractTestModules`, so the ScopeDO carries it, and its hook, at code time.
subjectErasureContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      checker: UNSAFE_allowAllChecker,
    });
    return { host, cleanup: async () => host.close() };
  },
  // The scope DO's own storage, past `ctx.sql`.
  async (_tenant, scope, sql, params = []) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_, state) =>
      state.storage.sql.exec(sql, ...(params as SqlStorageValue[])).toArray(),
    ),
);

// #2068 r5: commented migration DDL, then a DROP COLUMN of the last column — the case workerd's
// SQLite refused while comments were executed. `commentedDdlMod` is in `contractTestModules`.
migrationCommentsContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #2553: the applied-migrations read answers with every row, past the 100 it once stopped at.
// `manyMigrationsMod` is in `contractTestModules`.
manyMigrationsContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #115: the data-loss fence on the adapter that is actually deployed — the refusal must fail the
// scope closed inside the DO's migration transaction, rows intact.
migrationFenceContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #893: the declared `input` parsed at the door, on the adapter that is actually
// deployed. The DEFAULT tuple checker — the fixture's handlers run a real
// `ctx.check`, which an allow-all cannot answer. `parseMod` is in
// `contractTestModules`, so the ScopeDO carries it at code time.
inputParseContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #954: the spine guard on ctx.sql. `testMod` is in `contractTestModules`, so the
// ScopeDO already carries the forge operations at code time — and it is THIS host
// the guard has to hold on, since a vertical is written against the pure adapter
// and deployed onto the DO.
spineGuardContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #1741: the same statements, refused with the same messages — here by the DO's own SQLite,
// which is where the limits come from. The node twin is in adapter-sqlite's contract.test.ts.
sqlLimitsContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  return { host, cleanup: async () => host.close() };
});

// #129: optimistic concurrency on the DO host, and the DEFAULT checker. This is
// the only place the precondition is proven to cross the coordinator↔ScopeDO hop:
// the comparison happens inside the DO's transaction, and the acknowledgement has
// to come back or the coordinator refuses the success.
concurrencyContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #116: request idempotency on the DO host. The only place the recording is
// proven to live inside the DO's own transaction and the acknowledgement to
// cross the coordinator↔ScopeDO hop — a DO that dropped the key would EXECUTE
// the operation again, which is the failure the header was sent to prevent.
idempotencyContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #1746: the per-request record's scope half, across the coordinator↔ScopeDO hop — the report
// is computed inside the DO and has to come back in the envelope.
emittedReportContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #1746/#1747: ctx.log inside the DO. There is no sink option to reach — workerd builds the
// DO — so the lines are read where a deployment's log platform reads them: the console.
moduleLogContractSuite('adapter-cloudflare', async () => {
  const lines: ModuleLogLine[] = [];
  const capture = (text: unknown) => {
    if (typeof text !== 'string' || !text.startsWith('{"substrat":"log"')) return false;
    lines.push(JSON.parse(text) as ModuleLogLine);
    return true;
  };
  const spies = (['log', 'warn', 'error', 'debug'] as const).map((m) => {
    const original = console[m].bind(console);
    return vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      if (!capture(args[0])) original(...args);
    });
  });
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    logs: () => lines,
    cleanup: async () => {
      for (const s of spies) s.mockRestore();
      await host.close();
    },
  };
});

// #2387: the record is written inside the DO, to the console, where it is read here.
checkTallyContractSuite('adapter-cloudflare', async () => {
  const lines: ModuleLogLine[] = [];
  const capture = (text: unknown) => {
    if (typeof text !== 'string' || !text.startsWith('{"substrat":"log"')) return false;
    lines.push(JSON.parse(text) as ModuleLogLine);
    return true;
  };
  const spies = (['log', 'warn', 'error', 'debug'] as const).map((m) => {
    const original = console[m].bind(console);
    return vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      if (!capture(args[0])) original(...args);
    });
  });
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    logs: () => lines,
    cleanup: async () => {
      for (const s of spies) s.mockRestore();
      await host.close();
    },
  };
});

// #1901: async work's invocation lines — written inside the DO (consumers) and on the
// coordinator (executors, schedules), both to the console, where they are read here.
asyncLogContractSuite('adapter-cloudflare', async () => {
  const lines: InvocationLogLine[] = [];
  const logs: ModuleLogLine[] = [];
  const capture = (text: unknown) => {
    if (typeof text !== 'string') return false;
    if (text.startsWith('{"substrat":"invocation"')) lines.push(JSON.parse(text) as InvocationLogLine);
    else if (text.startsWith('{"substrat":"log"')) logs.push(JSON.parse(text) as ModuleLogLine);
    else return false;
    return true;
  };
  const spies = (['log', 'warn', 'error', 'debug'] as const).map((m) => {
    const original = console[m].bind(console);
    return vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      if (!capture(args[0])) original(...args);
    });
  });
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    lines: () => lines,
    logs: () => logs,
    cleanup: async () => {
      for (const s of spies) s.mockRestore();
      await host.close();
    },
  };
});

/**
 * #1856: `grantEntityLocal` writes an entity grant straight into a scope's tuples, as a
 * worker does for a portal seat. It holds the ref to the same grammar as `ctx.grant`,
 * and its well-formed twin, a camelCase type, is walked like any other.
 */
describe('#1856 — grantEntityLocal refuses a ref the permission graph cannot hold', () => {
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  const who = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const READ = permissionKey.parse('perm:read');

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(permMod);
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
  });

  afterAll(async () => {
    await host.close();
  });

  const probe = async (entity: { entityType: string; entityId: string }) =>
    (await host.getScope(who, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: READ, entity });

  it.each([
    ['a colon in the type', { entityType: 'ai:Turn', entityId: 't1' }],
    ['a space in the id', { entityType: 'aiTurn', entityId: 't 1' }],
    ['an empty id', { entityType: 'aiTurn', entityId: '' }],
    ['a kernel namespace as the type', { entityType: 'Scope', entityId: 't1' }],
  ])('refuses %s with validation_failed', async (_what, entity) => {
    const err = await host.grantEntityLocal(s, who, READ, entity).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(errorCodeOf(err)).toBe('validation_failed');
    expect((err as Error).message).toMatch(/^grantEntityLocal: malformed entity ref/);
  });

  it('grants a camelCase entity, and the check reads it back', async () => {
    const entity = { entityType: 'aiTurn', entityId: 't9' };
    await expect(probe(entity)).resolves.toMatchObject({ allowed: false });
    await host.grantEntityLocal(s, who, READ, entity);
    await expect(probe(entity)).resolves.toMatchObject({ allowed: true });
  });

  it('grantEntityLocal cannot mint a current or retired grantee-shape key; the shape grant can', async () => {
    const entity = { entityType: 'localRoom', entityId: 'r1' };
    const USE = permissionKey.parse('perm:use');
    await host.topUpEntityGrantShapesLocal(t, s, [
      { entityType: 'localRoom', permissions: [USE], retired: [READ], bootstrap: true, holder: 'grantee' },
    ]);
    const protectedRows = await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_instance, state) =>
      state.storage.sql.exec("SELECT subject, object FROM _substrat_tuples WHERE relation = 'shape-grantee-key' ORDER BY object").toArray(),
    );
    expect(protectedRows).toEqual([
      { subject: 'shape:localRoom', object: `granted:${READ}` },
      { subject: 'shape:localRoom', object: `granted:${USE}` },
    ]);
    for (const key of [USE, READ]) {
      const err = await host.grantEntityLocal(s, who, key, entity).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(errorCodeOf(err)).toBe('permission_denied');
    }
    await host.grantEntityShapeLocal(s, who, entity, [USE]);
    await expect((await host.getScope(who, t, s)).invoke('perm/probe', { permission: USE, entity })).resolves.toMatchObject({ allowed: true });
  });
});

describe('#113 — a refusal raised inside a Durable Object keeps its code across the hop', () => {
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  let host: CloudflareScopeHost;

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(permMod);
  });

  const refusal = (p: Promise<unknown>): Promise<Error> =>
    p.then(
      () => {
        throw new Error('expected a refusal');
      },
      (e: Error) => e,
    );
  /** A world of one tenant and one active scope, fresh per test. */
  const world = async () => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `hop-${t.toLowerCase()}`, name: 'Hop' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
    return { t, s };
  };

  it('a ControlPlaneDO write refuses with its code, and the sentence as written', async () => {
    const { t } = await world();
    const taken = await refusal(
      host.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug: `hop-${t.toLowerCase()}`, name: 'Twin' }),
    );
    expect(errorCodeOf(taken)).toBe('conflict');
    // Thrown across the hop, workerd would have written `Substrat.conflict: tenant slug …`.
    expect(taken.message).toBe(`tenant slug 'hop-${t.toLowerCase()}' is already taken (slugs are unique)`);
    const ghost = tenantId.parse(ulid());
    const unknown = await refusal(host.admin.setTenantStatus(staff, ghost, 'suspended'));
    expect(errorCodeOf(unknown)).toBe('not_found');
    expect(unknown.message).toBe(`unknown tenant: ${ghost}`);
  });

  it('the scope gate answers a scope with no tenant record not_found, and its twin is let through', async () => {
    const { t, s } = await world();
    await expect(host.getScope(alice, t, s)).resolves.toBeDefined();
    await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), async (_i, state) => {
      state.storage.sql.exec('DELETE FROM tenants WHERE tenant_id = ?', t);
    });
    const orphan = await refusal(host.getScope(alice, t, s));
    expect(errorCodeOf(orphan)).toBe('not_found');
    expect(orphan.message).toBe(`scope has no tenant record: (${t}, ${s})`);
    expect((orphan as SubstratError).extensions.reason).toBe(SCOPE_GATE_REASONS.unrecorded);
  });

  it('a directory method called directly still throws, for a coordinator from before the envelope', async () => {
    const { t } = await world();
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
      setTenantName(tenantId: string, name: string): Promise<string>;
    };
    const ghost = tenantId.parse(ulid());
    const legacy = await refusal(stub.setTenantName(ghost, 'Ghost'));
    expect(legacy.message).toContain(`unknown tenant: ${ghost}`);
    await expect(stub.setTenantName(t, 'Renamed')).resolves.toBe('Hop');
  });

  it('refuses a method name that is not on the replied list', async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
      reply(method: string, args: unknown[]): Promise<DoReply<unknown>>;
    };
    const reply = await stub.reply('wipeDirectory', []);
    expect(reply.failure?.message).toBe('not a replied directory method: wipeDirectory');
  });
});

/**
 * #2185 — THE WEDGE-RISK TEST for the `retirements_finished_version_id` migration, on DO SQLite.
 *
 * The column is added to an EXISTING directory with no backfill, so every install it already
 * holds reads null: "its retirements are not known to have finished". That is the strict
 * direction, and the question is whether it wedges anyone. It must not: the gate may refuse ONLY a
 * binding-shape drop from a version that declares a retirement, nothing else, and the sweep must
 * re-converge every such install on its own (a reconcile answering "finished" writes the version
 * beside the receipt), after which the drop passes.
 *
 * The sweep's reconcile is STUBBED here (it answers "finished"): this proves the predicate and the
 * write converge on DO SQLite, not that a real deployment's answer becomes "finished". That half is
 * apps/control-plane's `reconcileReachedScope` test ("answers whether the reconcile finished the
 * retirements its payload carried") and control-plane-api's route tests in reconcile-receipt.test.ts.
 */
describe('#2185 — wedge risk: the retirements-finished column added to an existing directory', () => {
  const staff = platformActorId.parse(ulid());

  it('ALTERs an existing directory DO: the column appears, existing rows read null and group not finished, and re-running is a no-op', async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`retirements-finished-${ulid()}`));
    const seen = await runInDurableObject(stub, (_instance, state) => {
      // The directory as a control plane from before #2185 left it.
      state.storage.sql.exec('ALTER TABLE scopes DROP COLUMN retirements_finished_version_id');
      state.storage.sql.exec(`INSERT INTO scopes (scope_id, tenant_id, vertical, vertical_version_id, provisioned_version_id, serving_ref, created_at)
        VALUES ('old-scope', 'old-tenant', 'old-vertical', 'v1', 'v1', 'old-script', '2026-01-01T00:00:00.000Z')`);
      const columns = () => state.storage.sql.exec("SELECT name FROM pragma_table_info('scopes')").toArray().map((r) => r.name);
      const before = columns().includes('retirements_finished_version_id');
      // A deploy: new code over the old storage, twice (the addition is re-runnable).
      new ControlPlaneDO(state, env);
      const cp = new ControlPlaneDO(state, env);
      const row = () => state.storage.sql.exec('SELECT provisioned_version_id, retirements_finished_version_id FROM scopes WHERE scope_id = ?', 'old-scope').toArray()[0];
      const migrated = row();
      const groups = installsReconciledOf(state.storage.sql.exec(PROVISIONED_VERSIONS_SQL, ...provisionedVersionsParams('old-vertical', { ref: 'old-script', versionId: 'v1' }, null)).toArray());
      cp.markScopeProvisioned('old-scope', 'v1', true);
      const converged = row();
      const after = installsReconciledOf(state.storage.sql.exec(PROVISIONED_VERSIONS_SQL, ...provisionedVersionsParams('old-vertical', { ref: 'old-script', versionId: 'v1' }, null)).toArray());
      return { before, after: columns().includes('retirements_finished_version_id'), migrated, groups, converged, finishedGroups: after };
    });
    expect(seen).toEqual({
      before: false,
      after: true,
      migrated: { provisioned_version_id: 'v1', retirements_finished_version_id: null },
      groups: [{ versionId: 'v1', runningVersionId: 'v1', retirementsFinished: false, boundShapes: null, installs: 1, example: 'old-scope' }],
      converged: { provisioned_version_id: 'v1', retirements_finished_version_id: 'v1' },
      finishedGroups: [{ versionId: 'v1', runningVersionId: 'v1', retirementsFinished: true, boundShapes: null, installs: 1, example: 'old-scope' }],
    });
  });

  it('meanwhile refuses only a binding-shape drop from a retiring version, and the sweep re-converges every migrated install', async () => {
    const host = new CloudflareScopeHost({
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      fetch: connectorTestFetch,
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `wedge-${t.slice(-10).toLowerCase()}`, name: 'Wedge' });
    const HOLDER = { table: 'bind_records', idColumn: 'id', principalColumn: 'principal' };
    const shape = (permissions: string[], retired?: string[]) => ({
      entityType: 'contact', permissions, ...(retired ? { retired } : {}), bootstrap: true, holder: HOLDER, bind: { permission: 'contact:invite' },
    });
    const publish = async (slug: string, entityGrants: object[]) => {
      const id = ulid();
      await host.admin.publishVersion(staff, await heldVersion({
        id, verticalSlug: slug, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`,
        permissionDigest: `p-${id}`, migrationDigest: 'g', deploymentRef: null,
        manifestJson: JSON.stringify({ registry: { permissions: [], roles: [], entityGrants } }),
      }));
      await host.admin.admitVersion(staff, id);
      return id;
    };
    const ACKS = { permissionChange: true, migrationChange: true, exportBreak: true } as const;
    /** A listed vertical serving `version` in place, with one install on it whose receipt names it. */
    const servedInstall = async (version: (slug: string) => Promise<string>) => {
      const slug = `acme/wedge-${ulid().slice(-8).toLowerCase()}`;
      await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
      const v = await version(slug);
      const ref = `serving-${ulid().slice(-8).toLowerCase()}`;
      await host.admin.promoteVersion(staff, slug, 'prod', v, ACKS);
      await host.admin.setVerticalServing(staff, slug, { ref, versionId: v, doClasses: [], migrationTag: 'g' });
      const sc = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: sc, vertical: slug });
      await host.admin.activateScope(staff, t, sc);
      await host.admin.bindScopeVersion(staff, t, sc, v);
      expect((await host.admin.getScopeRecord(staff, t, sc))?.servingRef).toBe(ref);
      // #2184: as a reconcile of a binding version reports it, `contact` bound.
      await host.admin.markScopeProvisioned(staff, t, sc, v, { retirementsFinished: true, boundShapes: ['contact'] });
      return { slug, v, sc };
    };
    // A vertical whose served version retires every key of its binding shape, and one that retires nothing.
    const retiring = await servedInstall(async (slug) => {
      await publish(slug, [shape(['contact:read-own'])]);
      return publish(slug, [shape([], ['contact:read-own'])]);
    });
    const plain = await servedInstall((slug) => publish(slug, [shape(['contact:read-own'])]));
    const mine = [retiring.sc, plain.sc];

    // The migration's state for these two rows: a receipt, and null beside it (no backfill).
    await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), (_i, state) => {
      for (const sc of mine) state.storage.sql.exec('UPDATE scopes SET retirements_finished_version_id = NULL WHERE scope_id = ?', sc);
    });

    // Refused: the binding-shape drop from the retiring version, naming the install and what it waits for.
    const dropped = await publish(retiring.slug, []);
    const refused = await host.admin.promoteVersion(staff, retiring.slug, 'prod', dropped, ACKS).then(() => null, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('precondition_failed');
    expect(String((refused as Error).message)).toMatch(
      new RegExp(
        `drops the shape.*that reconciled ${retiring.v} with its retirements not finished, where links have bound people to contact \\(one is ${retiring.sc}\\); ` +
          'the drop waits for their retirements to finish',
      ),
    );
    // Nothing else: the retiring vertical republishing its shape, and the plain one adding a key, promote.
    const same = await publish(retiring.slug, [shape([], ['contact:read-own'])]);
    await host.admin.promoteVersion(staff, retiring.slug, 'prod', same, { ...ACKS, review: await reviewFor(host, staff, retiring.slug, same) });
    const more = await publish(plain.slug, [shape(['contact:read-own', 'contact:other'])]);
    await host.admin.promoteVersion(staff, plain.slug, 'prod', more, { ...ACKS, review: await reviewFor(host, staff, plain.slug, more) });

    // The sweep, over the real directory (only these two installs listed), with a reconcile that
    // answers what a current vertical-host does: every retirement finished.
    const sweepHost = {
      admin: {
        listScopes: async (a: never, f: never) => (await host.admin.listScopes(a, f)).filter((sc) => mine.includes(sc.id)),
        listVerticals: (a: never) => host.admin.listVerticals(a),
        listConnections: async () => [],
        markScopeProvisioned: (...args: Parameters<typeof host.admin.markScopeProvisioned>) => host.admin.markScopeProvisioned(...args),
      },
      drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }),
    } as unknown as ScopeHost;
    const sweep = () =>
      runPlatformSweep(sweepHost, {
        actor: staff,
        fetch: connectorTestFetch,
        sweepers: {},
        runSchedules: false,
        reconcileScopeFn: async () => ({ retirementsFinished: true, boundShapes: ['contact'] }),
      });
    const first = await sweep();
    expect(first.provisionReconcile).toMatchObject({ behind: 2, reconciled: 2, failed: 0 });
    for (const sc of mine) {
      const r = await host.admin.getScopeRecord(staff, t, sc);
      expect(r?.retirementsFinishedVersionId).toBe(r?.provisionedVersionId);
    }
    // Converged: the next pass has nothing to do, and the drop passes.
    expect((await sweep()).provisionReconcile).toMatchObject({ behind: 0, reconciled: 0 });
    await host.admin.promoteVersion(staff, retiring.slug, 'prod', dropped, { ...ACKS, review: await reviewFor(host, staff, retiring.slug, dropped) });
    await host.close();
  });
});

/**
 * #2184 — THE WEDGE-RISK TEST for the `bound_shapes` migration, on DO SQLite.
 *
 * The column is added to an EXISTING directory with no backfill, so every install it already holds
 * reads null: "which binding shapes links have bound here is unknown", which the gate judges as every
 * table-held bootstrap shape of the version bound. That is the strict direction, and it must not
 * wedge: it may refuse only a move that strands a table-held bootstrap shape's keys, and the sweep
 * must re-converge every such install on its own (a reconcile that reports writes the types beside
 * the receipt), after which a vertical that never bound moves freely and one that did is held for
 * exactly the type it bound.
 *
 * The sweep's reconcile is STUBBED here (it answers what a current deployment would): this proves
 * the predicate, the write, and `json_extract` in `PROVISIONED_VERSIONS_SQL` on DO SQLite. The answer
 * half is apps/control-plane's `reconcileReachedScope` test and control-plane-api's route tests.
 */
describe('#2184 — wedge risk: the bound-shapes column added to an existing directory', () => {
  const staff = platformActorId.parse(ulid());

  it('ALTERs an existing directory DO: the column appears, existing rows read unknown, re-running is a no-op, and the groups stay one per set', async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`bound-shapes-${ulid()}`));
    const seen = await runInDurableObject(stub, (_instance, state) => {
      // The directory as a control plane from before #2184 left it.
      state.storage.sql.exec('ALTER TABLE scopes DROP COLUMN bound_shapes');
      const add = (id: string) =>
        state.storage.sql.exec(`INSERT INTO scopes (scope_id, tenant_id, vertical, vertical_version_id, provisioned_version_id, retirements_finished_version_id, serving_ref, created_at)
          VALUES (?, 'old-tenant', 'old-vertical', 'v1', 'v1', 'v1', 'old-script', '2026-01-01T00:00:00.000Z')`, id);
      for (const id of ['s1', 's2', 's3', 's4', 's5']) add(id);
      const columns = () => state.storage.sql.exec("SELECT name FROM pragma_table_info('scopes')").toArray().map((r) => r.name);
      const before = columns().includes('bound_shapes');
      // A deploy: new code over the old storage, twice (the addition is re-runnable).
      new ControlPlaneDO(state, env);
      const cp = new ControlPlaneDO(state, env);
      const groups = () => installsReconciledOf(state.storage.sql.exec(PROVISIONED_VERSIONS_SQL, ...provisionedVersionsParams('old-vertical', { ref: 'old-script', versionId: 'v1' }, null)).toArray());
      const migrated = groups();
      // Reported: three bound `contact`, one bound nothing, one is left unknown.
      for (const id of ['s1', 's2', 's3']) cp.markScopeProvisioned(id, 'v1', true, ['contact']);
      cp.markScopeProvisioned('s4', 'v1', true, []);
      const reported = groups();
      // A receipt rewritten for another version by code that does not know the column: the pair no longer counts.
      state.storage.sql.exec("UPDATE scopes SET provisioned_version_id = 'v2', retirements_finished_version_id = 'v2' WHERE scope_id = 's1'");
      const rolledBack = groups().find((g) => g.versionId === 'v2');
      return { before, after: columns().includes('bound_shapes'), migrated, reported, rolledBack };
    });
    expect(seen.before).toBe(false);
    expect(seen.after).toBe(true);
    expect(seen.migrated).toEqual([{ versionId: 'v1', runningVersionId: 'v1', retirementsFinished: true, boundShapes: null, installs: 5, example: 's1' }]);
    // One row per (version, finished, set), however many installs share it.
    expect([...seen.reported].sort((a, b) => a.example.localeCompare(b.example))).toEqual([
      { versionId: 'v1', runningVersionId: 'v1', retirementsFinished: true, boundShapes: ['contact'], installs: 3, example: 's1' },
      { versionId: 'v1', runningVersionId: 'v1', retirementsFinished: true, boundShapes: [], installs: 1, example: 's4' },
      { versionId: 'v1', runningVersionId: 'v1', retirementsFinished: true, boundShapes: null, installs: 1, example: 's5' },
    ]);
    // …and it lags what the install runs (v1, served): judged as unreported either way (review of #2220).
    expect(seen.rolledBack).toEqual({ versionId: 'v2', runningVersionId: 'v1', retirementsFinished: true, boundShapes: null, installs: 1, example: 's1' });
  });

  it('meanwhile refuses only a strand of a table-held shape, and the sweep re-converges every migrated install', async () => {
    const host = new CloudflareScopeHost({
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      fetch: connectorTestFetch,
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `bound-${t.slice(-10).toLowerCase()}`, name: 'Bound' });
    const HOLDER = { table: 'bind_records', idColumn: 'id', principalColumn: 'principal' };
    // `bind` dropped (or never declared): judged from the registry alone, nothing binds.
    const shape = (permissions: string[]) => ({ entityType: 'contact', permissions, bootstrap: true, holder: HOLDER });
    const publish = async (slug: string, entityGrants: object[]) => {
      const id = ulid();
      await host.admin.publishVersion(staff, await heldVersion({
        id, verticalSlug: slug, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`,
        permissionDigest: `p-${id}`, migrationDigest: 'g', deploymentRef: null,
        manifestJson: JSON.stringify({ registry: { permissions: [], roles: [], entityGrants } }),
      }));
      await host.admin.admitVersion(staff, id);
      return id;
    };
    const ACKS = { permissionChange: true, migrationChange: true, exportBreak: true } as const;
    const servedInstall = async () => {
      const slug = `acme/bound-${ulid().slice(-8).toLowerCase()}`;
      await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
      const v = await publish(slug, [shape(['contact:read-own'])]);
      const ref = `serving-${ulid().slice(-8).toLowerCase()}`;
      await host.admin.promoteVersion(staff, slug, 'prod', v, ACKS);
      await host.admin.setVerticalServing(staff, slug, { ref, versionId: v, doClasses: [], migrationTag: 'g' });
      const sc = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: sc, vertical: slug });
      await host.admin.activateScope(staff, t, sc);
      await host.admin.bindScopeVersion(staff, t, sc, v);
      await host.admin.markScopeProvisioned(staff, t, sc, v, { retirementsFinished: true, boundShapes: [] });
      return { slug, v, sc };
    };
    // One vertical whose install bound `contact` before its `bind` was dropped, one that never bound.
    const bound = await servedInstall();
    const never = await servedInstall();
    const mine = [bound.sc, never.sc];
    // The migration's state for these two rows: a receipt, and null beside it (no backfill).
    await runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), (_i, state) => {
      for (const sc of mine) state.storage.sql.exec('UPDATE scopes SET bound_shapes = NULL WHERE scope_id = ?', sc);
    });
    const unknown = (v: string, sc: string) =>
      new RegExp(`drops the shape.*that reconciled ${v} without reporting which binding shapes links have bound \\(one is ${sc}\\), so every bootstrap shape`);
    const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);

    // Refused while unknown: the drop of the table-held shape, for both.
    const boundDrop = await publish(bound.slug, []);
    const neverDrop = await publish(never.slug, []);
    for (const { slug, v, sc } of [bound, never]) {
      const refused = await refusalOf(host.admin.promoteVersion(staff, slug, 'prod', slug === bound.slug ? boundDrop : neverDrop, ACKS));
      expect(errorCodeOf(refused)).toBe('precondition_failed');
      expect(String(refused?.message)).toMatch(unknown(v, sc));
    }
    // Nothing else: adding a key promotes.
    const more = await publish(never.slug, [shape(['contact:read-own', 'contact:other'])]);
    await host.admin.promoteVersion(staff, never.slug, 'prod', more, { ...ACKS, review: await reviewFor(host, staff, never.slug, more) });
    await host.admin.setVerticalServing(staff, never.slug, {
      ref: (await host.admin.getScopeRecord(staff, t, never.sc))!.servingRef!, versionId: more, doClasses: [], migrationTag: 'g',
    });

    // The sweep, over the real directory (only these two installs listed), with a reconcile that
    // answers what a current deployment does: the types its sticky records name.
    const sweepHost = {
      admin: {
        listScopes: async (a: never, f: never) => (await host.admin.listScopes(a, f)).filter((sc) => mine.includes(sc.id)),
        listVerticals: (a: never) => host.admin.listVerticals(a),
        listConnections: async () => [],
        markScopeProvisioned: (...args: Parameters<typeof host.admin.markScopeProvisioned>) => host.admin.markScopeProvisioned(...args),
      },
      drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }),
    } as unknown as ScopeHost;
    const sweep = () =>
      runPlatformSweep(sweepHost, {
        actor: staff,
        fetch: connectorTestFetch,
        sweepers: {},
        runSchedules: false,
        reconcileScopeFn: async (_t, sc) => ({ retirementsFinished: true, boundShapes: sc === bound.sc ? ['contact'] : [] }),
      });
    expect((await sweep()).provisionReconcile).toMatchObject({ behind: 2, reconciled: 2, failed: 0 });
    expect((await host.admin.getScopeRecord(staff, t, bound.sc))?.boundShapes).toEqual({ versionId: bound.v, types: ['contact'] });
    // Converged: the next pass has nothing to do.
    expect((await sweep()).provisionReconcile).toMatchObject({ behind: 0, reconciled: 0 });
    // The vertical that never bound moves freely; the one that did is held for `contact`, naming it.
    await host.admin.promoteVersion(staff, never.slug, 'prod', neverDrop, { ...ACKS, review: await reviewFor(host, staff, never.slug, neverDrop) });
    const refused = await refusalOf(host.admin.promoteVersion(staff, bound.slug, 'prod', boundDrop, ACKS));
    expect(String(refused?.message)).toMatch(new RegExp(`that last reconciled ${bound.v}, where links have bound people to contact \\(one is ${bound.sc}\\)`));
    await host.close();
  });
});

/**
 * #2314 — the orphan sweep on a CP-LESS deployment, where no directory vouches for the scope and
 * its own storage is the only word on whether this copy may judge its bytes. The contract suite
 * holds the sweep itself on both adapters; this holds what only the hosted one has: the provision
 * receipt, the copy markers a carry and a kept copy leave, and the fence a PITR rewind writes
 * before it arms (emulated, `pitr-emulation.ts`).
 */
describe('#2314 — the orphan sweep on a CP-less deployment', () => {
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const roles: RoleDefinition[] = [{ key: 'owner', permissions: [UPL_READ, UPL_WRITE], source: 'vertical' }];
  const DAY = 86_400_000;
  const objs = new Map<string, Uint8Array>();
  let failPut: string | null = null;
  const bucket = {
    put: async (key: string, value: Uint8Array) => {
      if (failPut !== null && key.endsWith(failPut)) throw new Error('bucket unavailable');
      objs.set(key, new Uint8Array(value));
    },
    get: async (key: string) => {
      const body = objs.get(key);
      return body ? { arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) } : null;
    },
    delete: async (key: string) => {
      objs.delete(key);
    },
    list: async () => ({ objects: [...objs.keys()].map((key) => ({ key })), truncated: false as const }),
  };
  const later = () => new Date(Date.now() + ORPHAN_SWEEP_GRACE_MS + DAY).toISOString();
  /** #2314: whether this script holds no attachment store for any tenant (a vertical keeping no files). */
  let storeless = false;
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    attachmentBuckets: () => (storeless ? undefined : bucket),
    // Every pass here runs eight days ahead, past the age floor; the fence is stamped the same way.
    orphanSweepClock: later,
  });
  host.registerModule(uploadLinkMod);
  afterAll(async () => host.close());

  const newScope = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScopeLocal({ tenantId: t, scopeId: s, owner, roles, ownerRoleKey: 'owner' });
    return s;
  };
  /** An object no row names, minted a day ago. */
  const plant = (s: ScopeId): string => {
    const key = attachmentBlobKey(s, ulid(Date.now() - DAY));
    objs.set(key, new Uint8Array([1]));
    return key;
  };
  /**
   * A pass as the platform's phase runs one: the dry run that licenses it (#2350), then the
   * destructive pass, unless the dry run found nothing to license, when its report is the answer.
   */
  const sweep = async (s: ScopeId, tenant: TenantId = t) => {
    const dry = await host.sweepOrphanAttachments(tenant, s, { copiesSettled: true, dryRun: true });
    return dry.keys.length === 0 ? dry : host.sweepOrphanAttachments(tenant, s, { copiesSettled: true });
  };
  const raw = (s: ScopeId, run: (sql: SqlStorage) => void) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_, state) => run(state.storage.sql));

  it('judges by the scope\'s provision receipt, with no directory: its own tenant sweeps, another is refused', async () => {
    const s = await newScope();
    const orphan = plant(s);
    await expect(sweep(s, other)).rejects.toThrow(/may not judge orphan attachments/);
    expect(objs.has(orphan)).toBe(true);
    expect((await sweep(s)).keys).toEqual([orphan]);
    expect(objs.has(orphan)).toBe(false);
  });

  it('a script with no attachment store answers so, marked, after the copy has judged, and fails for a scope that holds files; a store that held nothing answers unmarked', async () => {
    const s = await newScope();
    const orphan = plant(s);
    storeless = true;
    try {
      expect(await sweep(s)).toEqual({ listed: 0, candidates: 0, orphans: 0, deleted: 0, keys: [], dryRun: true, bucket: 'none' });
      // The copy's refusals still come first: a foreign tenant is refused, not answered "no store".
      await expect(sweep(s, other)).rejects.toThrow(/may not judge orphan attachments/);
    } finally {
      storeless = false;
    }
    expect(objs.has(orphan)).toBe(true);
    // A scope that holds an attachment row does keep files: no store there is a missing binding, a failure.
    const kept = await newScope();
    await (await host.attachments(owner, t, kept)).upload({
      entity: { entityType: 'udoc', entityId: 'doc-1' },
      filename: 'a.txt',
      contentType: 'text/plain',
      visibility: 'internal',
      body: new TextEncoder().encode('kept'),
    });
    storeless = true;
    try {
      await expect(sweep(kept)).rejects.toThrow(/holds attachment rows.*store binding is missing/);
    } finally {
      storeless = false;
    }
    const empty = await newScope();
    const clean = await sweep(empty);
    expect(clean).toMatchObject({ orphans: 0, deleted: 0 });
    expect(clean).not.toHaveProperty('bucket');
  });

  it('a pass routed to another version than this script runs is refused, in either mode; the routed version sweeps', async () => {
    const s = await newScope();
    const orphan = plant(s);
    const deployed = (env as unknown as { SUBSTRAT_VERSION_ID: string }).SUBSTRAT_VERSION_ID;
    const routed = (expectedVersionId: string, dryRun: boolean) =>
      host.sweepOrphanAttachments(t, s, { copiesSettled: true, expectedVersionId, ...(dryRun ? { dryRun: true } : {}) });
    for (const dryRun of [true, false]) {
      await expect(routed('01JTESTVRSN00000000000OTHR', dryRun)).rejects.toThrow(/runs version .*, not 01JTESTVRSN00000000000OTHR/);
    }
    expect(objs.has(orphan)).toBe(true);
    expect((await routed(deployed, true)).keys).toEqual([orphan]);
    expect((await routed(deployed, false)).keys).toEqual([orphan]);
    // Refused before anything is listed, so a misrouted destructive pass is refused with nothing to condemn too.
    const empty = await newScope();
    await expect(
      host.sweepOrphanAttachments(t, empty, { copiesSettled: true, expectedVersionId: '01JTESTVRSN00000000000OTHR' }),
    ).rejects.toThrow(/runs version .*, not 01JTESTVRSN00000000000OTHR/);
  });

  it("a pass that condemns nothing leaves the scope's write revision alone; one that condemns moves it", async () => {
    const revisionOf = async (s: ScopeId) => (await host.exportScopeStampedLocal(s)).revision;
    // (a) A scope with nothing under its prefix: the dry run licenses nothing, and the destructive
    // pass it would license is refused (#2350), each writing nothing.
    const empty = await newScope();
    const before = await revisionOf(empty);
    expect((await sweep(empty)).deleted).toBe(0);
    await expect(host.sweepOrphanAttachments(t, empty, { copiesSettled: true })).rejects.toThrow(/no orphan-sweep dry run/);
    expect(await revisionOf(empty)).toBe(before);
    // (b) A scope whose only old object has its row: judged, condemned nothing.
    const live = await newScope();
    await (await host.attachments(owner, t, live)).upload({
      entity: { entityType: 'udoc', entityId: 'doc-1' },
      filename: 'a.txt',
      contentType: 'text/plain',
      visibility: 'internal',
      body: new TextEncoder().encode('kept'),
    });
    const held = await revisionOf(live);
    const judged = await sweep(live);
    expect(judged).toMatchObject({ orphans: 0, deleted: 0 });
    expect(judged.candidates).toBeGreaterThan(0);
    expect(await revisionOf(live)).toBe(held);
    // The twin: an orphan condemned is a write, and the revision moves.
    const orphan = plant(live);
    expect((await sweep(live)).keys).toEqual([orphan]);
    expect(await revisionOf(live)).not.toBe(held);
  });

  it('with no directory, a pass needs its caller to have read the copy ledger', async () => {
    const s = await newScope();
    const orphan = plant(s);
    await expect(host.sweepOrphanAttachments(t, s)).rejects.toThrow(/cannot read the copy ledger/);
    expect(objs.has(orphan)).toBe(true);
    expect((await sweep(s)).keys).toEqual([orphan]);
  });

  it('a scope whose delivered lifecycle is not active is refused, and the same scope active again sweeps', async () => {
    const s = await newScope();
    const orphan = plant(s);
    const deliver = (scope: 'suspended' | 'active', rev: number) =>
      host.setLifecycleLocal(s, {
        scope,
        tenant: 'active',
        at: '2026-10-01T00:00:00.000Z' as never,
        revision: { epoch: 0, scope: rev, tenant: 0 },
      });
    await deliver('suspended', 1);
    await expect(sweep(s)).rejects.toThrow(/lifecycle is not active/);
    expect(objs.has(orphan)).toBe(true);
    await deliver('active', 2);
    expect((await sweep(s)).keys).toEqual([orphan]);
  });

  it('a reaped scope is refused, and its bytes stay for its backup', async () => {
    const s = await newScope();
    const orphan = plant(s);
    await host.deleteScopeLocal(s, t);
    await expect(sweep(s)).rejects.toThrow(/reaped/);
    expect(objs.has(orphan)).toBe(true);
  });

  it('a scope with no receipt is refused, since nothing vouches for it', async () => {
    const s = await newScope();
    const orphan = plant(s);
    await raw(s, (sql) => sql.exec(`DELETE FROM _substrat_meta WHERE key = 'provisioned_for'`));
    await expect(sweep(s)).rejects.toThrow(/no provision receipt/);
    expect(objs.has(orphan)).toBe(true);
  });

  it('a kept copy is refused, and the same scope once resolved sweeps', async () => {
    const s = await newScope();
    const orphan = plant(s);
    await raw(s, (sql) => sql.exec(`INSERT INTO _substrat_meta (key, value) VALUES ('kept_divergent', '{}')`));
    await expect(sweep(s)).rejects.toThrow(/it is a kept copy/);
    expect(objs.has(orphan)).toBe(true);
    await raw(s, (sql) => sql.exec(`DELETE FROM _substrat_meta WHERE key = 'kept_divergent'`));
    expect((await sweep(s)).keys).toEqual([orphan]);
  });

  it('a copy a carry wiped is refused', async () => {
    const s = await newScope();
    const orphan = plant(s);
    await raw(s, (sql) => sql.exec(`INSERT INTO _substrat_meta (key, value) VALUES ('carried_away', '{}')`));
    // The marker is read on wake.
    await restartNow(env.SCOPE, s);
    await expect(sweep(s)).rejects.toThrow(/a copy a carry wiped/);
    expect(objs.has(orphan)).toBe(true);
  });

  it('a scope classified a copy is refused', async () => {
    const s = await newScope();
    const orphan = plant(s);
    await raw(s, (sql) =>
      sql.exec(
        `INSERT INTO _substrat_copy_origin (id, source_scope_id, events_through, copied_at, is_copy)
           VALUES (1, NULL, '', '2026-01-01T00:00:00.000Z', 1)
         ON CONFLICT (id) DO UPDATE SET is_copy = 1`,
      ),
    );
    await expect(sweep(s)).rejects.toThrow(/a fork or a snapshot/);
    expect(objs.has(orphan)).toBe(true);
  });

  it('a rewind writes the fence before it arms, and a pass after it deletes nothing', async () => {
    const s = await newScope();
    const orphan = plant(s);
    await armRewind(env.SCOPE, s);
    await host.rewindScopeLocal(s, 'bm', { force: true });
    expect(objs.has(attachmentSweepFenceKey(s))).toBe(true);
    await awaitRestart(env.SCOPE, s);
    const report = await sweep(s);
    expect(report.deleted).toBe(0);
    expect(report.fencedUntil).toEqual(expect.any(String));
    expect(objs.has(orphan)).toBe(true);
  });

  it('a rewind whose fence cannot be written is refused before it arms', async () => {
    const s = await newScope();
    await armRewind(env.SCOPE, s, { throwing: 'the rewind was reached' });
    failPut = '/sweep-fence';
    try {
      const err = await host.rewindScopeLocal(s, 'bm', { force: true }).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message.startsWith(REWIND_REFUSED)).toBe(true);
      expect((err as Error).message).toContain('restore fence');
      expect((err as Error).message).not.toContain('the rewind was reached');
    } finally {
      failPut = null;
    }
  });

  it('a rewind of a scope that holds files and whose tenant is unknown is refused, and one that names its tenant fences it', async () => {
    const s = await newScope();
    await (await host.attachments(owner, t, s)).upload({
      entity: { entityType: 'udoc', entityId: 'doc-1' },
      filename: 'a.txt',
      contentType: 'text/plain',
      visibility: 'internal',
      body: new TextEncoder().encode('kept'),
    });
    await raw(s, (sql) => sql.exec(`DELETE FROM _substrat_meta WHERE key = 'provisioned_for'`));
    await armRewind(env.SCOPE, s);
    const err = await host.rewindScopeLocal(s, 'bm', { force: true }).then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toMatch(/^rewind refused: the tenant of scope .* is unknown/);
    expect(objs.has(attachmentSweepFenceKey(s))).toBe(false);
    await host.rewindScopeLocal(s, 'bm', { force: true, tenantId: t });
    expect(objs.has(attachmentSweepFenceKey(s))).toBe(true);
    await awaitRestart(env.SCOPE, s);
  });

  it('the twin: a scope with no tenant on record and no file is rewound unfenced, as it has nothing to lose', async () => {
    const s = await newScope();
    await raw(s, (sql) => sql.exec(`DELETE FROM _substrat_meta WHERE key = 'provisioned_for'`));
    await armRewind(env.SCOPE, s);
    await host.rewindScopeLocal(s, 'bm', { force: true });
    expect(objs.has(attachmentSweepFenceKey(s))).toBe(false);
    await awaitRestart(env.SCOPE, s);
  });

  it('a restore through the deployment fences the scope before it loads', async () => {
    const s = await newScope();
    const tables = await host.exportScopeLocal(s);
    await host.restoreScopeLocal(s, tables, { tenantId: t });
    expect(objs.has(attachmentSweepFenceKey(s))).toBe(true);
  });
});

/**
 * #2314 review r1 — a host WITH a directory judged an object it does not hold. The record vouched
 * for the scope (still primary), the object was empty (reaped, or never held: the scope's data is
 * a vertical deployment's), and every file read as an orphan. These are the reviewer's case and
 * its neighbours, kept as regressions.
 */
describe('#2314 r1 — a co-located host judges only a scope it holds, live', () => {
  const t = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const DAY = 86_400_000;
  const objs = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, value: Uint8Array) => {
      objs.set(key, new Uint8Array(value));
    },
    get: async (key: string) => {
      const body = objs.get(key);
      return body ? { arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) } : null;
    },
    delete: async (key: string) => {
      objs.delete(key);
    },
    list: async () => ({ objects: [...objs.keys()].map((key) => ({ key })), truncated: false as const }),
  };
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    attachmentBuckets: () => bucket,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    orphanSweepClock: () => new Date(Date.now() + ORPHAN_SWEEP_GRACE_MS + DAY).toISOString(),
  });
  host.registerModule(uploadLinkMod);
  afterAll(async () => host.close());

  beforeAll(async () => {
    await host.admin.createTenant(staff, { id: t, slug: `osw-r1-${t.toLowerCase()}`, name: 'Orphan sweep r1' });
    await host.admin.grantEntitlement(staff, t, 'upl');
    await host.admin.defineRole(staff, t, { key: 'owner', permissions: [UPL_READ, UPL_WRITE], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t, scopeId: null } });
  });
  const newScope = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'osw-vertical' });
    await host.admin.activateScope(staff, t, s);
    return s;
  };
  const upload = async (s: ScopeId) =>
    (await host.attachments(alice, t, s)).upload({
      entity: { entityType: 'udoc', entityId: 'doc-1' },
      filename: 'a.txt',
      contentType: 'text/plain',
      visibility: 'internal',
      body: new TextEncoder().encode('committed'),
    });
  /** The dry run that licenses a pass (#2350), then the pass, unless the dry run found nothing. */
  const sweep = async (s: ScopeId) => {
    const dry = await host.sweepOrphanAttachments(t, s, { dryRun: true });
    return dry.keys.length === 0 ? dry : host.sweepOrphanAttachments(t, s);
  };

  it('the reviewer\'s case: archived, reaped with a backup, evicted, then a pass: refused, and the file keeps its bytes', async () => {
    const s = await newScope();
    const record = await upload(s);
    await host.admin.archiveScope(staff, t, s);
    await host.admin.reapScope(staff, t, s, { force: true, backupRef: `/backups/${s}` });
    await restartNow(env.SCOPE, s);
    await expect(sweep(s)).rejects.toThrow(/reaped/);
    expect(objs.has(attachmentBlobKey(s, record.id))).toBe(true);
  });

  it('an archived scope is refused before its object is addressed', async () => {
    const s = await newScope();
    const record = await upload(s);
    await host.admin.archiveScope(staff, t, s);
    await expect(sweep(s)).rejects.toThrow(/is archived/);
    expect(objs.has(attachmentBlobKey(s, record.id))).toBe(true);
  });

  it('a scope this namespace never held (its data is a vertical deployment\'s) is refused: the object holds nothing', async () => {
    const s = await newScope();
    // Stand in for a scope served elsewhere: this namespace's object holds nothing at all.
    await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), async (_, state) => {
      await state.storage.deleteAll();
    });
    await restartNow(env.SCOPE, s);
    const key = attachmentBlobKey(s, ulid(Date.now() - DAY));
    objs.set(key, new Uint8Array([1]));
    await expect(sweep(s)).rejects.toThrow(/holds nothing/);
    expect(objs.has(key)).toBe(true);
  });

  it('the twin: an evicted object that holds the scope wakes and is judged, keeping the file and sweeping the orphan', async () => {
    const s = await newScope();
    const record = await upload(s);
    const orphan = attachmentBlobKey(s, ulid(Date.now() - DAY));
    objs.set(orphan, new Uint8Array([1]));
    await restartNow(env.SCOPE, s);
    expect((await sweep(s)).keys).toEqual([orphan]);
    expect(objs.has(attachmentBlobKey(s, record.id))).toBe(true);
  });
});
