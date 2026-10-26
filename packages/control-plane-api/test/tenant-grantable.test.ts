import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  mintTenantToken,
  tenantTokenAuth,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * #2388: what a tenant credential may grant itself is what the dashboard's install grants
 * (`installEntitlements`), judged by the same rule: a row pushed before the namespace rule
 * that declares a key it may not falls back to its bare slug, as the install does.
 */
describe('a tenant credential grants only what an install would (#2388)', () => {
  const SECRET = 'test-tenant-token-secret';
  const t = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let asTenant: Record<string, string>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-tenant-grantable-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(SECRET, platformActorId.parse(ulid())),
      tenantTokenSecret: SECRET,
    });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    // Listed, so the tenant can see it; it declares a key that is another vertical's.
    await host.admin.registerVertical(staff, { slug: 'helpdesk', name: 'Helpdesk', source: 'builtin', entitlements: ['crm'], listed: true });
    asTenant = { [SERVICE_TOKEN_HEADER]: await mintTenantToken(SECRET, { tenantId: t }), 'content-type': 'application/json' };
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const grant = (key: string) => app.request(`/tenants/${t}/entitlements/${key}`, { method: 'PUT', headers: asTenant, body: '{}' });

  it('refuses the foreign key a pre-rule row declares and grants the slug the install falls back to', async () => {
    expect((await grant('crm')).status).toBe(403);
    expect((await grant('helpdesk')).status).toBe(200);
  });
});
