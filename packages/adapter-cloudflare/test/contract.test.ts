import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { warmControlPlane } from './do-warmup.js';
import {
  connectionId,
  errorCodeOf,
  toProblem,
  moduleId,
  orgId,
  permissionKey,
  platformActorId,
  principalId,
  projectedConnectionGrant,
  scopeId,
  tenantId,
  type EntitlementGrant,
  type ProjectedConnectionGrant,
  type RoleDefinition,
  type ScopeTable,
} from '@substrat-run/contracts';
import { PermissionDenied, ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import {
  atomicContractSuite,
  capabilityAttachmentContractSuite,
  capabilityContractSuite,
  impersonationContractSuite,
  billedMod,
  connectorTestFetch,
  permissionContractSuite,
  scheduleContractSuite,
  scheduleMod,
  jobRunContractSuite,
  systemSwitchContractSuite,
  scopeHostContractSuite,
  searchContractSuite,
  entityVersionContractSuite,
  timelineContractSuite,
  concurrencyContractSuite,
  idempotencyContractSuite,
  listContractSuite,
  permMod,
  inputParseContractSuite,
  spineGuardContractSuite,
} from '@substrat-run/contract-tests';
import { CloudflareScopeHost } from '../src/host.js';

// Absorb the inter-file DO reload before any suite's first directory call
// (see do-warmup.ts) — file-level, so it runs before every suite below.
beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

// The scope-host suite runs against an allow-all checker (it exercises no
// ctx.check). Runtime module registration is unsupported on CF — the ScopeDO
// closes over a code-time module set — so that one late-registration test is
// skipped; every other test is shared unchanged (D-14).
scopeHostContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      fetch: connectorTestFetch,
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    return { host, cleanup: async () => host.close() };
  },
  { supportsRuntimeRegistration: false },
);

// The permission suite runs against the DO's default tuple checker (scope tuples
// in the ScopeDO, tenant tuples + roles in the ControlPlaneDO).
permissionContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #770: sub-transactions, on the default tuple checker (the K-34 assertion needs a
// real check to record). `atomicMod` is in `contractTestModules`, so the ScopeDO
// already carries it at code time — a DO cannot be handed handlers over RPC.
atomicContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// K-42 (#868): acting as a principal with the real actor preserved. The DEFAULT
// tuple checker, not allow-all — half of what this suite pins is that the door
// grants no authority of its own, and an allow-all checker would make the one
// test that proves it (a session against a principal who holds nothing) pass for
// the wrong reason.
impersonationContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #1672: capabilities, on the DO path — the ScopeDO's own SQLite holds the capability row,
// resolves the session inside its queue, and runs the kernel's checker branch; the
// coordinator hashes the session token and refuses a success the DO did not acknowledge.
// The DEFAULT tuple checker, for the impersonation suite's reason. `capMod` is in
// `contractTestModules`, so the ScopeDO carries it at code time. The expiry TRANSITIONS are
// asserted on the pure host only (the DO takes no clock, #956) — both hosts call one
// `capabilityLive` predicate, which the kernel's evaluator tests pin directly.
capabilityContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #1686: attachments through a capability, on the DO path — the ScopeDO resolves the
// session hash inside its queue and checks each read as `{ capability }`; the coordinator
// holds the bytes. The per-tenant bucket is an in-memory `R2Bucket` slice and the bucket
// manager a stub, as in `attachments.test.ts`: what is under test is the gate, not R2.
capabilityAttachmentContractSuite('adapter-cloudflare', async () => {
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
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// The schedule suite (#383) also runs against the default tuple checker — it must
// resolve the projected system grant, not an allow-all.
scheduleContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #1577: the resumable-run driver, on the DURABLE half of D-14 — the run record and
// the step ledger live in the scope DO, the pass engine on the coordinator. The
// DEFAULT tuple checker: a job's steps act through the system door, and what they
// may do has to resolve through the real grant (`jobsMod` declares no schedules, so
// the suite writes the system grant itself).
jobRunContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #1666: the schedule kill switch, on the adapter that is deployed — the gate and the
// switch both run in the scope DO. The DEFAULT checker: what the switch stops is a system
// principal's own `ctx.check`, which an allow-all would pass regardless.
systemSwitchContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

/**
 * #1666 on the SHARED control plane's host: `systemSwitchDelegation` set, as
 * `apps/control-plane` sets it. A hosted scope's grants live in its vertical's deployment,
 * and this host's own `SCOPE` namespace is the placeholder — so the switch must be moved
 * THERE and audited HERE. The far end is a recording fake; the real one (the VerticalClient
 * against a deployed vertical's `/internal/system-switch`) is proven in `demos/meridian`.
 *
 * The placeholder is not empty in this test, deliberately: the scope is provisioned on
 * this host, so its own DO holds a live grant. That is what makes "the placeholder was
 * not switched" observable — its schedules still fire after the delegated revoke.
 */
describe('#1666 — the switch is moved in the serving deployment, and audited here', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  type Call = { tenantId: string; scopeId: string; moduleId: string; to: 'on' | 'off' };

  const setup = async (
    answer: (call: Call) => { held: boolean; changed: boolean; permissions: string[] },
    /** `null` provisions a scope bound to no vertical. */
    vertical: string | null = 'sched-vertical',
  ) => {
    const calls: Call[] = [];
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      systemSwitchDelegation: {
        switch: async (a) => {
          calls.push({ ...a });
          const out = answer(a);
          return { ...out, permissions: out.permissions.map((p) => permissionKey.parse(p)) };
        },
      },
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `hosted-${t.slice(-10).toLowerCase()}`, name: 'Hosted' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, ...(vertical ? { vertical } : {}) });
    await host.admin.activateScope(staff, t, s);
    const audit = () => host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['revokeFromSystem', 'restoreToSystem'] });
    return { host, t, s, calls, audit };
  };

  /** The admin-log rows for one scope, flattened: action + the `after` payload. */
  const rows = async (
    audit: () => Promise<{ action: string; vertical: string | null; after: unknown }[]>,
  ): Promise<Record<string, unknown>[]> =>
    (await audit()).map((e) => ({ action: e.action, vertical: e.vertical, ...(e.after as Record<string, unknown>) }));

  it('delegates the write, leaves the placeholder alone, and audits intent then outcome here, with the reason', async () => {
    const { host, t, s, calls, audit } = await setup(() => ({ held: true, changed: true, permissions: ['sched:tick'] }));
    const result = await host.admin.revokeFromSystem(staff, {
      moduleId: SCHED,
      node: { tenantId: t, scopeId: s },
      reason: 'incident 42',
    });
    expect(result).toEqual({
      operationId: expect.any(String),
      moduleId: SCHED,
      schedules: 'off',
      changed: true,
      permissions: ['sched:tick'],
    });
    expect(calls).toEqual([{ tenantId: t, scopeId: s, moduleId: SCHED, to: 'off' }]);
    // The placeholder DO still holds its live grant and no marker: nothing was written here.
    expect((await host.runDueSchedules(SCHED, t, s)).fired).toBe(2);
    const common = { action: 'revokeFromSystem', vertical: 'sched-vertical', operationId: result.operationId, moduleId: SCHED, schedules: 'off' };
    expect(await rows(audit)).toEqual([
      { ...common, phase: 'intent', reason: 'incident 42' },
      { ...common, phase: 'applied', changed: true, permissions: ['sched:tick'] },
    ]);

    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'ok' });
    expect(calls.at(-1)).toEqual({ tenantId: t, scopeId: s, moduleId: SCHED, to: 'on' });
    expect((await rows(audit)).map((r) => [r.action, r.phase])).toEqual([
      ['revokeFromSystem', 'intent'],
      ['revokeFromSystem', 'applied'],
      ['restoreToSystem', 'intent'],
      ['restoreToSystem', 'applied'],
    ]);
  });

  it('a far end that holds nothing is a 404 audited as refused, and a no-op is still audited', async () => {
    let held = false;
    const { host, t, s, audit } = await setup(() => ({ held, changed: false, permissions: [] }));
    const input = { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'r' };
    const refused = await host.admin.revokeFromSystem(staff, input).then(() => null, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('not_found');
    held = true;
    expect(await host.admin.revokeFromSystem(staff, input)).toMatchObject({ changed: false });
    expect((await rows(audit)).map((r) => [r.phase, r.changed])).toEqual([
      ['intent', undefined],
      ['refused', false],
      ['intent', undefined],
      ['applied', false],
    ]);
  });

  it('a far end that fails fails the verb, and the audit shows the intent and the failure', async () => {
    const { host, t, s, audit } = await setup(() => {
      throw new Error('vertical unreachable during system-switch: Durable Object reset');
    });
    await expect(
      host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'r' }),
    ).rejects.toThrow(/unreachable/);
    const log = await rows(audit);
    expect(log.map((r) => r.phase)).toEqual(['intent', 'failed']);
    expect(log[1]).toMatchObject({ operationId: log[0]!.operationId, error: expect.stringMatching(/unreachable/) });
  });

  it('a retry after the far end moved but the answer was lost is audited too — changed: false is no excuse', async () => {
    // The far end applies the switch and THEN the answer is lost (a crash between the
    // mutation and the outcome row looks the same from the log's side). The retry finds
    // it already off and answers `changed: false` — and still leaves its own pair of rows.
    let off = false;
    let lose = true;
    const { host, t, s, audit } = await setup(() => {
      const changed = !off;
      off = true;
      if (lose) {
        lose = false;
        throw new Error('vertical unreachable during system-switch: connection reset after write');
      }
      return { held: true, changed, permissions: changed ? ['sched:tick'] : [] };
    });
    const input = { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'retry me' };
    await expect(host.admin.revokeFromSystem(staff, input)).rejects.toThrow(/connection reset/);
    expect(await host.admin.revokeFromSystem(staff, input)).toMatchObject({ changed: false });
    const log = await rows(audit);
    expect(log.map((r) => r.phase)).toEqual(['intent', 'failed', 'intent', 'applied']);
    expect(log[0]!.operationId).not.toBe(log[2]!.operationId);
    expect(log[3]).toMatchObject({ operationId: log[2]!.operationId, changed: false });
  });

  it("the DO's pre-#1666 `hasSystemGrant` answers the new question — a coordinator a deploy behind cannot run a switched-off scope", async () => {
    // Not delegated: the switch is moved in THIS host's own DO, which is the one asked.
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `legacy-${t.slice(-10).toLowerCase()}`, name: 'Legacy' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    await host.admin.activateScope(staff, t, s);
    const raw = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as { hasSystemGrant(m: string): Promise<boolean> };
    const node = { tenantId: t, scopeId: s };
    expect(await raw.hasSystemGrant(SCHED)).toBe(true);
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    // The marker is itself a live `system:` tuple — exactly what the old predicate ("any
    // live system: tuple") would have counted as a grant.
    expect(await raw.hasSystemGrant(SCHED)).toBe(false);
    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    expect(await raw.hasSystemGrant(SCHED)).toBe(true);
  });

  it('a scope bound to no vertical is switched locally, never through the delegation (#1666 review)', async () => {
    const { host, t, s, calls, audit } = await setup(() => {
      throw new Error('no deployment serving scope (the delegation must not be reached)');
    }, null);
    const node = { tenantId: t, scopeId: s };
    // A module it never held: the local no-grant outcome — `not_found` "holds no system
    // grant" — rather than the delegation's "no deployment serving scope".
    const refused = await host.admin
      .revokeFromSystem(staff, { moduleId: moduleId.parse('@test/never-held'), node, reason: 'r' })
      .then(() => null, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('not_found');
    expect(String(refused)).toMatch(/holds no system grant/);
    // A module it does hold (provisioning seats a registered module's schedule grant with
    // or without a vertical): the switch moves in THIS host's DO, which is where the
    // scope's store is, and its schedules stop.
    expect(await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' })).toMatchObject({
      schedules: 'off',
      changed: true,
      permissions: ['sched:tick'],
    });
    expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 0, switchedOff: true });
    expect(calls).toEqual([]);
    expect((await rows(audit)).map((r) => [r.phase, r.vertical])).toEqual([
      ['intent', null],
      ['refused', null],
      ['intent', null],
      ['applied', null],
    ]);
  });

  it('twin: a scope WITH a vertical and no serving deployment still reaches the delegation, and fails loudly', async () => {
    const { host, t, s, calls, audit } = await setup(() => {
      throw new Error("no deployment serving scope (vertical 'sched-vertical') — cannot switch its schedules off");
    });
    await expect(
      host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'r' }),
    ).rejects.toThrow(/no deployment serving scope/);
    expect(calls).toEqual([{ tenantId: t, scopeId: s, moduleId: SCHED, to: 'off' }]);
    expect((await rows(audit)).map((r) => r.phase)).toEqual(['intent', 'failed']);
  });

  it('refuses a scope the directory does not have before reaching anything', async () => {
    const { host, t, calls } = await setup(() => ({ held: true, changed: true, permissions: [] }));
    const refused = await host.admin
      .revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: scopeId.parse(ulid()) }, reason: 'r' })
      .then(() => null, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('not_found');
    expect(calls).toEqual([]);
  });
});

/**
 * #1666's two write-side guarantees on DO SQLite, each with the one lever a contract suite
 * cannot hold: a newer VERSION of a module (a second facade registering a manifest that
 * declares one more schedule permission — the coordinator's `provisionScope` seats from
 * the facade's registrations), and a grant revoked independently of the switch (a raw
 * K-21 tombstone, since no verb revokes one `system:` grant).
 */
describe('#1666 — OFF holds against a newer version, and ON gives back only what OFF took', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  const hostWith = (mod: typeof scheduleMod) => {
    const h = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    h.registerModule(mod);
    return h;
  };
  /** The same module, one version on: its tick schedule now also declares `sched:admin`. */
  const newer: typeof scheduleMod = {
    ...scheduleMod,
    manifest: {
      ...scheduleMod.manifest,
      schedules: scheduleMod.manifest.schedules!.map((sch, i) =>
        i === 0 ? { ...sch, permissions: [...sch.permissions, permissionKey.parse('sched:admin')] } : sch,
      ),
    },
  };
  const raw = (s: string) =>
    env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as {
      revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean>;
      introspectQuery(sql: string): Promise<{ rows: unknown[][] }>;
    };
  const grants = async (s: string): Promise<[string, boolean][]> =>
    (
      await raw(s).introspectQuery(
        `SELECT relation, revoked_at FROM _substrat_tuples WHERE subject = 'system:${SCHED}' AND substr(relation, 1, 8) = 'granted:' ORDER BY relation`,
      )
    ).rows.map((r) => [String(r[0]), r[1] !== null]);
  const newScope = async () => {
    const host = hostWith(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `hold-${t.slice(-10).toLowerCase()}`, name: 'Hold' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    await host.admin.activateScope(staff, t, s);
    return { host, t, s, node: { tenantId: t, scopeId: s } };
  };

  it("a reconcile of a newer version seats none of its new permission while the switch is off — and does, once it is on", async () => {
    const { host, t, s, node } = await newScope();
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    await hostWith(newer).provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    expect(await grants(s)).toEqual([['granted:sched:tick', true]]); // no `sched:admin` at all

    // The twin: restored, the same reconcile seats the new permission live.
    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    await hostWith(newer).provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    expect(await grants(s)).toEqual([
      ['granted:sched:admin', false],
      ['granted:sched:tick', false],
    ]);
  });

  it('a grant revoked independently BEFORE the switch stays revoked through OFF and ON; the one OFF took comes back', async () => {
    const { host, s, node } = await newScope();
    await host.admin.grantToSystem(staff, { moduleId: SCHED, permission: permissionKey.parse('sched:admin'), node, grantedBy: staff });
    await raw(s).revokeTuple(`system:${SCHED}`, 'granted:sched:admin', `scope:${s}`, '2026-09-01T00:00:00.000Z');
    expect(await grants(s)).toEqual([
      ['granted:sched:admin', true],
      ['granted:sched:tick', false],
    ]);
    expect((await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' })).permissions).toEqual(['sched:tick']);
    expect((await host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'r' })).permissions).toEqual(['sched:tick']);
    expect(await grants(s)).toEqual([
      ['granted:sched:admin', true], // still revoked — ON never widens the system principal
      ['granted:sched:tick', false],
    ]);
  });
});

/**
 * The Cloudflare half of #32 — the same guarantee the pure adapter asserts, on the
 * adapter that is actually deployed. It matters more here: the projection is done
 * by the COORDINATOR after the ScopeDO reports, so a rejected `migrate()` used to
 * skip the write entirely and leave the scope rendering as healthy.
 *
 * Points at BROKEN_SCOPE (worker.ts) — a DO class carrying only the module whose
 * migration cannot apply, since a DO closes over a code-time module set.
 *
 * Lives in THIS file rather than its own: the pool runs `singleWorker` with
 * `isolatedStorage: false`, and a second test file re-evaluates the worker mid-run,
 * which invalidates every live DO ("worker.ts changed").
 */
describe('migration failure is recorded in the directory', () => {
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.BROKEN_SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    // Default-deny (§4.3): without the grant the module never loads and its
    // migration never runs, so this suite would pass vacuously.
    await host.admin.grantEntitlement(staff, t, 'broken');
    await expect(
      host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' }),
    ).rejects.toThrow(/scope fails closed/);
  });

  afterAll(async () => {
    await host.close();
  });

  it('fails the scope closed rather than serving a half-migrated schema', async () => {
    await expect(host.getScope(alice, t, s)).rejects.toThrow(/scope fails closed/);
  });

  it('records which module@version failed, through the coordinator', async () => {
    const record = await host.admin.getScopeRecord(staff, t, s);
    expect(record?.migrationFailure).not.toBeNull();
    expect(record?.migrationFailure?.version).toBe('@test/broken@0002-broken');
    expect(record?.migrationFailure?.attempts).toBeGreaterThan(0);
  });

  it('projects the count that actually landed, not the pre-attempt value', async () => {
    const record = await host.admin.getScopeRecord(staff, t, s);
    expect(record?.schemaVersion).toBe('1');
  });

  /**
   * The #49 retry affordance, proven at the exact seam the issue named: the
   * ScopeDO memoises its migration promise, and a REJECTED promise stays
   * assigned — so an ordinary wake on a warm instance returns the cached
   * rejection without re-attempting anything. The instance-run counter is the
   * observable that tells the two apart (the directory's `attempts` cannot:
   * the coordinator increments it on cached rejections too).
   */
  it('migrateScope defeats the memoised rejection — a fresh attempt, not the cached one (#49)', async () => {
    interface MigrationProbe {
      migrationAttemptsOnInstance(): Promise<number>;
    }
    const probe = env.BROKEN_SCOPE.get(env.BROKEN_SCOPE.idFromName(s)) as unknown as MigrationProbe;
    const before = await probe.migrationAttemptsOnInstance();
    expect(before).toBeGreaterThan(0);

    // The ordinary wake: rejects, but from the cache — no new run on this instance.
    await expect(host.getScope(alice, t, s)).rejects.toThrow(/scope fails closed/);
    expect(await probe.migrationAttemptsOnInstance()).toBe(before);

    // The sweep's door: clears the latch, actually re-runs, reports structurally.
    const outcome = await host.migrateScope(t, s);
    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { version: '@test/broken@0002-broken' },
    });
    expect(await probe.migrationAttemptsOnInstance()).toBe(before + 1);
  });

  it('each retry advances the directory attempt counter, so the sweep can back off (#49)', async () => {
    const read = async () =>
      (await host.admin.getScopeRecord(staff, t, s))?.migrationFailure?.attempts ?? 0;
    const before = await read();
    expect(before).toBeGreaterThan(0);
    await host.migrateScope(t, s);
    expect(await read()).toBe(before + 1);
  });
});

/**
 * The Cloudflare half of #1589 — and the half the shared contract suite cannot state.
 *
 * `scopeHostContractSuite` asserts the CONTRACT (a restore whose dump omits a module
 * table leaves that table working afterwards), which is what makes the two adapters
 * agree. What it cannot say is WHY this adapter used to break it: `ensureMigrations`
 * memoises its pass in `migrationPromise`, so a WARM ScopeDO kept answering
 * "migrations are done" over a scope whose tables the dump had just dropped — until
 * an eviction or `migrateScope`, neither of which a restore triggers. Dev, CI and
 * self-host are all green on the pure host, which re-reads its applied set on every
 * pass, so nothing but a warm DO reproduces it.
 *
 * `migrationAttemptsOnInstance` is the observable that makes "warm" a fact rather
 * than an assumption, exactly as it is for #49 above: it counts passes on THIS
 * instance. A count that goes 1 → 2 across the restore can only be one instance
 * running a second pass — a DO evicted and reconstructed in between would report 1,
 * its own first.
 *
 * Lives in THIS file for the reason the block above gives: a second test file
 * re-evaluates the worker mid-run and invalidates every live DO, which is the one
 * thing a warm-instance test cannot survive.
 */
describe('a restore forgets the memoised migration pass (#1589)', () => {
  interface MigrationProbe {
    migrationAttemptsOnInstance(): Promise<number>;
  }
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      checker: UNSAFE_allowAllChecker,
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    // Default-deny (§4.3): without the grant `@test/mod` never loads, its migration
    // never runs, and every assertion below would pass over an absent module.
    await host.admin.grantEntitlement(staff, t, 'testmod');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' });
    await host.admin.activateScope(staff, t, s);
  });

  afterAll(async () => {
    await host.close();
  });

  it('re-runs the pass on the SAME instance, so the dump-dropped table comes back', async () => {
    const probe = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as MigrationProbe;
    // Warm it: one real operation, so the pass is memoised before the dump lands.
    const warm = await host.getScope(alice, t, s);
    await warm.invoke('testmod/add', { id: 'before-restore', box: 'b1' });
    const passes = await probe.migrationAttemptsOnInstance();
    expect(passes).toBe(1); // provisioning's pass, and nothing since

    // A targeted repair dump: `@test/mod`'s tables and its journal rows removed,
    // everything else as captured. Both tables go — one migration creates the pair.
    const backup = await host.admin.exportScope(staff, t, s);
    const journal = backup.tables.find((tbl) => tbl.name === '_substrat_migrations')!;
    const moduleCol = journal.columns.indexOf('module_id');
    expect(journal.rows.some((r) => r[moduleCol] === '@test/mod')).toBe(true);
    await host.restoreScope(staff, t, s, {
      ...backup,
      tables: backup.tables
        .filter((tbl) => tbl.name !== 'testmod_items' && tbl.name !== 'testmod_notes')
        .map((tbl) =>
          tbl.name === '_substrat_migrations'
            ? { ...tbl, rows: tbl.rows.filter((r) => r[moduleCol] !== '@test/mod') }
            : tbl,
        ),
    });
    // The restore itself migrates nothing — it only forgets that a pass ever ran.
    expect(await probe.migrationAttemptsOnInstance()).toBe(passes);

    // The next operation is what re-runs it. Pre-fix this threw `no such table:
    // testmod_items`, because the memoised promise answered before the set was read.
    const after = await host.getScope(alice, t, s);
    await after.invoke('testmod/add', { id: 'after-restore', box: 'b1' });
    expect(await after.invoke<{ id: string }[]>('testmod/read-items')).toEqual([
      { id: 'after-restore' },
    ]);
    // …on the instance that had already migrated. A cold one would read 1 here.
    expect(await probe.migrationAttemptsOnInstance()).toBe(passes + 1);
  });
});

/**
 * Scope-local permissions, Phase 1 (docs/architecture/scope-local-permissions.md): the
 * ScopeDO can evaluate a tenant-level role from its OWN projected storage instead
 * of the control-plane DO. This proves the local reader is parity with RPC, that a
 * tombstoned projection stops granting, and — the load-bearing safety property —
 * that flipping a scope to 'local' WITHOUT projecting denies (fail closed), even
 * where the RPC path would have allowed. Lives in this file for the same
 * single-worker reason as the block above.
 */
describe('scope-local permissions — the projected local reader (Phase 1)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const sProj = scopeId.parse(ulid()); // projected → local
  const sEmpty = scopeId.parse(ulid()); // flipped to local with nothing projected
  const alice = principalId.parse(ulid());
  const PERM_ADMIN = permissionKey.parse('perm:admin');
  let host: CloudflareScopeHost;

  const probe = async (scope: typeof sProj): Promise<boolean> =>
    (await (await host.getScope(alice, t, scope)).invoke<{ allowed: boolean }>('perm/probe', { permission: PERM_ADMIN }))
      .allowed;

  interface ProjectionRpc {
    projectRole(tenantId: string, role: { key: string; permissions: string[]; source: string }): Promise<void>;
    projectTenantTuple(tenantId: string, subject: string, relation: string, object: string, expiresAt: string | null, revokedAt?: string | null): Promise<void>;
    revokeProjectedRole(tenantId: string, key: string, revokedAt: string): Promise<void>;
    setPermissionSource(source: 'local' | 'control-plane'): Promise<void>;
  }
  const projection = (scope: string): ProjectionRpc =>
    env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as ProjectionRpc;

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'perm'); // default-deny (§4.3)
    for (const s of [sProj, sEmpty]) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t, s);
    }
    // A tenant-level role — lands in the control plane, so it resolves for BOTH
    // scopes over RPC until one is flipped to local.
    await host.admin.defineRole(staff, t, { key: 'admin', permissions: [PERM_ADMIN], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
  });

  afterAll(async () => host.close());

  it('resolves via RPC by default, then identically via the local projection', async () => {
    expect(await probe(sProj)).toBe(true); // RPC baseline

    const p = projection(sProj);
    await p.projectRole(t, { key: 'admin', permissions: [PERM_ADMIN], source: 'vertical' });
    await p.projectTenantTuple(t, `principal:${alice}`, 'role:admin', `tenant:${t}`, null);
    await p.setPermissionSource('local');
    expect(await probe(sProj)).toBe(true); // now resolved locally — parity
  });

  it('a tombstoned projected role stops granting (K-21)', async () => {
    await projection(sProj).revokeProjectedRole(t, 'admin', new Date().toISOString());
    expect(await probe(sProj)).toBe(false);
  });

  it('fails closed: local source with nothing projected denies, though RPC would allow', async () => {
    expect(await probe(sEmpty)).toBe(true); // RPC still allows — the role is in the control plane
    await projection(sEmpty).setPermissionSource('local'); // flip WITHOUT projecting
    expect(await probe(sEmpty)).toBe(false); // empty projection ⇒ deny
  });
});

/**
 * Scope-local permissions, Phase 2: with `scopeLocalPermissions` ON, the host
 * PROJECTS a tenant's roles/tuples into its scopes on every tenant-level write and
 * evaluates locally. This exercises the automatic fan-out end to end — including the
 * subtle cases: a tenant role assigned AFTER its scopes exist must still reach them,
 * a membership tombstone must fan out, and `reconcileTenantProjection` must repair a
 * stale scope. (The full permission MODEL is already covered by the RPC contract
 * suite above; this asserts the projection machinery, not the checker algebra.)
 */
describe('scope-local permissions — automatic fan-out on write (Phase 2)', () => {
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const s2 = scopeId.parse(ulid());
  const alice = principalId.parse(ulid()); // tenant-level admin
  const bob = principalId.parse(ulid()); // scope role at s1 only
  const carol = principalId.parse(ulid()); // org member
  const acme = orgId.parse(ulid());
  const ADMIN = permissionKey.parse('perm:admin');
  const READ = permissionKey.parse('perm:read');

  const probe = async (who: typeof alice, scope: typeof s1, perm: typeof ADMIN): Promise<boolean> =>
    (await (await host.getScope(who, t, scope)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm })).allowed;

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      scopeLocalPermissions: true,
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    // Scopes exist FIRST — so the assignments below must fan OUT into them, the
    // case a "project at provision" alone would miss.
    for (const s of [s1, s2]) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t, s);
    }
    await host.admin.defineRole(staff, t, { key: 'admin', permissions: [ADMIN, READ], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'tech', permissions: [READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
    await host.admin.assignRole(staff, { principalId: bob, roleKey: 'tech', node: { tenantId: t, scopeId: s1 } });
    await host.admin.createOrg(staff, { id: acme, tenantId: t, slug: 'acme', name: 'Acme' });
    await host.admin.addMember(staff, t, carol, acme);
    await host.admin.grantToOrg(staff, acme, READ, { tenantId: t, scopeId: null });
  });

  afterAll(async () => host.close());

  it('does not project into an archived scope', async () => {
    // A tenant-level write fans out to every scope in the tenant. Unfiltered, that
    // included `archived` and `reaped` rows — and a reaped scope's storage was
    // deliberately `deleteAll()`d ("the bytes are gone, so there is no restore",
    // tenancy.ts), so a projection write would recreate storage for a scope the
    // platform believes dead: silently, on every membership change, and unboundedly
    // in the number of apps a tenant has ever archived.
    //
    // Observed through the scope DO directly, because `getScope` fails closed on an
    // archived scope either way — reading its own projected rows is the only way to
    // tell "we did not write" from "we cannot look".
    const dead = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: dead, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, dead);
    await host.admin.archiveScope(staff, t, dead);

    const dave = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: dave, roleKey: 'admin', node: { tenantId: t, scopeId: null } });

    // The live scopes converged…
    expect(await probe(dave, s1, ADMIN)).toBe(true);
    expect(await probe(dave, s2, ADMIN)).toBe(true);

    const tuplesOf = async (scope: string): Promise<string> => {
      const rpc = env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as {
        introspectTable(table: string, limit: number, offset: number): Promise<{ rows: unknown[] }>;
      };
      return JSON.stringify((await rpc.introspectTable('_substrat_tenant_tuples', 200, 0)).rows);
    };
    // …and the archived scope did not receive the new principal, while a live one did
    // — the second assertion is what proves the first is about the FILTER rather than
    // about the fan-out having failed everywhere.
    expect(await tuplesOf(s1)).toContain(dave);
    expect(await tuplesOf(dead)).not.toContain(dave);
  });

  it('unarchive refreshes the projection — a revoke that landed while archived holds (#1473)', async () => {
    // The other half of the filter above. An archived scope is skipped by every
    // fan-out, so a tenant-level revoke never reaches its local projection — and an
    // unarchive that only flipped the directory status would put that stale
    // projection back on duty: the revoked principal keeps their access on the
    // revived scope until the next tenant-level write or the reconciliation sweep.
    // Before #1386 every fan-out reached archived scopes, so this window is new.
    const parked = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: parked, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, parked);

    const erin = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: erin, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
    expect(await probe(erin, parked, ADMIN)).toBe(true);

    await host.admin.archiveScope(staff, t, parked);
    // Revoked while archived: the tombstone fans out to the live scopes only.
    await host.admin.unassignRole(staff, { principalId: erin, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
    expect(await probe(erin, s1, ADMIN)).toBe(false);

    await host.admin.unarchiveScope(staff, t, parked);

    // Denied on the revived scope — and the positive control beside it is what proves
    // the denial comes from a REFRESHED projection rather than from an empty one
    // failing closed: alice's tenant-level role was never revoked, and still serves.
    expect(await probe(erin, parked, ADMIN)).toBe(false);
    expect(await probe(alice, parked, ADMIN)).toBe(true);
  });

  it('unarchive holds a revoke that lands BETWEEN its snapshot and the flip (#1473)', async () => {
    // The interleaving a single push-then-flip cannot cover. `projectScope` reads the
    // tenant's state, then writes it; a revoke that commits in between fans out to the
    // scopes live at that moment — and this one is still archived, so its fan-out
    // skips it — and the flip then puts the OLDER snapshot on duty. The revoked
    // principal keeps their access on the revived scope until the next fan-out or the
    // sweep, exactly the window the unarchive refresh was meant to close.
    //
    // Pinned by driving the revoke from inside the gap: a second host over the same
    // DOs, whose control-plane stub runs the revoke the first time `getScopeRecord` is
    // read — which `projectScope` does after its snapshot and before its write.
    const parked = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: parked, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, parked);
    const frank = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: frank, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
    expect(await probe(frank, parked, ADMIN)).toBe(true);
    await host.admin.archiveScope(staff, t, parked);

    let armed = true;
    const real = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as Record<string, unknown>;
    const tapped = new Proxy(real, {
      get(target, prop) {
        if (prop === 'getScopeRecord') {
          return async (...args: unknown[]) => {
            const record = await (target.getScopeRecord as (...a: unknown[]) => Promise<unknown>)(...args);
            if (armed) {
              armed = false;
              // The revoke lands on the directory and fans out — to the live scopes.
              await host.admin.unassignRole(staff, { principalId: frank, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
            }
            return record;
          };
        }
        // Every other method forwards through a closure. Not `.bind`: a property of an
        // RPC stub is itself a pipelined call, so binding it would try to send the
        // stub over the wire.
        const v = Reflect.get(target, prop);
        return typeof v === 'function'
          ? (...args: unknown[]) => (target[prop as string] as (...a: unknown[]) => unknown)(...args)
          : v;
      },
    });
    const racing = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: { idFromName: () => ({}) as never, get: () => tapped as never } as unknown as typeof env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      scopeLocalPermissions: true,
    });
    try {
      await racing.admin.unarchiveScope(staff, t, parked);
    } finally {
      await racing.close();
    }
    expect(armed).toBe(false); // the revoke really ran inside the gap
    expect(await probe(frank, s1, ADMIN)).toBe(false);
    // Denied on the revived scope too — the post-flip refresh caught the revoke the
    // first snapshot predated. The positive control is the same as above.
    expect(await probe(frank, parked, ADMIN)).toBe(false);
    expect(await probe(alice, parked, ADMIN)).toBe(true);
  });

  it('refuses a projection that arrives AFTER the scope was reaped', async () => {
    // The residual race the status filter alone cannot close: fan-out selects live
    // scopes, then writes, and a reap can land between the two. The selected scope
    // was legitimately live when chosen, so the projection is already in flight when
    // its bytes are destroyed — and `destroyStorage` is `deleteAll()`, which leaves a
    // DO indistinguishable from a fresh one. Without a fence the late write silently
    // recreates storage for a scope the platform believes gone.
    const doomed = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: doomed, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, doomed);

    const rpc = env.SCOPE.get(env.SCOPE.idFromName(doomed)) as unknown as {
      destroyStorage(): Promise<void>;
      applyProjection(
        tenantId: string,
        roles: { role_key: string; permissions: string; source: string }[],
        tuples: unknown[],
      ): Promise<void>;
      introspectTable(table: string, limit: number, offset: number): Promise<{ rows: unknown[] }>;
    };

    // The reap happens, then the in-flight projection lands.
    await rpc.destroyStorage();
    await rpc.applyProjection(t, [{ role_key: 'admin', permissions: '["perm:admin"]', source: 'vertical' }], []);

    // Dropped, not applied — and the observation is stronger than an empty table:
    // the table does not EXIST. `deleteAll()` took it, and the refused projection
    // did not bring it back, so the scope's storage stays genuinely destroyed
    // rather than resurrected holding the tenant's roles, tuples and identity links.
    await expect(rpc.introspectTable('_substrat_roles', 200, 0)).rejects.toThrow(/unknown table/);
  });

  it('a tenant role fans out to scopes that already existed when it was assigned', async () => {
    expect(await probe(alice, s1, ADMIN)).toBe(true);
    expect(await probe(alice, s2, ADMIN)).toBe(true);
  });

  it('a scope role stays confined to its scope', async () => {
    expect(await probe(bob, s1, READ)).toBe(true);
    expect(await probe(bob, s2, READ)).toBe(false);
  });

  it('org membership + an org grant fan out (rule 4)', async () => {
    expect(await probe(carol, s1, READ)).toBe(true);
  });

  it('revoking a membership fans the tombstone out — access stops', async () => {
    await host.admin.removeMember(staff, t, carol, acme);
    expect(await probe(carol, s1, READ)).toBe(false);
  });

  it('projects a connection\'s PUBLIC sealing key, and a scope seals to it (#687)', async () => {
    // The whole carrier on the DO adapter, end to end: the platform mints the
    // keypair in the directory, projects only the public half into the scope, module
    // code seals to it without any control-plane binding, and the connector opens the
    // envelope with a private half that never left the directory.
    //
    // This is the shape a hosted vertical runs — the scope reads its own storage and
    // nothing else — and it is the only way a scope can hand a connector a value the
    // spine must not carry in the clear.
    const conn = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: conn,
      tenantId: t,
      vertical: 'perm-vertical',
      provider: 'sealed-provider',
      label: 'Sealed provider',
      secret: { accessToken: 'tok' },
      scopes: [],
    });
    // Any tenant-level write fans out; this is the explicit form of the same thing.
    await host.reconcileTenantProjection(t);

    const scope = await host.getScope(alice, t, s1);
    const sealed = await scope.invoke<{ keyId: string; ciphertext: string }>(
      'perm/seal-to-connection',
      { provider: 'sealed-provider', plaintext: 'anna@kund.se' },
    );
    // It names the key that opens it — a cell that cannot is a cell that can never
    // be rotated retroactively.
    expect(sealed.keyId).toContain(conn);
    expect(sealed.ciphertext).not.toContain('anna@kund.se');

    // And only the private half opens it, from where a connector runs.
    const opened = await host.admin.connectionSealingKey(conn);
    expect(opened.keyId).toBe(sealed.keyId);
    let unsealed: string | undefined;
    host.registerConnector('sealed-reader', 'perm.acted', async (ctx) => {
      const c = await ctx.connection('sealed-provider');
      unsealed = await c.unseal(sealed);
    });
    // Any emit will do — what is under test is the connector's side of the seam,
    // reached the way every connector is reached: a delivered event.
    await scope.invoke('perm/authorized-emit', { permission: ADMIN });
    await host.drainDue(t, s1);
    expect(unsealed).toBe('anna@kund.se');
  });

  it('refuses to seal for a provider whose key never reached the scope (#687)', async () => {
    // The deploy-order hazard, fail-closed: between projecting a key and the vertical
    // asking for one, a request must break loudly rather than emit with the value
    // silently dropped — which is the invisible failure the carrier exists to end.
    const scope = await host.getScope(alice, t, s1);
    await expect(
      scope.invoke('perm/seal-to-connection', { provider: 'never-connected', plaintext: 'x' }),
    ).rejects.toThrow(/no 'never-connected' sealing key is available/);
  });

  it('reconcileTenantProjection repairs a scope whose projection drifted', async () => {
    // Simulate a dropped fan-out by wiping s2's projection directly.
    const stub = env.SCOPE.get(env.SCOPE.idFromName(s2)) as unknown as {
      applyProjection(tenantId: string, roles: unknown[], tuples: unknown[]): Promise<void>;
    };
    await stub.applyProjection(t, [], []);
    expect(await probe(alice, s2, ADMIN)).toBe(false); // stale → denies
    await host.reconcileTenantProjection(t);
    expect(await probe(alice, s2, ADMIN)).toBe(true); // repaired
  });
});

/**
 * Scope-local permissions, Phase 3: a host with NO control plane — a scope-local /
 * untrusted vertical. It provisions via `provisionScopeLocal` (grant the owner at
 * scope level + project the role defs) and serves entirely from the scope's own
 * storage. The null-object control plane no-ops the router-gated hot path
 * (validateScopeAccess / entitlement / audit) and throws for the admin surface it
 * genuinely lacks.
 */
describe('scope-local permissions — a CP-less host (Phase 3)', () => {
  let host: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const stranger = principalId.parse(ulid());
  const ADMIN = permissionKey.parse('perm:admin');
  const READ = permissionKey.parse('perm:read');

  const probe = async (who: typeof owner, perm: typeof ADMIN): Promise<boolean> =>
    (await (await host.getScope(who, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm })).allowed;

  beforeAll(async () => {
    // No `controlPlane` — the host runs on the null-object stand-in.
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [ADMIN, READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  });

  afterAll(async () => host.close());

  it("serves the owner's permission from the scope alone — no control plane, entitlement trusted", async () => {
    expect(await probe(owner, ADMIN)).toBe(true);
    expect(await probe(owner, READ)).toBe(true);
  });

  it('denies a stranger (fail closed), still with no control plane', async () => {
    expect(await probe(stranger, ADMIN)).toBe(false);
  });

  it('assignScopeRole grants an invited member the role’s permissions — scope-local, no CP', async () => {
    // The member half of the invite flow: a newly-invited principal, granted the role at
    // scope level, resolves that role's permissions from the scope's own storage.
    const member = principalId.parse(ulid());
    expect(await probe(member, ADMIN)).toBe(false); // no grant yet
    await host.assignScopeRole(s, member, 'office-admin');
    expect(await probe(member, ADMIN)).toBe(true); // now holds the role's perms
    expect(await probe(member, READ)).toBe(true);
    expect(await probe(stranger, READ)).toBe(false); // an un-granted principal is still denied
  });

  it('assignScopeRole to a role the scope never projected grants nothing (fail closed)', async () => {
    const member = principalId.parse(ulid());
    await host.assignScopeRole(s, member, 'not-a-projected-role');
    expect(await probe(member, READ)).toBe(false);
  });

  it('revokeScopeRole takes the role back — the next check is denied (#1161)', async () => {
    const member = principalId.parse(ulid());
    await host.assignScopeRole(s, member, 'office-admin');
    expect(await probe(member, ADMIN)).toBe(true);
    expect(await host.revokeScopeRole(s, member, 'office-admin')).toBe(true);
    expect(await probe(member, ADMIN)).toBe(false);
    expect(await probe(member, READ)).toBe(false);
    // The owner's own seat is untouched — the tombstone is one (principal, role) row.
    expect(await probe(owner, ADMIN)).toBe(true);
  });

  it('revokeScopeRole twice is idempotent — the second is a silent no-op', async () => {
    const member = principalId.parse(ulid());
    await host.assignScopeRole(s, member, 'office-admin');
    expect(await host.revokeScopeRole(s, member, 'office-admin')).toBe(true);
    expect(await host.revokeScopeRole(s, member, 'office-admin')).toBe(false);
    expect(await probe(member, READ)).toBe(false);
  });

  it('revokeScopeRole on a never-assigned role is a no-op, not an error', async () => {
    const member = principalId.parse(ulid());
    expect(await host.revokeScopeRole(s, member, 'office-admin')).toBe(false);
    expect(await host.revokeScopeRole(s, member, 'not-a-projected-role')).toBe(false);
    expect(await probe(member, READ)).toBe(false);
  });

  it('assignScopeRole after revokeScopeRole grants again — the tombstone is replaced', async () => {
    const member = principalId.parse(ulid());
    await host.assignScopeRole(s, member, 'office-admin');
    await host.revokeScopeRole(s, member, 'office-admin');
    expect(await probe(member, ADMIN)).toBe(false);
    await host.assignScopeRole(s, member, 'office-admin');
    expect(await probe(member, ADMIN)).toBe(true);
    expect(await probe(member, READ)).toBe(true);
  });

  it('revokeScopeRole takes back ONE role — a second role the member holds survives', async () => {
    // A projected reader role beside office-admin, so the revoke has a sibling to leave alone.
    const scope = scopeId.parse(ulid());
    const member = principalId.parse(ulid());
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: scope,
      owner,
      roles: [
        { key: 'office-admin', permissions: [ADMIN, READ], source: 'vertical' },
        { key: 'reader', permissions: [READ], source: 'vertical' },
      ],
      ownerRoleKey: 'office-admin',
    });
    const probeIn = async (perm: typeof ADMIN): Promise<boolean> =>
      (await (await host.getScope(member, t, scope)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm })).allowed;
    await host.assignScopeRole(scope, member, 'office-admin');
    await host.assignScopeRole(scope, member, 'reader');
    expect(await probeIn(ADMIN)).toBe(true);
    expect(await host.revokeScopeRole(scope, member, 'office-admin')).toBe(true);
    expect(await probeIn(ADMIN)).toBe(false); // office-admin is gone
    expect(await probeIn(READ)).toBe(true); // reader still holds READ
  });

  it('the admin directory surface throws — it genuinely has no control plane', async () => {
    await expect(
      host.admin.createTenant(platformActorId.parse(ulid()), { id: t, slug: `x-${t.toLowerCase()}`, name: 'X' }),
    ).rejects.toThrow(/control plane unavailable/);
  });
});

/**
 * #461: declared schedules must run on a CP-less host. Two seams, both pinned here:
 * `provisionScopeLocal` projects the `system:<moduleId>` grants (the CP-less mirror of
 * `provisionScope`'s loop — without it the grant-is-the-switch check reports `fired: 0`
 * forever, indistinguishable from "nothing due"), and `runDueSchedules` runs without
 * the directory liveness read a CP-less host cannot answer.
 */
describe('CP-less schedules — declared schedules run without a control plane (#461)', () => {
  let host: CloudflareScopeHost;
  const SCHED = moduleId.parse('@test/sched');
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const READ = permissionKey.parse('perm:read');

  beforeAll(async () => {
    // No `controlPlane` — the null-object stand-in, exactly the hosted-vertical shape.
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  });

  afterAll(async () => host.close());

  it('fires the due schedule from the projected grant alone — no directory, no error', async () => {
    const report = await host.runDueSchedules(SCHED, t, s);
    expect(report.errors).toEqual([]);
    // Two: `sched/tick`, and #1288's collision fixture `freshness:sched.ticked`.
    expect(report.fired).toBe(2);
    // The tick really landed in the scope, attributed to the module, not a person.
    const stub = await host.getScope(owner, t, s);
    expect(await stub.invoke('sched/count')).toBe(1);
    const outbox = (await stub.invoke('sched/read-outbox')) as { type: string; actor: string }[];
    const tick = outbox.find((r) => r.type === 'sched.ticked');
    expect(tick).toBeDefined();
    expect(JSON.parse(tick!.actor)).toEqual({ system: '@test/sched' });
  });

  it('cadence still gates the second pass — skipped, not re-fired', async () => {
    const report = await host.runDueSchedules(SCHED, t, s);
    expect(report.fired).toBe(0);
    expect(report.skipped).toBe(2);
  });

  it('ctx.check stays the gate — the system door is refused an unscheduled permission', async () => {
    // `sched:admin` is declared but never scheduled, so the projection grants the
    // system principal `sched:tick` only — same lever as the CP-full suite.
    const sys = await host.getSystemScope(SCHED, t, s);
    await expect(sys.invoke('sched/needs-admin')).rejects.toThrow();
  });
});

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

  const provision = (scope: typeof s): Promise<void> =>
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
  ): Promise<void> =>
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

// ---------------------------------------------------------------------------
// Appended LAST on purpose. `runPlatformSweep` in the schedule suite above is
// platform-WIDE, so a scope provisioned by any earlier-running file lands in its
// report and turns its `errors` assertion red. Ordering inside one file is
// deterministic; ordering between files is not — so these live here rather than in
// a file of their own.
// ---------------------------------------------------------------------------
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
