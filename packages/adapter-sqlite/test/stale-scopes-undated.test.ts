import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #3313: `archived-undated` is the one stale-scope finding no API can produce. Every archive since
 * the column shipped stamps `archivedAt`; only a row archived before it has none, and the retention
 * reap skips such a row for good. So this writes that legacy row into the directory directly. The
 * contract suite holds every other finding on both adapters.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('reports an archived scope with no archivedAt, and not its dated twin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-stale-undated-'));
  dirs.push(dir);
  const host = new SqliteScopeHost({ dir });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `undated-${t.toLowerCase()}`, name: 'Undated' });
  const [undated, dated] = [scopeId.parse(ulid()), scopeId.parse(ulid())];
  for (const s of [undated, dated]) {
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    await host.admin.archiveScope(staff, t, s);
  }
  const directory = new Database(join(dir, '_directory.sqlite'));
  directory.prepare('UPDATE scopes SET archived_at = NULL WHERE scope_id = ?').run(undated);
  directory.close();

  await host.admin.recordStaleScopes!(staff, { at: new Date().toISOString() });
  expect((await host.admin.listStaleScopes!(staff, { tenantId: t })).map((f) => [f.scopeId, f.finding])).toEqual([
    [undated, 'archived-undated'],
  ]);
  await host.close();
});
