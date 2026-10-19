import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { MODULES, provisionDashboard } from '../src/index.js';
import { registerDashboardMembership } from '../src/membership.js';
import type { TenantNarrowedControlPlane } from '../src/authority.js';
import { resolveBrowsableScope } from '../src/browsable-scope.js';

/**
 * The Data tab's scope resolution (#2437): an app's default scope is one filtered read of
 * `list-apps`; a secondary scope of a vertical the team owns an app of (a per-site scope in the
 * scope switcher) is found only by walking the team's apps and asking the plane for each
 * vertical's scopes. The miss branch is the one the lookup-by-filter rewrite left untouched in
 * behaviour but rewired, so it is held here against a stubbed plane.
 */
describe('resolveBrowsableScope', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let dash: Awaited<ReturnType<SqliteScopeHost['getScope']>>;
  const app = scopeId.parse(ulid());
  const sibling = scopeId.parse(ulid());
  const secondary = scopeId.parse(ulid());
  const retired = scopeId.parse(ulid());
  const foreign = scopeId.parse(ulid());

  /** A plane that knows `secondary` and `retired` under `protocol`, and records what it was asked. */
  function plane() {
    const asked: string[] = [];
    return {
      asked,
      cp: {
        listScopes: async (vertical: string) => {
          asked.push(vertical);
          return vertical === 'protocol'
            ? ([
                { id: secondary, status: 'active' },
                { id: retired, status: 'archived' },
              ] as Awaited<ReturnType<TenantNarrowedControlPlane['listScopes']>>)
            : [];
        },
      },
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-browsable-scope-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m);
    registerDashboardMembership(host);
    const node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'acme',
      name: 'Acme',
    });
    dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId: app, verticalSlug: 'protocol', name: 'One' });
    await dash.invoke('dashboard/provision-app', { appScopeId: sibling, verticalSlug: 'protocol', name: 'Two' });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers an app’s own scope from the filtered read, without asking the plane', async () => {
    const { cp, asked } = plane();
    const hit = await resolveBrowsableScope(dash, cp, app);
    expect(hit.appRow.app_scope_id).toBe(app);
    expect(hit.scope).toBe(app);
    expect(asked).toEqual([]);
  });

  it('resolves a secondary scope of a vertical the team owns an app of, asking once per vertical', async () => {
    const { cp, asked } = plane();
    const hit = await resolveBrowsableScope(dash, cp, secondary);
    expect(hit.scope).toBe(secondary);
    // It is addressed under an app of its vertical, not under an app of its own.
    expect(hit.appRow.vertical_slug).toBe('protocol');
    expect([app, sibling]).toContain(hit.appRow.app_scope_id);
    expect(asked).toEqual(['protocol']);
  });

  it('404s a scope that is in neither: a foreign id, and a secondary scope that is no longer active', async () => {
    for (const requested of [foreign, retired]) {
      const { cp } = plane();
      const refusal = await resolveBrowsableScope(dash, cp, requested).catch((e: unknown) => e);
      expect(refusal, requested).toBeInstanceOf(HTTPException);
      expect((refusal as HTTPException).status, requested).toBe(404);
    }
  });

  it('404s everything for a team with no apps, even a scope its plane would list', async () => {
    const emptyNode = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'empty',
      name: 'Empty',
    });
    const empty = await host.getScope(emptyNode.principal, emptyNode.tenantId, emptyNode.scopeId);
    const { cp, asked } = plane();
    await expect(resolveBrowsableScope(empty, cp, secondary)).rejects.toMatchObject({ status: 404 });
    expect(asked).toEqual([]);
  });
});
