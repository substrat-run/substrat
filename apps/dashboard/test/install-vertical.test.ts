import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { errorCodeOf, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { installAppInput } from '../src/routes.js';

/** The install form names the vertical in the registry's grammar, which provisioning holds too. */
describe('installAppInput.verticalSlug', () => {
  it.each(['', '   ', 'Meridian', 'a/b/c', 'meridian/'])('refuses %j', (verticalSlug) => {
    const r = installAppInput.safeParse({ verticalSlug, name: 'My app' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toContain('verticalSlug');
  });

  it.each(['meridian', 'ticket0', 'acme/manyfold'])('accepts %j', (verticalSlug) => {
    expect(installAppInput.parse({ verticalSlug, name: 'My app' }).verticalSlug).toBe(verticalSlug);
  });
});

/** The `dashboard/provision-app` row the install writes first takes the same grammar. */
describe('dashboard/provision-app verticalSlug', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let dash: ScopeStub;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-install-vertical-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m);
    const node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'install-vertical',
      name: 'Install vertical',
    });
    dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['', '   ', 'Widgets', 'a/b/c'])('refuses %j as validation_failed', async (verticalSlug) => {
    const err = await dash
      .invoke('dashboard/provision-app', { appScopeId: ulid(), verticalSlug, name: 'Widgets' })
      .then(() => undefined, (e: unknown) => e);
    expect(errorCodeOf(err)).toBe('validation_failed');
  });

  it.each(['widgets', 'acme/widgets'])('records an app for %j', async (verticalSlug) => {
    const row = await dash.invoke<{ vertical_slug: string }>('dashboard/provision-app', { appScopeId: ulid(), verticalSlug, name: 'Widgets' });
    expect(row.vertical_slug).toBe(verticalSlug);
  });
});
