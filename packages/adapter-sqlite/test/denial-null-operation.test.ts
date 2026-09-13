/**
 * The null-keyed bucket of the per-operation denial summary (#1456).
 *
 * `_substrat_denials.operation` is nullable — the contract says a refusal that unwound
 * something other than an operation invocation carries none — and `denialSummaryQuery`
 * promises that such rows come back as ONE null-keyed bucket that still counts toward
 * `total`, rather than vanishing from the sum. Nothing in either adapter writes that row
 * today (`recordDenial` always has the operation in hand), so the permission contract
 * suite cannot seed it through the host, and a regression that dropped the NULL group or
 * mapped it as an omitted row would pass both adapter suites.
 *
 * So this suite plants the row itself. It is harness code, not module code: the scope's
 * file is opened directly, which `ctx.sql` could never do (#954 refuses a `_substrat_*`
 * write on purpose). The adapter then answers the real query over a real table.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

describe('the per-operation denial summary keeps a bucket for refusals with no operation (#1456)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-denial-null-'));
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  // No role and no grant anywhere: every enforced check is refused.
  const mallory = principalId.parse(ulid());
  const PERM_USE = permissionKey.parse('perm:use');

  beforeAll(async () => {
    host.registerModule(permMod);
    await host.admin.createTenant(staff, { id: t1, slug: `denial-null-${ulid().toLowerCase()}`, name: 'Denial null' });
    await host.admin.grantEntitlement(staff, t1, 'perm'); // default-deny (§4.3): perm/* needs it
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t1, s1);

    // Two real refusals through the host, so the log has operation-bearing rows to
    // stand beside the planted one.
    const stub = await host.getScope(mallory, t1, s1);
    for (let i = 0; i < 2; i++) {
      await expect(stub.invoke('perm/authorized-read', { permission: PERM_USE })).rejects.toThrow(/permission denied/);
    }

    // The row no public path writes: the same columns `recordDenial` fills, operation NULL.
    const db = new Database(join(dir, `${t1}__${s1}.sqlite`));
    try {
      db.prepare(
        `INSERT INTO _substrat_denials (id, actor, permission, tenant_id, scope_id, operation, impersonation, at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(ulid(), JSON.stringify(mallory), PERM_USE, t1, s1, new Date().toISOString());
    } finally {
      db.close();
    }
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers a null-keyed bucket, and the buckets still sum to the total', async () => {
    const summary = await host.admin.summarizeDenials(staff, t1, s1, { groupBy: 'operation' });
    expect(summary.groupBy).toBe('operation');
    if (summary.groupBy !== 'operation') throw new Error('unreachable');

    expect(summary.total).toBe(3);
    // Busiest first: the two real refusals, then the one that unwound no operation —
    // present as a bucket of its own, keyed null, not folded away.
    expect(summary.buckets.map((b) => [b.operation, b.count])).toEqual([
      ['perm/authorized-read', 2],
      [null, 1],
    ]);
    expect(summary.buckets.reduce((n, b) => n + b.count, 0)).toBe(summary.total);
  });

  it('is a fact about the operation grouping only — the (actor, permission) view counts it in its bucket', async () => {
    // Under K-35's grouping the planted row shares mallory's perm:use bucket, so the
    // same three refusals are one bucket there and two here. Both sum to the total.
    const summary = await host.admin.summarizeDenials(staff, t1, s1);
    if (summary.groupBy !== 'actor-permission') throw new Error('unreachable');
    expect(summary.buckets).toHaveLength(1);
    expect(summary.buckets[0]!.count).toBe(3);
    expect(summary.total).toBe(3);
  });
});
