import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  mintTenantToken,
  tenantTokenAuth,
  verifyTenantToken,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
  type VerticalClient,
} from '../src/index.js';
import { signToken } from '../src/token-codec.js';

/**
 * #3177: `/configure` holds the issuer-only config keys to a tenant credential minted with
 * `issuerConfig` — the dashboard's — once the switch is on. Every other key, and every
 * credential while the switch is off, is delivered as before.
 */
describe('issuer-only config keys need the issuerConfig claim', () => {
  const SECRET = 'test-tenant-token-secret';
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const staff = platformActorId.parse(ulid());
  const tA = tenantId.parse(ulid());
  const sA = scopeId.parse(ulid());
  const staffHeaders = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const ISSUER_ONLY = [
    ['substrat:delegations:', 'substrat:delegations:mcp.acme.test'],
    ['substrat:places:', `substrat:places:${tA}`],
    ['substrat:resources:', 'substrat:resources:app-1'],
    ['substrat:redirects:', 'substrat:redirects:app-1'],
    ['substrat:auth', 'substrat:auth'],
    ['substrat:auth:shared-issuer', 'substrat:auth:shared-issuer'],
  ] as const;
  const SECRET_VALUE = 'value-that-must-not-echo';

  let dir: string;
  let host: SqliteScopeHost;
  const delivered: { key: string; value: string }[][] = [];
  const planes = {} as Record<'on' | 'off', ReturnType<typeof createControlPlaneApi>>;
  let plain: Record<string, string>;
  let claimed: Record<string, string>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-issuer-config-'));
    host = new SqliteScopeHost({ dir });
    const vertical = {
      configureInstance: async (input: { entries: { key: string; value: string }[] }) => {
        delivered.push(input.entries);
      },
    } as unknown as VerticalClient;
    for (const on of [true, false]) {
      planes[on ? 'on' : 'off'] = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        authenticateTenantService: tenantTokenAuth(SECRET, serviceActor),
        tenantTokenSecret: SECRET,
        verticals: { 'demo-vert': vertical },
        requireIssuerConfigClaim: on,
      });
    }
    await host.admin.createTenant(staff, { id: tA, slug: 'acme', name: 'Acme' });
    await host.provisionScope(staff, { tenantId: tA, scopeId: sA, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, tA, sA);
    // Both credentials come out of the staff mint route, as the dashboard's and the builder's do.
    const mint = async (body: Record<string, unknown>) => {
      const res = await planes.on.request('/tenant-tokens', { method: 'POST', headers: staffHeaders, body: JSON.stringify(body) });
      expect(res.status).toBe(201);
      const { token } = (await res.json()) as { token: string };
      return { [SERVICE_TOKEN_HEADER]: token, 'content-type': 'application/json' };
    };
    plain = await mint({ tenantId: tA });
    claimed = await mint({ tenantId: tA, issuerConfig: true });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const configure = (plane: 'on' | 'off', headers: Record<string, string>, entries: { key: string; value: string }[]) =>
    planes[plane].request(`/tenants/${tA}/scopes/${sA}/configure`, { method: 'POST', headers, body: JSON.stringify({ entries }) });

  it('refuses each issuer-only key from a credential without the claim, naming the prefix and never the value', async () => {
    for (const [prefix, key] of ISSUER_ONLY) {
      delivered.length = 0;
      // Behind an ordinary key, so one held key refuses the whole delivery.
      const res = await configure('on', plain, [{ key: 'ADMIN_EMAIL', value: 'a@acme.test' }, { key, value: SECRET_VALUE }]);
      expect(res.status, key).toBe(403);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const body = (await res.json()) as { code: string; detail: string };
      expect(body.code).toBe('forbidden');
      expect(body.detail).toContain(`'${prefix}'`);
      expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
      expect(delivered).toEqual([]);
    }
  });

  it('delivers every issuer-only key from a credential with the claim, from staff, and from any credential while the switch is off', async () => {
    const entries = ISSUER_ONLY.map(([, key]) => ({ key, value: SECRET_VALUE }));
    for (const [plane, headers] of [['on', claimed], ['on', staffHeaders], ['off', plain]] as const) {
      delivered.length = 0;
      const res = await configure(plane, headers, entries);
      expect(res.status, plane).toBe(200);
      expect(delivered).toEqual([entries]);
    }
  });

  it('delivers an ordinary key from a credential without the claim — tokens minted before it keep working', async () => {
    delivered.length = 0;
    const entries = [{ key: 'ADMIN_EMAIL', value: 'a@acme.test' }, { key: 'substrat:authority', value: 'x' }];
    const res = await configure('on', plain, entries);
    expect(res.status).toBe(200);
    expect(delivered).toEqual([entries]);
  });

  it('carries the claim through the token: minted only when asked, and a forged value fails the token', async () => {
    const with_ = await mintTenantToken(SECRET, { tenantId: tA, issuerConfig: true });
    const without = await mintTenantToken(SECRET, { tenantId: tA, issuerConfig: false });
    expect((await verifyTenantToken(SECRET, with_))?.issuerConfig).toBe(true);
    expect(await verifyTenantToken(SECRET, without)).not.toHaveProperty('issuerConfig');
    const forged = await signToken('stt1', SECRET, { v: 1, tenantId: tA, issuerConfig: 'yes', iat: 0 });
    expect(await verifyTenantToken(SECRET, forged)).toBeNull();
  });
});
