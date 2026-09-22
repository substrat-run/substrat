import { describe, expect, it } from 'vitest';
import { PLACES_CONFIG_PREFIX, placeRegistrations, scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  PlacesReconcileGate,
  placeRegistrationOf,
  placesConverged,
  reconcilePlaces,
  type PlacesAppAuth,
  type PlacesReconcileOutcome,
} from '../src/places.js';
import type { DashboardAppRow } from '../src/module.js';

/**
 * Registering a team's apps as places at the team auth-servers they sign in with (#1670) —
 * the dashboard's half. The auth-server's half, which turns a delivery into the registry a
 * vertical's report is checked against, is pinned in
 * `demos/auth-server/test/workerd/reconcile.test.ts`.
 *
 * What is pinned here is what the platform vouches for: which apps, under which client,
 * hostname and name, at which issuer — and that an app leaving (deleted, or moved to another
 * issuer) leaves by dropping out of the next whole-set delivery.
 */

const TEAM = '01J9ZQ3V8Y5K2N4M6P8R0T2V4X';

const row = (over: Partial<DashboardAppRow>): DashboardAppRow =>
  ({
    id: ulid(),
    app_scope_id: scopeId.parse(ulid()),
    vertical_slug: 'ticket0',
    name: 'App',
    status: 'active',
    hostname: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }) as DashboardAppRow;

const isIssuer = (a: DashboardAppRow) => a.vertical_slug === 'auth-server';

/** A tenant-narrowed control plane that records deliveries and can be told to fail one. */
function controlPlane(opts: { live?: Record<string, string[]>; down?: Set<string> } = {}) {
  const deliveries: Array<{ scope: string; key: string; value: string }> = [];
  return {
    deliveries,
    listHostnames: async (scope: string) =>
      (opts.live?.[scope] ?? []).map((hostname) => ({ hostname, status: 'active' })) as never,
    configureInstance: async (scope: string, entries: Array<{ key: string; value: string }>) => {
      if (opts.down?.has(scope)) throw new Error('issuer unreachable');
      for (const e of entries) deliveries.push({ scope, ...e });
    },
  };
}

/** What an issuer was last told, parsed by the same schema the auth-server parses it with. */
function lastTo(cp: ReturnType<typeof controlPlane>, issuer: string) {
  const d = [...cp.deliveries].reverse().find((x) => x.scope === issuer);
  if (!d) return undefined;
  expect(d.key).toBe(`${PLACES_CONFIG_PREFIX}${TEAM}`);
  return d.value === '' ? [] : placeRegistrations.parse(JSON.parse(d.value));
}

describe('the registration an app contributes', () => {
  const app = row({ name: 'Acme Desk', hostname: 'Desk-Acme.global.substrat.run' });

  it('is its client, its hostname and its name — what a deep link and a list row need', () => {
    expect(placeRegistrationOf(app, { issuer: 'https://auth.acme.test', clientId: 'c-desk' })).toEqual({
      appScopeId: app.app_scope_id,
      clientId: 'c-desk',
      hostname: 'desk-acme.global.substrat.run',
      name: 'Acme Desk',
    });
  });

  it('is nothing for an app with no client or no hostname, or a name the list cannot show', () => {
    expect(placeRegistrationOf(app, { issuer: 'x' })).toMatchObject({ reason: 'no client at its issuer' });
    expect(placeRegistrationOf({ ...app, hostname: null }, { clientId: 'c' })).toMatchObject({ reason: 'no hostname yet' });
    expect(placeRegistrationOf({ ...app, name: 'x'.repeat(121) }, { clientId: 'c' })).toHaveProperty('reason');
  });
});

describe('reconcilePlaces', () => {
  const authA = row({ vertical_slug: 'auth-server', hostname: 'auth-a.acme.test' });
  const authB = row({ vertical_slug: 'auth-server', hostname: 'auth-b.acme.test' });
  const desk = row({ name: 'Acme Desk', hostname: 'desk.acme.test' });
  const crm = row({ name: 'Acme CRM', hostname: 'crm.acme.test' });
  const outside = row({ name: 'Signs in at Auth0', hostname: 'ext.acme.test' });

  const identities: Record<string, PlacesAppAuth> = {
    [desk.app_scope_id]: { issuer: 'https://auth-a.acme.test', clientId: 'c-desk' },
    [crm.app_scope_id]: { issuer: 'https://auth-b.acme.test/', clientId: 'c-crm' },
    [outside.app_scope_id]: { issuer: 'https://acme.auth0.com', clientId: 'c-ext' },
  };
  const authOf = async (s: string) => identities[s] ?? null;

  it("tells each team issuer exactly the apps that sign in there — and an external issuer's app nowhere", async () => {
    const cp = controlPlane();
    const outcome = await reconcilePlaces({ tenantId: TEAM, apps: [authA, authB, desk, crm, outside], isIssuer, authOf, controlPlane: cp });
    expect(placesConverged(outcome)).toBe(true);
    expect(lastTo(cp, authA.app_scope_id)).toEqual([
      { appScopeId: desk.app_scope_id, clientId: 'c-desk', hostname: 'desk.acme.test', name: 'Acme Desk' },
    ]);
    expect(lastTo(cp, authB.app_scope_id)).toEqual([
      { appScopeId: crm.app_scope_id, clientId: 'c-crm', hostname: 'crm.acme.test', name: 'Acme CRM' },
    ]);
    expect(cp.deliveries.some((d) => d.value.includes('c-ext'))).toBe(false);
  });

  it('an app moved to another issuer, or deleted, leaves by dropping out of the next set', async () => {
    const cp = controlPlane();
    await reconcilePlaces({ tenantId: TEAM, apps: [authA, authB, desk, crm], isIssuer, authOf, controlPlane: cp });
    // The desk moves to issuer B; the CRM is deleted.
    const moved = { ...identities, [desk.app_scope_id]: { issuer: 'https://auth-b.acme.test', clientId: 'c-desk-2' } };
    await reconcilePlaces({
      tenantId: TEAM,
      apps: [authA, authB, desk],
      isIssuer,
      authOf: async (s) => moved[s] ?? null,
      controlPlane: cp,
    });
    expect(lastTo(cp, authA.app_scope_id)).toEqual([]);
    expect(lastTo(cp, authB.app_scope_id)).toEqual([
      { appScopeId: desk.app_scope_id, clientId: 'c-desk-2', hostname: 'desk.acme.test', name: 'Acme Desk' },
    ]);
  });

  it('delivers nothing when an identity cannot be read, rather than a set missing that app', async () => {
    const cp = controlPlane();
    const outcome = await reconcilePlaces({
      tenantId: TEAM,
      apps: [authA, desk, crm],
      isIssuer,
      authOf: async (s) => {
        if (s === crm.app_scope_id) throw new Error('module unavailable');
        return identities[s] ?? null;
      },
      controlPlane: cp,
    });
    expect(outcome.aborted).toContain('module unavailable');
    expect(placesConverged(outcome)).toBe(false);
    expect(cp.deliveries).toEqual([]);
  });

  it('finds the hostname live when the stored one is null', async () => {
    const cp = controlPlane({ live: { [desk.app_scope_id]: ['desk-live.acme.test'] } });
    await reconcilePlaces({ tenantId: TEAM, apps: [authA, { ...desk, hostname: null }], isIssuer, authOf, controlPlane: cp });
    expect(lastTo(cp, authA.app_scope_id)).toEqual([expect.objectContaining({ hostname: 'desk-live.acme.test' })]);
  });

  it('settles each issuer on its own, sends only what changed, and retries what did not land', async () => {
    const down = new Set([authB.app_scope_id]);
    const cp = controlPlane({ down });
    const sent = new Map<string, string>();
    const apps = [authA, authB, desk, crm];
    const first = await reconcilePlaces({ tenantId: TEAM, apps, isIssuer, authOf, controlPlane: cp, sent });
    expect(first.failed.map((f) => f.issuerScopeId)).toEqual([authB.app_scope_id]);
    expect(lastTo(cp, authA.app_scope_id)).toHaveLength(1);

    down.clear();
    const second = await reconcilePlaces({ tenantId: TEAM, apps, isIssuer, authOf, controlPlane: cp, sent });
    expect(second.unchanged).toEqual([authA.app_scope_id]);
    expect(second.delivered.map((d) => d.issuerScopeId)).toEqual([authB.app_scope_id]);
    expect(placesConverged(second)).toBe(true);
  });

  it('does nothing for a team with no auth-server', async () => {
    const cp = controlPlane();
    expect(await reconcilePlaces({ tenantId: TEAM, apps: [desk], isIssuer, authOf, controlPlane: cp })).toEqual({
      delivered: [],
      unchanged: [],
      failed: [],
      skipped: [],
    });
  });
});

describe('PlacesReconcileGate', () => {
  const converged: PlacesReconcileOutcome = { delivered: [], unchanged: [], failed: [], skipped: [] };
  const page = [row({ hostname: 'a.acme.test' })];

  it('runs once, again when the page changed, again after the interval, and again after a failure', async () => {
    let now = 0;
    const gate = new PlacesReconcileGate(5 * 60_000, () => now);
    let runs = 0;
    const pass = async () => {
      runs += 1;
      return converged;
    };
    await gate.run(TEAM, page, pass);
    expect(gate.run(TEAM, page, pass)).toBeNull();
    // A fresh install lands at the top of the page.
    await gate.run(TEAM, [row({ hostname: 'new.acme.test' }), ...page], pass);
    expect(runs).toBe(2);
    now += 5 * 60_000;
    await gate.run(TEAM, [row({ hostname: 'new.acme.test' }), ...page].slice(1), pass);
    expect(runs).toBe(3);

    // A pass that did not converge is not marked done: the very next load runs it again.
    const fresh = new PlacesReconcileGate(5 * 60_000, () => now);
    await fresh.run(TEAM, page, async () => ({ ...converged, failed: [{ issuerScopeId: 'x', reason: 'down' }] }));
    await fresh.run(TEAM, page, pass);
    expect(runs).toBe(4);
    // …and once it has converged, the same page within the interval is left alone.
    expect(fresh.run(TEAM, page, pass)).toBeNull();
  });

  it('never runs two passes for one team at once', async () => {
    const gate = new PlacesReconcileGate();
    let release!: () => void;
    const first = gate.run(TEAM, page, () => new Promise((r) => (release = () => r(converged))));
    expect(gate.run(TEAM, [], async () => converged)).toBeNull();
    release();
    await first;
  });
});
