/**
 * #3176's `delegation` column on a scope that predates it. A fresh scope gets the column from
 * KERNEL_DDL, so neither the contract suite nor `lint:spine-ddl` (which compares the effective
 * schema) notices the `ensureColumn` going missing — and without it every write on every existing
 * scope fails with "no column named delegation". So the scope is put back to its pre-column shape,
 * woken, and made to record a delegated event and denial; a second wake must be a no-op.
 *
 * Harness code: the scope's file is opened directly, as `invocation-index.test.ts` does, because
 * shaping a legacy table is exactly what `ctx.sql` refuses.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { errorCodeOf, permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { delegationCeilingMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

const TABLES = ['_substrat_outbox', '_substrat_denials'] as const;
const delegation = { actor: 'client-todo', scope: ['ceiling:a'] };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hostOn = (dir: string) => {
  const host = new SqliteScopeHost({ dir });
  host.registerModule(delegationCeilingMod);
  return host;
};

const hasColumn = (file: string) => {
  const db = new Database(file, { readonly: true });
  try {
    return TABLES.map((t) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === 'delegation'));
  } finally {
    db.close();
  }
};

it('a scope that predates the delegation column gets it on wake, records into it, and wakes again unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-delegation-column-'));
  dirs.push(dir);
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const alice = principalId.parse(ulid());
  const file = join(dir, `${t}__${s}.sqlite`);

  const first = hostOn(dir);
  await first.admin.createTenant(staff, { id: t, slug: `delegation-column-${ulid().toLowerCase()}`, name: 'Delegation column' });
  await first.admin.grantEntitlement(staff, t, 'delegation-ceiling');
  await first.admin.defineRole(staff, t, {
    key: 'ceiling-both',
    permissions: [permissionKey.parse('ceiling:a'), permissionKey.parse('ceiling:b')],
    source: 'vertical',
  });
  await first.admin.assignRole(staff, { principalId: alice, roleKey: 'ceiling-both', node: { tenantId: t, scopeId: null } });
  await first.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'ceiling-vertical' });
  await first.admin.activateScope(staff, t, s);
  await first.close();

  // Back to how a pre-#3176 build left the scope: neither table has the column.
  const legacy = new Database(file);
  try {
    for (const table of TABLES) legacy.exec(`ALTER TABLE ${table} DROP COLUMN delegation`);
  } finally {
    legacy.close();
  }
  expect(hasColumn(file)).toEqual([false, false]);

  const woken = hostOn(dir);
  const stub = await woken.getScope(alice, t, s, { delegation });
  await stub.invoke('ceiling/note', { id: 'n1' });
  const invocationId = ulid();
  expect(await stub.invoke('ceiling/b', undefined, { invocationId }).then(() => 'answered', errorCodeOf)).toBe('permission_denied');
  const history = await woken.admin.entityHistory(staff, t, s, { entityType: 'ceiling_note', entityId: 'n1' });
  expect(history.entries[0]?.delegation).toEqual({ actor: 'client-todo' });
  const denials = await woken.admin.listDenials(staff, t, s, { operation: 'ceiling/b' });
  expect(denials.filter((d) => d.invocationId === invocationId).map((d) => d.delegation)).toEqual([{ actor: 'client-todo' }]);
  await woken.close();

  // The second wake meets a table that already has the column, and must leave the rows as they are.
  const again = hostOn(dir);
  const after = await again.admin.entityHistory(staff, t, s, { entityType: 'ceiling_note', entityId: 'n1' });
  expect(after.entries.map((e) => e.delegation)).toEqual(history.entries.map((e) => e.delegation));
  await again.close();
  expect(hasColumn(file)).toEqual([true, true]);
});
