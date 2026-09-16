/**
 * `readInvocation`'s lookup is indexed, on a new scope AND on one that predates the column
 * (#1237).
 *
 * The query is `WHERE invocation_id = ? ORDER BY id` over an outbox that is never pruned.
 * Without an index leading with `invocation_id`, SQLite walks the primary key from the
 * oldest event, so the cost of reading one call grows with the scope's whole history —
 * which no functional test notices, because a test scope has a dozen rows.
 *
 * The second case is the one worth pinning. The index cannot live in KERNEL_DDL beside the
 * other outbox indexes: KERNEL_DDL runs first on every wake, and on a scope created before
 * the column existed it would name a column that is not there yet, and the scope would
 * fail to boot. `lint:spine-ddl` compares KERNEL_DDL's indexes only, so nothing else
 * would catch the index being moved back there.
 *
 * Harness code: the scope's file is opened directly, as `denial-null-operation.test.ts`
 * does, because shaping a legacy table is exactly what `ctx.sql` refuses.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

const INDEX = '_substrat_outbox_invocation';
const secretBox = () => webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
const staff = platformActorId.parse(ulid());

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function provisioned() {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-invocation-index-'));
  dirs.push(dir);
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const host = new SqliteScopeHost({ dir, secretBox: secretBox() });
  host.registerModule(permMod);
  await host.admin.createTenant(staff, { id: t1, slug: `inv-index-${ulid().toLowerCase()}`, name: 'Invocation index' });
  await host.admin.grantEntitlement(staff, t1, 'perm');
  await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'perm-vertical' });
  await host.admin.activateScope(staff, t1, s1);
  return { dir, t1, s1, host, file: join(dir, `${t1}__${s1}.sqlite`) };
}

/** The plan SQLite would run for `readInvocation`'s exact statement. */
function planFor(file: string): string {
  const db = new Database(file, { readonly: true });
  try {
    return (
      db
        .prepare('EXPLAIN QUERY PLAN SELECT id FROM _substrat_outbox WHERE invocation_id = ? ORDER BY id LIMIT ?')
        .all('x', 201) as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
  } finally {
    db.close();
  }
}

describe('the invocation lookup is indexed (#1237)', () => {
  it('seeks by invocation on a new scope, with no separate sort', async () => {
    const { host, file } = await provisioned();
    await host.close();
    const plan = planFor(file);
    expect(plan).toContain(INDEX);
    // The trailing `id` is what serves the ORDER BY; a temp B-tree would mean the index
    // covered the filter and not the ordering.
    expect(plan).not.toMatch(/TEMP B-TREE/i);
  });

  it('boots a scope that predates the column, and gives it the index', async () => {
    const { dir, t1, s1, host, file } = await provisioned();
    await host.close();

    // Put the scope back to how a pre-#1237 build left it: no index, no column.
    const legacy = new Database(file);
    try {
      legacy.exec(`DROP INDEX IF EXISTS ${INDEX}`);
      legacy.exec('ALTER TABLE _substrat_outbox DROP COLUMN invocation_id');
      const cols = (legacy.prepare('PRAGMA table_info(_substrat_outbox)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).not.toContain('invocation_id');
    } finally {
      legacy.close();
    }

    // Waking it must not throw: KERNEL_DDL runs before the column is added back, so an
    // index naming the column there would fail right here.
    const next = new SqliteScopeHost({ dir, secretBox: secretBox() });
    next.registerModule(permMod);
    await expect(next.admin.readUndrainedEvents(staff, t1, s1, 10)).resolves.toBeDefined();
    await next.close();

    expect(planFor(file)).toContain(INDEX);
  });
});
