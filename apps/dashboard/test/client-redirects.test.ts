import { describe, expect, it } from 'vitest';
import { CLIENT_REDIRECTS_CONFIG_PREFIX, clientRedirects, scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { deliverClientRedirects, reconcileClientRedirects } from '../src/client-redirects.js';
import type { PlacesAppAuth } from '../src/places.js';
import type { DashboardAppRow } from '../src/module.js';

/**
 * The dashboard's half of an app's client URIs (#2904): which hostnames go to which issuer,
 * under which client, and when. The issuer's half (what it does with them, and what it
 * refuses) is pinned in `demos/auth-server/test/client-redirects.test.ts` and in workerd.
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

/** A control plane whose bindings a test moves, recording deliveries; `down` fails them. */
function controlPlane(bindings: Record<string, Array<{ hostname: string; status: string }>>) {
  const deliveries: Array<{ scope: string; key: string; value: string }> = [];
  const down = new Set<string>();
  return {
    deliveries,
    down,
    bindings,
    listHostnames: async (scope: string) => (bindings[scope] ?? []) as never,
    configureInstance: async (scope: string, entries: Array<{ key: string; value: string }>) => {
      if (down.has(scope)) throw new Error('issuer unreachable');
      for (const e of entries) deliveries.push({ scope, ...e });
    },
  };
}

/** What an app's key last carried at an issuer, parsed by the schema the auth-server parses it with. */
const lastFor = (cp: ReturnType<typeof controlPlane>, app: string) => {
  const d = [...cp.deliveries].reverse().find((x) => x.key === `${CLIENT_REDIRECTS_CONFIG_PREFIX}${app}`);
  return d && { scope: d.scope, value: d.value === '' ? null : clientRedirects.parse(JSON.parse(d.value)) };
};

const auth = row({ vertical_slug: 'auth-server', hostname: 'auth.acme.test' });
const desk = row({ hostname: 'desk.acme.test' });
const outside = row({ hostname: 'ext.acme.test' });
const identities: Record<string, PlacesAppAuth> = {
  [desk.app_scope_id]: { issuer: 'https://auth.acme.test', clientId: 'c-desk' },
  [outside.app_scope_id]: { issuer: 'https://acme.auth0.com', clientId: 'c-ext' },
};
const authOf = async (s: string) => identities[s] ?? null;

describe('reconcileClientRedirects', () => {
  it("delivers an existing install's active hostnames to its client — an external issuer's app nowhere", async () => {
    const cp = controlPlane({
      [auth.app_scope_id]: [{ hostname: 'auth.acme.test', status: 'active' }],
      [desk.app_scope_id]: [
        { hostname: 'desk.acme.test', status: 'active' },
        { hostname: 'desk.custom.test', status: 'verifying' },
      ],
    });
    const outcome = await reconcileClientRedirects({ tenantId: TEAM, apps: [auth, desk, outside], isIssuer, authOf, controlPlane: cp, sent: new Map() });

    expect(outcome).toEqual({ delivered: [desk.app_scope_id], failed: [] });
    // A custom domain still verifying cannot serve a login yet, so it is not registered.
    expect(lastFor(cp, desk.app_scope_id)).toEqual({ scope: auth.app_scope_id, value: { clientId: 'c-desk', hostnames: ['desk.acme.test'] } });
    expect(lastFor(cp, outside.app_scope_id)).toBeUndefined();
  });
});

describe('deliverClientRedirects', () => {
  const target = { appScopeId: scopeId.parse(desk.app_scope_id), issuerScopeId: scopeId.parse(auth.app_scope_id), clientId: 'c-desk' };

  it('follows the bindings: a hostname that went active is added, an unbound one drops out, and an unchanged set is not resent', async () => {
    const cp = controlPlane({ [desk.app_scope_id]: [{ hostname: 'desk.acme.test', status: 'active' }] });
    const sent = new Map<string, string>();
    expect(await deliverClientRedirects(cp, target, sent)).toBe(true);

    cp.bindings[desk.app_scope_id]!.push({ hostname: 'desk.custom.test', status: 'active' });
    await deliverClientRedirects(cp, target, sent);
    expect(lastFor(cp, desk.app_scope_id)?.value?.hostnames).toEqual(['desk.acme.test', 'desk.custom.test']);
    expect(await deliverClientRedirects(cp, target, sent)).toBe(false);

    cp.bindings[desk.app_scope_id]!.pop();
    await deliverClientRedirects(cp, target, sent);
    expect(lastFor(cp, desk.app_scope_id)?.value?.hostnames).toEqual(['desk.acme.test']);

    await deliverClientRedirects(cp, { ...target, clientId: null }, sent);
    expect(lastFor(cp, desk.app_scope_id)?.value).toBeNull();
  });

  it('remembers only what landed: a delivery to an issuer that is down is sent again next time', async () => {
    const cp = controlPlane({ [desk.app_scope_id]: [{ hostname: 'desk.acme.test', status: 'active' }] });
    const sent = new Map<string, string>();
    cp.down.add(auth.app_scope_id);
    await expect(deliverClientRedirects(cp, target, sent)).rejects.toThrow('issuer unreachable');

    cp.down.clear();
    expect(await deliverClientRedirects(cp, target, sent)).toBe(true);
  });
});
