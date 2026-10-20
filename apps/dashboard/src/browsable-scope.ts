import { HTTPException } from 'hono/http-exception';
import { scopeId } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import type { TenantNarrowedControlPlane } from './authority.js';
import type { DashboardAppRow } from './module.js';
import { allApps, appByScopeId } from './walk-all.js';

/**
 * Resolve the scope a Data-tab request addresses, authorized against the caller's own apps.
 * The scope switcher (multi-scope-manyfold M4) browses ANY scope of an app's vertical —
 * Manyfold's per-site scopes among them — so the addressed scope is either an app's own
 * default scope (the common case, matched directly against `list-apps`) OR a secondary scope
 * of a vertical the tenant owns an app of. Only a direct-match miss pays for the walk of every
 * app and the per-vertical `listScopes` walk after it. A scope in neither is a 404, and tenant
 * isolation holds because both `list-apps` and `listScopes` are tenant-pinned below the seam (K-3).
 */
export async function resolveBrowsableScope(
  dash: Pick<ScopeStub, 'invoke'>,
  cp: Pick<TenantNarrowedControlPlane, 'listScopes'>,
  requested: string,
): Promise<{ appRow: DashboardAppRow; scope: ReturnType<typeof scopeId.parse> }> {
  const direct = await appByScopeId(dash, requested);
  if (direct) return { appRow: direct, scope: scopeId.parse(direct.app_scope_id) };
  const seen = new Set<string>();
  for (const app of await allApps(dash)) {
    if (seen.has(app.vertical_slug)) continue;
    seen.add(app.vertical_slug);
    const scopes = await cp.listScopes(app.vertical_slug);
    const hit = (scopes ?? []).find((s) => s.id === requested && (s.status === 'active' || s.status === 'provisioning'));
    if (hit) return { appRow: app, scope: scopeId.parse(hit.id) };
  }
  throw new HTTPException(404, { message: 'app not found' });
}
