/**
 * A hosted Meridian's schedule fires (#1646) — in workerd, through the deployed worker.
 *
 * Meridian declares no schedule of its own; it composes engine-absence, whose manifest
 * declares `absence/expire-stale`: a leave still `requested` once its start date has
 * passed can no longer be approved, so the timer cancels it under the engine's system
 * actor. Until #1646 the hosted worker ran nothing on a timer, so that never happened on
 * a pushed deploy.
 *
 * This suite drives `src/worker.ts` the way the platform does — `/internal/provision`,
 * `/internal/reconcile`, `/internal/delete-scope`, with the platform secret — and runs a
 * pass of the deployment's own sweeper, the one its alarm runs. Two tenants, because what
 * the timer may do turns on what the tenant is entitled to:
 *
 *   - one whose entitlements include `absence`: the stale leave is cancelled, and a leave
 *     that starts in the future is left alone;
 *   - one holding exactly what a dashboard install grants (package.json
 *     `substrat.entitlements`: meridian, protocol). There the schedule FIRES and FAILS —
 *     `absence/expire-stale` is the absence module's own operation, the scope enforces the
 *     projected entitlements, and a standard install is never granted `absence`. This case
 *     pins that honest outcome rather than hiding it: a hosted Meridian on a standard
 *     install does not expire stale leave yet, and the run says why. The fix is a separate
 *     decision (#1654); when it lands, this case is the one that changes.
 *
 * The reconcile and delete cases hold the roster's other two doors, and the last case the
 * contract that keeps it platform-fed: a scope RESTORED from another's dump (the PR-preview
 * path, a fork of production data) is never on the roster, even once routed traffic has
 * reached it — as ticket0's suite holds for a desk. No clock is moved: the DO host has none to inject, so the stale leave simply
 * starts in 2020.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  platformActorId,
  principalId,
  scopeId,
  sweepRunsPayload,
  SWEEP_RUNS_KIND,
  tenantId,
  type Page,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type ScopeHost } from '@substrat-run/kernel';
import { VerticalClient } from '@substrat-run/control-plane-api';
import {
  CloudflareScopeHost,
  SCOPE_SWEEPER_NAME,
  type ScopeSweepReport,
  type ScopeSweeperDo,
} from '@substrat-run/adapter-cloudflare';
import { EMPLOYEE_SELF, MODULES } from '../../src/provision.js';

interface Leave {
  id: string;
  status: string;
  start_date: string;
}

/** The standard install: exactly what a dashboard install grants, derived from package.json. */
const INSTALLED = JSON.parse(env.TEST_INSTALL_ENTITLEMENTS) as string[];

const grants = (keys: readonly string[]) =>
  keys.map((entitlementKey) => ({
    entitlementKey,
    expiresAt: null,
    quota: null,
    plan: null,
    grantedAt: null,
    grantedBy: null,
  }));

/** A tenant that ALSO holds `absence`, and one holding only what the install grants. */
const entitled = { t: tenantId.parse(ulid()), s: scopeId.parse(ulid()), keys: [...INSTALLED, 'absence'] };
const standard = { t: tenantId.parse(ulid()), s: scopeId.parse(ulid()), keys: INSTALLED };
const owner = principalId.parse(ulid());

function host(): CloudflareScopeHost {
  const h = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) h.registerModule(m);
  return h;
}

/** A platform call, as the control plane makes it — a GET when there is no body. */
function platform(path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`https://meridian.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-substrat-platform': env.PLATFORM_SECRET },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sweeper(): DurableObjectStub & ScopeSweeperDo {
  return env.SWEEPER.get(env.SWEEPER.idFromName(SCOPE_SWEEPER_NAME)) as DurableObjectStub & ScopeSweeperDo;
}

function roster(): Promise<string[]> {
  return runInDurableObject(sweeper(), async (_instance, state) =>
    [...(await state.storage.list({ prefix: 'scope:' })).keys()].map((k) => k.slice('scope:'.length)),
  );
}

async function sweep(): Promise<ScopeSweepReport> {
  const outcome = await sweeper().sweepNow();
  if ('error' in outcome) throw new Error(`the pass sank whole: ${outcome.error}`);
  return outcome;
}

async function provision(t: TenantId, s: ScopeId, keys: readonly string[]): Promise<void> {
  const res = await platform('/internal/provision', { tenantId: t, scopeId: s, owner, entitlements: grants(keys) });
  expect(res.status).toBe(201);
}

/**
 * An employee with a login, holding the self-service grants the worker issues on
 * create-employee (`grantEmployeeSelf`), and a leave request of theirs starting on `start`.
 */
async function leaveStarting(t: TenantId, s: ScopeId, start: string, end: string): Promise<string> {
  const admin = await host().getScope(owner, t, s);
  await admin.invoke('hr/define-leave-type', { key: 'vacation', label: 'Vacation', kind: 'vacation', annualDays: '25' });
  const login: PrincipalId = principalId.parse(ulid());
  const employee = await admin.invoke<{ id: string }>('hr/create-employee', {
    number: `E-${ulid()}`,
    name: 'Elin',
    principalRef: login,
  });
  for (const permission of EMPLOYEE_SELF) {
    await host().grantEntityLocal(s, login, permission, { entityType: 'employee', entityId: employee.id });
  }
  const self = await host().getScope(login, t, s);
  const leave = await self.invoke<Leave>('hr/request-leave', {
    employeeId: employee.id,
    leaveTypeKey: 'vacation',
    startDate: start,
    endDate: end,
    days: '4',
  });
  expect(leave.status).toBe('requested');
  return leave.id;
}

async function statusOf(t: TenantId, s: ScopeId, id: string): Promise<string | undefined> {
  const page = await (await host().getScope(owner, t, s)).invoke<Page<Leave>>('hr/list-requests');
  return page.entries.find((r) => r.id === id)?.status;
}

describe('meridian on workerd — the deployment runs engine-absence\'s timer (#1646)', () => {
  it('provisioning puts the scope on the roster and starts the loop', async () => {
    expect(await roster()).toEqual([]);
    await provision(entitled.t, entitled.s, entitled.keys);
    expect(await roster()).toEqual([entitled.s]);
    expect(await runInDurableObject(sweeper(), (_i, state) => state.storage.getAlarm())).not.toBeNull();
  });

  it('entitled to absence: a pass cancels the stale leave and leaves the future one', async () => {
    const stale = await leaveStarting(entitled.t, entitled.s, '2020-01-06', '2020-01-10');
    const future = await leaveStarting(entitled.t, entitled.s, '2099-01-05', '2099-01-09');

    const report = await sweep();
    expect(report.errors).toEqual([]);
    expect(report.schedules).toEqual({ scopes: 1, fired: 1, skipped: 0, failed: 0 });
    expect(await statusOf(entitled.t, entitled.s, stale)).toBe('cancelled');
    expect(await statusOf(entitled.t, entitled.s, future)).toBe('requested');
  });

  it('a standard install: the schedule fires and FAILS on the entitlement, and the stale leave stays', async () => {
    await provision(standard.t, standard.s, standard.keys);
    expect((await roster()).sort()).toEqual([entitled.s, standard.s].sort());
    const stale = await leaveStarting(standard.t, standard.s, '2020-01-06', '2020-01-10');

    const report = await sweep();
    // The entitled scope ran its daily schedule an instant ago, so it is skipped; the
    // standard one runs it for the first time, and the scope refuses it.
    expect(report.schedules).toEqual({ scopes: 1, fired: 0, skipped: 1, failed: 1 });
    expect(report.errors).toEqual([
      {
        kind: 'schedule',
        id: `${standard.s}:absence/expire-stale`,
        error: expect.stringMatching(/not entitled: absence\/expire-stale .* does not hold 'absence'/),
      },
    ]);
    expect(await statusOf(standard.t, standard.s, stale)).toBe('requested');

    // …and the failure is RECORDED where the platform reads a hosted scope's sweeps from:
    // the batched sweep-runs intent the pass leaves in the scope's journal (#1232).
    const runs = (await host().listPlatformRequests(standard.t, standard.s))
      .filter((r) => r.kind === SWEEP_RUNS_KIND)
      .flatMap((r) => sweepRunsPayload.parse(r.payload).entries);
    expect(runs).toContainEqual(
      expect.objectContaining({
        kind: 'schedule',
        operation: 'absence/expire-stale',
        outcome: 'failed',
        error: expect.stringMatching(/does not hold 'absence'/),
      }),
    );
  });

  it('a scope provisioned before the sweeper existed joins on reconcile', async () => {
    // The state of every live scope the moment this deploys: provisioned, never noted.
    await sweeper().forgetScope(entitled.s);
    expect(await roster()).toEqual([standard.s]);
    const res = await platform('/internal/reconcile', {
      tenantId: entitled.t,
      scopeId: entitled.s,
      entitlements: grants(entitled.keys),
    });
    expect(res.status).toBe(200);
    expect((await roster()).sort()).toEqual([entitled.s, standard.s].sort());
  });

  it('deleting a scope takes it off the roster', async () => {
    const res = await platform('/internal/delete-scope', { scopeId: standard.s });
    expect(res.status).toBe(200);
    expect(await roster()).toEqual([entitled.s]);
  });

  it('a restored copy is never swept, even once routed traffic has reached it', async () => {
    // A source whose schedule has never run, holding a stale leave, entitled to run it —
    // so a pass that reached its copy WOULD cancel the copy's leave. That is what makes
    // the copy's leave staying `requested` evidence rather than a cadence skip.
    const source = scopeId.parse(ulid());
    const fork = scopeId.parse(ulid());
    await provision(entitled.t, source, entitled.keys);
    const stale = await leaveStarting(entitled.t, source, '2020-01-06', '2020-01-10');

    // The PR-preview path: dump the scope, restore the dump into a new scope id. Nothing
    // provisions a fork, so nothing notes it.
    const dump = await (await platform(`/internal/export?scopeId=${source}`)).json();
    expect((await platform('/internal/restore', { tenantId: entitled.t, scopeId: fork, tables: dump })).status).toBe(200);
    // …and traffic reaches it, as a preview hostname sends it: a routed request through
    // the worker, and a read served by the fork's own scope DO.
    const routed = await SELF.fetch('https://preview.meridian.test/api/me', {
      headers: { 'x-substrat-tenant': entitled.t, 'x-substrat-scope': fork, 'x-substrat-router': env.ROUTER_SECRET },
    });
    // The worker took the node from the assertion and answered as that instance — which,
    // with no issuer delivered to it, is its own refusal to sign anybody in. Not the 400 of
    // a bad assertion, nor the 503 of a missing one: the request reached the fork.
    expect(await routed.json()).toMatchObject({ instance: '/api/me', detail: expect.stringMatching(/OIDC_ISSUER/) });
    expect(await statusOf(entitled.t, fork, stale)).toBe('requested');

    const report = await sweep();
    expect(report.errors).toEqual([]);
    // The source runs its schedule for the first time; the entitled scope ran it today.
    expect(report.schedules).toEqual({ scopes: 1, fired: 1, skipped: 1, failed: 0 });
    expect(await statusOf(entitled.t, source, stale)).toBe('cancelled');
    expect(await roster()).not.toContain(fork);
    expect(await statusOf(entitled.t, fork, stale)).toBe('requested');
  });
});

/**
 * Provisioning a Meridian scope twice leaves exactly the state provisioning it once did
 * (#1653). In this file rather than its own because the pool invalidates live Durable
 * Objects between test files, and this suite's cases share one deployment's roster.
 *
 * Meridian is LISTED, which is the whole reason this matters now. Its installs are other
 * tenants' scopes, and until #1653 nothing re-ran their provision once they existed: a
 * promote re-serves them in place and moves none of their version pointers, so the #1172
 * reconcile never saw them. It now follows the version each scope runs, so every install
 * is reconciled after every promote, with nobody watching. A hook that re-opened an
 * owner's first-sign-in window — letting whoever signs in first take a seat that was
 * already claimed — or duplicated anything, would do it to every tenant at once.
 *
 * So this compares the WHOLE of what a provision writes — every table in the scope's
 * database, every table in its tenant's identity directory, and the sweeper roster — after
 * one `/internal/provision`, and again after a second provision (the platform-intent
 * drain's retry) and two `/internal/reconcile`s (the sweep, on two promotes). They must be
 * equal, row for row: nothing duplicated, nothing reset, no window moved, no seat re-opened.
 */
describe('meridian provision is idempotent (#1653)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const install = { tenantId: t, scopeId: s, owner, entitlements: grants(INSTALLED) };

  /** Every row of every table in one Durable Object's SQLite, order-free. */
  const tablesOf = (stub: DurableObjectStub): Promise<Record<string, string[]>> =>
    runInDurableObject(stub, async (_instance, state) => {
      const names = [
        ...state.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
        ),
      ].map((r) => String(r.name));
      const out: Record<string, string[]> = {};
      for (const name of names) {
        out[name] = [...state.storage.sql.exec(`SELECT * FROM "${name}"`)].map((r) => JSON.stringify(r)).sort();
      }
      return out;
    });

  const everything = async () => ({
    scope: await tablesOf(env.SCOPE.get(env.SCOPE.idFromName(s))),
    identity: await tablesOf(env.AUTH.get(env.AUTH.idFromName(t))),
    roster: await runInDurableObject(sweeper(), async (_instance, state) =>
      Object.fromEntries(await state.storage.list({ prefix: 'scope:' })),
    ),
  });

  it('a second provision and two reconciles leave every row exactly as one provision did', async () => {
    expect((await platform('/internal/provision', install)).status).toBe(201);
    const once = await everything();

    // The drain's retry, then the sweep reaching the scope on two promotes.
    expect((await platform('/internal/provision', install)).status).toBe(201);
    for (let i = 0; i < 2; i++) {
      const { owner: _owner, ...reconcile } = install;
      expect((await platform('/internal/reconcile', reconcile)).status).toBe(200);
    }
    const again = await everything();

    // The comparison is only worth something if the first provision wrote things: the
    // owner's role tuple, the owner seat and its first-sign-in window, the roster entry.
    expect(once.scope['_substrat_tuples']!.length).toBeGreaterThan(0);
    expect(once.identity['owner_of_record']).toHaveLength(1);
    expect(once.identity['pending_owner']).toHaveLength(1);
    expect(Object.keys(once.roster)).toContain(`scope:${s}`);

    expect(again).toEqual(once);
    expect((await platform('/internal/delete-scope', { scopeId: s })).status).toBe(200);
  });
});

/**
 * The whole #1653 chain in one pass: a promote of this LISTED vertical reaches an existing
 * install's `onProvision`.
 *
 * The directory here is a stand-in holding what the control plane's holds after that
 * promote — the install and a restored copy of it, both on the serving script, both still
 * pointed at v1 and provisioned at v1, with the script now serving v2 (the directory half
 * is proven against the real control-plane Durable Object in `apps/control-plane`). Every
 * other link is the real one: `runPlatformSweep` decides, the platform's own
 * `VerticalClient` calls this deployed worker's `/internal/reconcile`, and the hook that
 * runs is Meridian's. The install was provisioned before the sweeper existed, so the only
 * way onto the roster is that hook running.
 */
describe("a listed vertical's promote reaches an install's onProvision (#1653)", () => {
  it('the sweep reconciles the install through the platform client, its hook runs, and its restored copy is left alone', async () => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const copy = scopeId.parse(ulid());
    expect((await platform('/internal/provision', { tenantId: t, scopeId: s, owner, entitlements: grants(INSTALLED) })).status).toBe(201);
    // Provisioned before the sweeper existed: never noted.
    await sweeper().forgetScope(s);
    // The PR-preview path: dump the install, restore it under another id.
    const dump = await (await platform(`/internal/export?scopeId=${s}`)).json();
    expect((await platform('/internal/restore', { tenantId: t, scopeId: copy, tables: dump })).status).toBe(200);
    expect(await roster()).not.toContain(s);

    const row = (id: ScopeId, forkedFrom: ScopeId | null) => ({
      id,
      tenantId: t,
      kind: 'app',
      status: 'active',
      vertical: 'meridian',
      servingRef: 'meridian',
      verticalVersionId: 'v1',
      provisionedVersionId: 'v1',
      forkedFrom,
    });
    const marked: { id: string; versionId: string }[] = [];
    const directory = {
      admin: {
        listScopes: async () => [row(s, null), row(copy, s)],
        listVerticals: async () => [{ slug: 'meridian', servingRef: 'meridian', servingVersionId: 'v2' }],
        listConnections: async () => [],
        markScopeProvisioned: async (_a: unknown, _t: unknown, id: string, versionId: string) => {
          marked.push({ id, versionId });
        },
      },
    } as unknown as ScopeHost;
    const client = new VerticalClient({
      fetch: ((input: RequestInfo, init?: RequestInit) => SELF.fetch(input, init)) as typeof fetch,
      baseUrl: 'https://meridian.test',
      platformSecret: env.PLATFORM_SECRET,
    });
    const reached: string[] = [];

    const report = await runPlatformSweep(directory, {
      actor: platformActorId.parse(ulid()),
      fetch: (() => Promise.reject(new Error('unused'))) as never,
      sweepers: {},
      drainRetries: false,
      runSchedules: false,
      reconcileMigrations: false,
      gcSnapshots: false,
      reconcileScopeFn: async (tenant, id) => {
        reached.push(id);
        await client.reconcileInstance({ tenantId: tenant, scopeId: id, entitlements: grants(INSTALLED) } as never);
      },
    });

    expect(report.errors).toEqual([]);
    expect(reached).toEqual([s]);
    expect(marked).toEqual([{ id: s, versionId: 'v2' }]);
    // The hook ran: the install is on its deployment's roster now, and its copy is not.
    expect(await roster()).toContain(s);
    expect(await roster()).not.toContain(copy);

    for (const id of [s, copy]) expect((await platform('/internal/delete-scope', { scopeId: id })).status).toBe(200);
  });
});
