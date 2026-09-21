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
 *     decision (see the PR); when it lands, this case is the one that changes.
 *
 * The reconcile and delete cases hold the roster's other two doors, as ticket0's suite
 * does. No clock is moved: the DO host has none to inject, so the stale leave simply
 * starts in 2020.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
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
import { ulid } from '@substrat-run/kernel';
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

function platform(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://meridian.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-substrat-platform': env.PLATFORM_SECRET },
    body: JSON.stringify(body),
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
});
