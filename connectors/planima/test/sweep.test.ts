import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectionId,
  moduleManifest,
  permissionKey,
  platformActorId,
  scopeId,
  tenantId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  webCryptoSecretBox,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  PlanimaMock,
  bindPlanimaScope,
  listPlanimaBindings,
  planimaConnectionActivity,
  probePlanimaSecret,
  sweepPlanimaPlan,
  syncPlanimaScope,
  unbindPlanimaScope,
  windowFor,
  type PlanimaPlanPage,
} from '../src/index.js';
import { ACTIONS, BUILDINGS, COMPONENTS, FACILITIES } from './fixture.js';

/**
 * The whole inbound path, end to end: a connection is bound to a scope, a sweep walks
 * Planima's paged lists, converts prices to decimal money, and lands the plan through
 * the CONSUMER's own operation as the connection itself (#97).
 *
 * Runs against `PlanimaMock`. What is proven here is that the seam is wired correctly —
 * the bare-token header, the `page[…]` walk, the year window, the per-facility paging,
 * the unchanged-hash skip, the rate-limit throttle, and the refusal to bind without
 * authority. What a mock cannot prove is that our reading of Planima's API is right;
 * the mock IS our reading. That is `test/live.test.ts`'s job, against a real account.
 */
describe('planima connector — inbound sync', () => {
  const PLAN_RECORD = permissionKey.parse('plan:record');
  const OPERATION = 'maintenance/record-plan';
  const REFUSING_OPERATION = 'maintenance/refuse-plan';
  const WINDOW = { fromYear: 2026, toYear: 2030 };

  let dir: string;
  let host: SqliteScopeHost;
  let planima: PlanimaMock;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let connId = connectionId.parse(ulid());
  /** Every page the landing operation received, in order — the assertion surface. */
  let landed: PlanimaPlanPage[] = [];

  /**
   * A stand-in for the consuming vertical: it owns the landing operation and the
   * permission that gates it. Deliberately trivial — what is under test is the seam,
   * not what a real consumer would do with the plan (map it to its own vocabulary,
   * which is exactly the work this connector refuses to do for it).
   */
  const planModule: ModuleRegistration = {
    manifest: moduleManifest.parse({
      id: '@test/plan',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [{ key: 'plan:record', description: 'land an external maintenance plan' }],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entitlementKey: 'plan',
    }),
    operations: {
      [OPERATION]: (async (ctx, input: PlanimaPlanPage) => {
        assertAllowed(await ctx.check(PLAN_RECORD));
        landed.push(input);
        return { ok: true };
      }) as OperationHandler<never, unknown>,
      // A landing operation that refuses — a consumer whose own invariant rejects the
      // page. Gated on the same permission, so what fails is the landing, not the
      // authority: the connector must treat both the same way.
      [REFUSING_OPERATION]: (async (ctx) => {
        assertAllowed(await ctx.check(PLAN_RECORD));
        throw new Error('plan closed for the year');
      }) as OperationHandler<never, unknown>,
    },
  };

  const world = async (opts: { grant?: boolean; mock?: PlanimaMock } = {}) => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-planima-'));
    planima =
      opts.mock ??
      new PlanimaMock({
        // Two organizations on one token — the account shape that makes
        // `organizationId` on a binding load-bearing rather than decorative.
        organizations: [
          { id: 1, name: 'Bostads AB Exempel' },
          { id: 2, name: 'Åkerbacken Fastigheter' },
        ],
        facilities: FACILITIES,
        buildings: BUILDINGS,
        components: COMPONENTS,
        actions: ACTIONS,
      });
    staff = platformActorId.parse(ulid());
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());
    connId = connectionId.parse(ulid());
    landed = [];

    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)),
      fetch: planima.fetch,
    });
    host.registerModule(planModule);

    await host.admin.createTenant(staff, { id: t, slug: 'fastighets', name: 'Fastighets AB' });
    await host.admin.grantEntitlement(staff, t, 'plan');
    await host.provisionScope(staff, {
      tenantId: t,
      scopeId: s,
      jurisdiction: 'eu',
      vertical: 'maintenance',
    });
    await host.admin.activateScope(staff, t, s);

    await host.admin.createConnection(staff, {
      id: connId,
      tenantId: t,
      vertical: 'maintenance',
      provider: 'planima',
      label: 'Fastighets Planima',
      secret: { token: 'planima-test-token' },
    });
    if (opts.grant !== false) {
      await host.admin.grantToConnection(staff, {
        connectionId: connId,
        permission: PLAN_RECORD,
        node: { tenantId: t, scopeId: s },
        grantedBy: staff,
      });
    }
  };

  const bind = (overrides: Partial<Parameters<typeof bindPlanimaScope>[1]> = {}) =>
    bindPlanimaScope(host, {
      connectionId: connId,
      tenantId: t,
      scopeId: s,
      vertical: 'maintenance',
      operation: OPERATION,
      permission: PLAN_RECORD,
      window: WINDOW,
      ...overrides,
    });

  /** Waits are recorded, never slept through — the clock is the test's, as it must be. */
  let waited: number[] = [];
  const options = () => {
    waited = [];
    return {
      fetch: planima.fetch,
      apiBase: planima.apiBase,
      sleep: async (ms: number) => {
        waited.push(ms);
      },
    };
  };

  const only = async () => (await listPlanimaBindings(host, connId))[0]!;

  beforeEach(async () => {
    await world();
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a binding whose grant is missing, naming the permission', async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
    await world({ grant: false });

    // The whole point of bind-time verification: without it this binding is written,
    // and the failure surfaces later in a background timer with a whole maintenance
    // plan already fetched against a 10-per-10-second budget.
    await expect(bind()).rejects.toThrow(/does not hold 'plan:record'/);
    expect(await listPlanimaBindings(host, connId)).toEqual([]);
  });

  it('refuses a window that ends before it starts', async () => {
    await expect(bind({ window: { fromYear: 2030, toYear: 2026 } })).rejects.toThrow(
      /ends before it starts/,
    );
  });

  it('syncs a bound scope end to end, landing the plan through the consumer operation', async () => {
    await bind();
    const result = await syncPlanimaScope(host, connId, await only(), options());

    expect(result.changed).toBe(true);
    expect(result.facilities).toBe(2);
    // Six actions in the fixture, but one is in 2034 — outside the window, and dropped
    // server-side by `start_year`/`end_year` rather than fetched and filtered here.
    expect(result.actions).toBe(5);
    expect(result.pages).toBe(2);
    expect(landed).toHaveLength(2);

    const [first, second] = landed as [PlanimaPlanPage, PlanimaPlanPage];
    // Non-null: a page with a facility is the ordinary case, and `facility: null` is
    // reserved for the clear page a plan with no facilities lands.
    expect(first.facility!.name).toBe('Kvarteret Önskan');
    expect(first.organization).toEqual({ id: 1, name: 'Bostads AB Exempel' });
    expect(first.window).toEqual(WINDOW);
    expect(first.facilityHead).toBe(true);
    expect(first.final).toBe(false);
    expect(second.final).toBe(true);
    expect(second.page).toBe(1);
    expect(second.pageCount).toBe(2);

    // Buildings and components ride the facility's first page and nowhere else.
    expect(first.buildings.map((b) => b.name)).toEqual(['Hus A', 'Hus B']);
    expect(first.components.map((c) => c.name)).toEqual(['Yttertak', 'Fönster']);

    // The conversion this connector exists to make: a JSON float becomes exact decimal
    // money, denominated in the currency the BINDING declared (Planima sends none).
    const roof = first.actions.find((a) => a.name === 'Omläggning yttertak')!;
    expect(roof.totalPrice).toEqual({ amount: '1250000.5', currency: 'SEK' });
    expect(roof.unitPrice).toEqual({ amount: '2500.25', currency: 'SEK' });
    expect(roof.vatRate).toBe('0.25');
    expect(roof.year).toBe(2027);
    expect(roof.status).toBe('planned');
    expect(roof.facilityId).toBe(10);
    expect(roof.tags).toEqual(['tak', 'Q3']);

    // A nullable field Planima sends as an explicit `null` arrives as `null`, not as a
    // missing key and not as a zero.
    const paint = first.actions.find((a) => a.name === 'Fasadmålning')!;
    expect(paint.finalCost).toBeNull();
    expect(paint.componentId).toBeNull();
    expect(paint.description).toBeNull();
  });

  it('passes an unknown status through rather than refusing the plan', async () => {
    // Planima types `status` as a plain string even though it documents eight values,
    // so a ninth is a product change. A closed enum here would fail a whole tenant's
    // sync because one action moved to a status added last week.
    planima.setAction({ ...ACTIONS[0]!, status: 'awaiting_procurement' });
    await bind();
    await syncPlanimaScope(host, connId, await only(), options());
    expect(landed[0]!.actions.find((a) => a.id === ACTIONS[0]!.id)!.status).toBe(
      'awaiting_procurement',
    );
  });

  it('walks every page of a list rather than trusting the first', async () => {
    // Planima caps `page[limit]` at 50 SILENTLY. A client that asks for more and stops
    // after one page syncs a truncated plan and reports success.
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: 5000 + i,
      name: `Komponent ${i}`,
      facility_id: 10,
      category: 'Tak',
      amount: 1,
      unit: 'st',
    }));
    await host.close();
    rmSync(dir, { recursive: true, force: true });
    await world({
      mock: new PlanimaMock({
        facilities: [FACILITIES[0]!],
        buildings: [],
        components: many,
        actions: [],
      }),
    });
    await bind();
    const result = await syncPlanimaScope(host, connId, await only(), options());

    expect(result.changed).toBe(true);
    expect(landed[0]!.components).toHaveLength(120);
    // 50 + 50 + 20 — three requests, and the third is what proves the walk stops on a
    // short page rather than on a guess.
    const componentCalls = planima.requests.filter((r) => r.includes('/components'));
    expect(componentCalls).toHaveLength(3);
    expect(componentCalls[2]).toContain('page%5Boffset%5D=100');
  });

  it('pages a facility with more actions than fit one invoke', async () => {
    const many = Array.from({ length: 1100 }, (_, i) => ({
      id: 9000 + i,
      name: `Åtgärd ${i}`,
      facility_id: 10,
      year: 2028,
      status: 'planned',
      total_price: 1000,
    }));
    await host.close();
    rmSync(dir, { recursive: true, force: true });
    await world({
      mock: new PlanimaMock({ facilities: [FACILITIES[0]!], buildings: [], components: [], actions: many }),
    });
    await bind();
    const result = await syncPlanimaScope(host, connId, await only(), options());

    expect(result.pages).toBe(3);
    expect(landed.map((p) => p.actions.length)).toEqual([500, 500, 100]);
    // The head rides page 0 only, and `final` marks the last page of the whole sync.
    expect(landed.map((p) => p.facilityHead)).toEqual([true, false, false]);
    expect(landed.map((p) => p.final)).toEqual([false, false, true]);
    // Every page carries the same sync id, so a consumer's upsert is idempotent.
    expect(new Set(landed.map((p) => p.syncId)).size).toBe(1);
  });

  it('skips a second sweep when the plan has not changed', async () => {
    await bind();
    const first = await sweepPlanimaPlan(host, connId, options());
    expect(first.synced).toHaveLength(1);
    expect(landed).toHaveLength(2);

    const second = await sweepPlanimaPlan(host, connId, options());
    expect(second.unchanged).toBe(1);
    expect(second.synced).toHaveLength(0);
    // The skip saves the WRITES, not the round trips — Planima offers nothing to ask
    // "has anything changed" cheaply, and claiming otherwise would misprice the sweep.
    expect(landed).toHaveLength(2);
  });

  it('lands again once an action actually changes', async () => {
    await bind();
    await sweepPlanimaPlan(host, connId, options());
    planima.setAction({ ...ACTIONS[0]!, year: 2029, total_price: 1_400_000 });

    const result = await sweepPlanimaPlan(host, connId, options());
    expect(result.synced).toHaveLength(1);
    expect(landed).toHaveLength(4);
    expect(landed[2]!.actions.find((a) => a.id === ACTIONS[0]!.id)!.year).toBe(2029);
    // A different plan is a different sync id — the key a consumer upserts on.
    expect(landed[2]!.syncId).not.toBe(landed[0]!.syncId);
  });

  it('treats a re-read through a different window as a different sync', async () => {
    // The window is in the content hash for exactly this: the rows Planima returns are
    // unchanged, but what LANDS is filtered to the window, so a back-fill over a
    // different range must not be swallowed as "no change".
    await bind();
    await syncPlanimaScope(host, connId, await only(), options());
    const before = landed.length;

    const wider = await syncPlanimaScope(host, connId, await only(), {
      ...options(),
      window: { fromYear: 2026, toYear: 2040 },
    });
    expect(wider.changed).toBe(true);
    expect(landed.length).toBeGreaterThan(before);
    // The 2034 action the narrow window excluded is in the second run's pages. It rides
    // facility 10's page, not the last one — pages are ordered by facility, so "the
    // newest page" is not where a given action lands.
    const second = landed.slice(before);
    expect(second.some((p) => p.actions.some((a) => a.year === 2034))).toBe(true);
    expect(second.every((p) => p.window.toYear === 2040)).toBe(true);
  });

  it('rolls the window forward with the clock when the binding fixes none', async () => {
    const binding = await bind({ window: null, horizonYears: 5 });
    expect(windowFor(binding, Date.parse('2026-09-08T00:00:00Z'))).toEqual({
      fromYear: 2026,
      toYear: 2031,
    });
    // The January problem: a rolling window moves on its own, so the sync identity has
    // to move with it or the new year's actions never land.
    expect(windowFor(binding, Date.parse('2027-01-02T00:00:00Z'))).toEqual({
      fromYear: 2027,
      toYear: 2032,
    });
  });

  it('sits out a rate limit and completes rather than failing the sweep', async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
    await world({
      mock: new PlanimaMock({
        facilities: [FACILITIES[0]!],
        buildings: BUILDINGS,
        components: COMPONENTS,
        actions: ACTIONS,
        rateLimitFirst: 2,
        retryAfterSeconds: 3,
      }),
    });
    await bind();
    const result = await sweepPlanimaPlan(host, connId, options());

    expect(result.failed).toEqual([]);
    expect(result.synced).toHaveLength(1);
    // Planima's own instruction, obeyed — not a backoff of our invention.
    expect(waited).toEqual([3000, 3000]);
  });

  it('reports a refusing landing operation without sinking the pass', async () => {
    await bind({ operation: REFUSING_OPERATION });
    const result = await sweepPlanimaPlan(host, connId, options());

    expect(result.found).toBe(1);
    expect(result.synced).toHaveLength(0);
    expect(result.failed[0]!.error).toMatch(/plan closed for the year/);

    // The cursor must NOT advance on a failure, or the next sweep decides the plan is
    // unchanged and the tenant is left with nothing landed and a green sweep.
    expect((await only()).lastSync).toBeUndefined();
  });

  it('narrows to one organization when the binding names it', async () => {
    await bind({ organizationId: 2 });
    const result = await syncPlanimaScope(host, connId, await only(), options());
    // Facility 20 belongs to organization 2; facility 10 does not.
    expect(result.facilities).toBe(1);
    expect(landed[0]!.facility!.id).toBe(20);
    expect(planima.requests.some((r) => r.includes('organization_id=2'))).toBe(true);
  });

  it('steps over a tombstoned binding', async () => {
    await bind();
    await unbindPlanimaScope(host, connId, s);
    expect(await listPlanimaBindings(host, connId)).toEqual([]);
    const result = await sweepPlanimaPlan(host, connId, options());
    expect(result.found).toBe(0);
    expect(landed).toEqual([]);
  });

  it('refuses a bare-token credential sent with a Bearer prefix', async () => {
    // Planima's `Authorization` is the raw token. The mock refuses a prefix as the
    // provider does, so this asserts the client never grew one.
    const probe = await probePlanimaSecret(
      { token: 'Bearer planima-test-token' },
      { fetch: planima.fetch, apiBase: planima.apiBase },
    );
    expect(probe.ok).toBe(false);
    expect(probe.refused).toBe(true);
  });

  it('probes a good token by naming what it can see', async () => {
    const probe = await probePlanimaSecret(
      { token: 'planima-test-token' },
      { fetch: planima.fetch, apiBase: planima.apiBase },
    );
    expect(probe.ok).toBe(true);
    expect(probe.refused).toBe(false);
    // The question an operator actually has is not "is the token valid" but "does it
    // see the account I meant" — a token from the wrong login is perfectly valid.
    // The token sees two organizations, so no single one names it — the label says how
    // many rather than picking one and implying the other is not there.
    expect(probe.accountLabel).toBe('2 organizations');
    expect(probe.facts).toContainEqual({ label: 'Organizations', value: '2' });
    expect(probe.facts).toContainEqual({
      label: 'Names',
      value: 'Bostads AB Exempel, Åkerbacken Fastigheter',
    });
  });

  it('refuses an incomplete credential without spending a round trip', async () => {
    const probe = await probePlanimaSecret({}, { fetch: planima.fetch, apiBase: planima.apiBase });
    expect(probe.ok).toBe(false);
    expect(probe.refused).toBe(true);
    expect(planima.requests).toEqual([]);
  });

  it('lands an explicit clear page when the plan has become empty', async () => {
    // The failure this prevents: landing NOTHING. A consumer swaps its plan on `final`,
    // so a pass with zero pages leaves last month's facilities in place for ever — while
    // the cursor records the empty plan as synced, so no later sweep repairs it either.
    await host.close();
    rmSync(dir, { recursive: true, force: true });
    await world({ mock: new PlanimaMock({ facilities: [], buildings: [], components: [], actions: [] }) });
    await bind();

    const result = await syncPlanimaScope(host, connId, await only(), options());
    expect(result.changed).toBe(true);
    expect(result.facilities).toBe(0);
    expect(result.pages).toBe(1);

    expect(landed).toHaveLength(1);
    const clear = landed[0]!;
    expect(clear.facility).toBeNull();
    expect(clear.actions).toEqual([]);
    expect(clear.buildings).toEqual([]);
    expect(clear.final).toBe(true);
    expect(clear.pageCount).toBe(1);
  });

  it('refuses a success whose body carries no data array', async () => {
    // `data ?? []` would read a malformed 200 as "this facility has no components any
    // more", land it, and record the hash — so the next sweep sees no change and never
    // repairs it. A missing `data` is a response fault, not an empty list.
    const broken = new PlanimaMock({ facilities: FACILITIES, buildings: BUILDINGS, components: COMPONENTS, actions: ACTIONS });
    const inner = broken.fetch;
    const stripped = (async (input: string, init?: unknown) => {
      const res = await (inner as unknown as (i: string, x?: unknown) => Promise<{
        ok: boolean;
        status: number;
        headers: { get(n: string): string | null };
        text(): Promise<string>;
      }>)(input, init);
      if (!res.ok || !input.includes('/facilities?')) return res;
      // A 200 with the envelope but no rows key — a rewritten body, a partial outage.
      return { ...res, text: async () => JSON.stringify({ pagination: { total_count: 2, offset: 0, limit: 50 } }) };
    }) as unknown as typeof inner;

    await bind();
    const result = await sweepPlanimaPlan(host, connId, { ...options(), fetch: stripped });
    expect(result.synced).toHaveLength(0);
    expect(result.failed[0]!.error).toMatch(/no 'data' array/);
    expect(landed).toEqual([]);
    // And the cursor did not move, so the next sweep retries rather than calling it done.
    expect((await only()).lastSync).toBeUndefined();
  });

  it('refuses to sync when the live connection is not the one the binding names', async () => {
    // Asserts the GUARD, not a reachable production path — and the distinction matters.
    // The directory refuses a second live connection for one (tenant, vertical, provider)
    // and revoking one takes its bindings with it, so the two ids cannot drift apart
    // today. The guard is a backstop for the day Planima grows a per-account credential
    // and `openConnection` starts choosing between rows; this drives it directly by
    // sweeping under an id that is not the live connection's.
    await bind();
    const stranger = connectionId.parse(ulid());
    await expect(
      syncPlanimaScope(host, stranger, await only(), options()),
    ).rejects.toThrow(/the credential that reads and the identity that writes/);
    expect(landed).toEqual([]);
  });

  it('shares one rate-limit window across every binding in a pass', async () => {
    // Planima meters per TOKEN. A per-scope window lets the second scope's first ten
    // requests land on top of the first scope's ten — twenty in one window.
    const second = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: second, jurisdiction: 'eu', vertical: 'maintenance' });
    await host.admin.activateScope(staff, t, second);
    await host.admin.grantToConnection(staff, {
      connectionId: connId,
      permission: PLAN_RECORD,
      node: { tenantId: t, scopeId: second },
      grantedBy: staff,
    });
    await bind();
    await bind({ scopeId: second });

    // A clock that never advances, so the window can only ever be cleared by the
    // throttle waiting — which is exactly what is under test.
    const frozen = Date.parse('2026-09-08T00:00:00Z');
    const opts = { ...options(), now: () => frozen };
    await sweepPlanimaPlan(host, connId, opts);

    // Two scopes × (1 facilities + 3 × 2 facilities) = 14 requests on one token. With a
    // shared window the eleventh onward must wait; with a per-scope window the second
    // scope would start fresh and burst.
    expect(planima.requests.length).toBe(14);
    expect(waited.length).toBe(planima.requests.length - 10);
  });

  it('projects the binding ledger for a console without touching the provider', async () => {
    await bind();
    await sweepPlanimaPlan(host, connId, options());
    const before = planima.requests.length;

    const activity = await planimaConnectionActivity(host, connId);
    expect(activity.live).toBe(false);
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]!.status).toBe('synced');
    expect(activity.entries[0]!.facts).toContainEqual({
      label: 'Lands through',
      value: OPERATION,
    });
    expect(activity.entries[0]!.facts).toContainEqual({ label: 'Facilities', value: '2' });
    // Reads the ledger, never Planima.
    expect(planima.requests).toHaveLength(before);
  });
});
