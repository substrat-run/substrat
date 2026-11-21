import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { platformActorId, type CloudflareUsageDay } from '@substrat-run/contracts';
import { runPlatformSweep, type PlatformSweepOptions } from '../src/platform-sweep.js';
import {
  COST_ROLLUP_DDL,
  listCostDayRows,
  listCostRollupDayRows,
  pruneCostDayRows,
  recordCostDayRows,
  recordScopeObjectRow,
  scopeObjectsDueRows,
  type ScopeObjectTarget,
} from '../src/cost-rollup.js';
import { VERTICAL_OWNERS_DDL } from '../src/vertical-owners.js';
import type { RedactionSql } from '../src/subject-redaction.js';
import type { FetchLike } from '../src/connector-transport.js';
import type { ScopeHost } from '../src/scope-host.js';

/**
 * The daily Cloudflare cost rollup and the scope-object ledger (#3316), through the real SQL on a
 * directory holding the tables attribution reads. The sweep phases drive it as the hosted pass does.
 */

const ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
const FETCH = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;

const OWNER_THEN = '01J00000000000000000000T02';
const OWNER = '01J00000000000000000000T01';
const INSTALLER = '01J00000000000000000000T03';
const LIVE = '01J00000000000000000000S01';
const PREVIEW = '01J00000000000000000000S02';
const VERSION = '01KQ0000000000000000000V01';
const STABLE = 'tenant-a-crm';
const PER_VERSION = `tenant-a-crm-${VERSION.toLowerCase()}`;
const hex = (c: string) => c.repeat(64);

function directory() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, vertical TEXT, kind TEXT, slug TEXT,
      vertical_version_id TEXT, serving_ref TEXT, created_at TEXT NOT NULL);
    CREATE TABLE verticals (slug TEXT PRIMARY KEY, owner_tenant TEXT, serving_ref TEXT, created_at TEXT NOT NULL);
    CREATE TABLE vertical_versions (id TEXT PRIMARY KEY, vertical_slug TEXT NOT NULL, deployment_ref TEXT);
    ${VERTICAL_OWNERS_DDL}
    ${COST_ROLLUP_DDL}
  `);
  // The slug changed hands before the day read: the day is the new owner's.
  db.exec(`
    INSERT INTO verticals VALUES ('tenant-a/crm', '${OWNER}', '${STABLE}', '2026-11-10T00:00:00.000Z');
    INSERT INTO _substrat_vertical_owners VALUES ('tenant-a/crm', '${OWNER_THEN}', '2026-09-01T00:00:00.000Z', '2026-11-09T00:00:00.000Z');
    INSERT INTO _substrat_vertical_owners VALUES ('tenant-a/crm', '${OWNER}', '2026-11-10T00:00:00.000Z', NULL);
    INSERT INTO vertical_versions VALUES ('${VERSION}', 'tenant-a/crm', '${PER_VERSION}');
    INSERT INTO scopes VALUES ('${LIVE}', '${INSTALLER}', 'tenant-a/crm', NULL, 'crm', NULL, '${STABLE}', '2026-11-10T00:00:00.000Z');
    INSERT INTO scopes VALUES ('${PREVIEW}', '${OWNER}', 'tenant-a/crm', 'preview', 'crm--pr-7', '${VERSION}', NULL, '2026-11-19T00:00:00.000Z');
  `);
  const sql: RedactionSql = (q, p) => db.prepare(q).all(...(p as (string | number | null)[]));
  const admin: Record<string, unknown> = {
    listScopes: async () => [],
    listConnections: async () => [],
    listScopeObjectsDue: async (_a: unknown, input: { limit: number; retryMs: number }) =>
      scopeObjectsDueRows(sql, { nowMs: Date.now(), ...input }),
    recordScopeObject: async (_a: unknown, input: Parameters<typeof recordScopeObjectRow>[1]) => recordScopeObjectRow(sql, input),
    listCostRollupDays: async () => listCostRollupDayRows(sql),
    recordCostDay: async (_a: unknown, input: Parameters<typeof recordCostDayRows>[1]) => ({ recorded: recordCostDayRows(sql, input) }),
    pruneCostDays: async (_a: unknown, limit: number, months: number | null) => pruneCostDayRows(sql, Date.now(), limit, months),
  };
  const host = { admin, drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }) } as unknown as ScopeHost;
  return { db, sql, host };
}

const sweep = (host: ScopeHost, extra: Partial<PlatformSweepOptions>) =>
  runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {}, drainRetries: false, ...extra });

const DAY = '2026-11-20';
const NOW = '2026-11-21T04:00:00.000Z';
const USAGE: CloudflareUsageDay = {
  day: DAY,
  workers: [
    { script: STABLE, cpuTimeUs: 1500, lower: 1400.4, upper: 1599.6 },
    { script: 'substrat-router', cpuTimeUs: 99 },
    { script: 'not-in-this-directory', cpuTimeUs: 5 },
  ],
  doInvocations: [
    { namespaceId: 'ns-live', script: STABLE, requests: 10, lower: 9, upper: 11 },
    // The preview script is reaped: Cloudflare's list no longer has its namespace, the invocations do.
    { namespaceId: 'ns-preview', script: PER_VERSION, requests: 4 },
  ],
  doObjects: [
    { namespaceId: 'ns-live', objectId: hex('a'), rowsRead: 100, rowsWritten: 20, storageWriteUnits: 0, duration: 1.5 },
    { namespaceId: 'ns-preview', objectId: hex('b'), rowsRead: 0, rowsWritten: 1_700_000, storageWriteUnits: 0, duration: 0.25 },
    { namespaceId: 'ns-identity', objectId: hex('c'), rowsRead: 5, rowsWritten: 0, storageWriteUnits: 0, duration: 0.1 },
    { namespaceId: 'ns-identity', objectId: hex('d'), rowsRead: 7, rowsWritten: 0, storageWriteUnits: 0, duration: 0.1000004 },
  ],
  namespaces: [
    { id: 'ns-live', script: STABLE, class: 'ScopeDO' },
    { id: 'ns-identity', script: STABLE, class: 'IdentityDO' },
  ],
};
const objectIdOf = (t: ScopeObjectTarget) => Promise.resolve(t.scopeId === LIVE ? hex('a') : hex('b'));
const costs = (read: (day: string) => Promise<CloudflareUsageDay>) => ({ read, lookbackDays: 1, now: () => NOW });

describe('the Cloudflare cost rollup', () => {
  it('records each scope object, then attributes a day through the directory', async () => {
    const { sql, host } = directory();
    const report = await sweep(host, { scopeObjects: { read: objectIdOf }, cloudflareCosts: costs(async () => USAGE) });
    expect(report.scopeObjects).toEqual({ asked: 2, recorded: 2, failed: 0, failures: [] });
    expect(report.cloudflareCosts).toMatchObject({ due: 1, read: 1, failed: 0, recorded: 12 });
    expect(report.errors).toEqual([]);

    const line = (r: ReturnType<typeof listCostDayRows>[number]) =>
      [r.script, r.scopeId ?? '-', r.objectClass ?? '-', r.dimension, r.attribution, r.tenantId ?? '-', r.kind, r.versionId ?? '-',
        r.previewTag ?? '-', r.quantity, r.lower ?? '-', r.upper ?? '-'].join(' ');
    expect(listCostDayRows(sql).map(line)).toEqual([
      `not-in-this-directory - - worker_cpu_us unknown - live - - 5 - -`,
      `substrat-router - - worker_cpu_us platform - live - - 99 - -`,
      // The script-grain CPU is the vertical's owner on the day, never the owner before.
      `${STABLE} - - worker_cpu_us script ${OWNER} live - - 1500 1400.4 1599.6`,
      // An object no scope was recorded for is reported apart: its vertical, no tenant. Two sum.
      `${STABLE} - IdentityDO do_duration_gb_s unmapped - live - - 0.2 - -`,
      `${STABLE} - IdentityDO do_rows_read unmapped - live - - 12 - -`,
      `${STABLE} - ScopeDO do_requests script ${OWNER} live - - 10 9 11`,
      // A listed vertical's scope is the installing tenant's, not the owner's. Zeros write no row.
      `${STABLE} ${LIVE} ScopeDO do_duration_gb_s scope ${INSTALLER} live - - 1.5 - -`,
      `${STABLE} ${LIVE} ScopeDO do_rows_read scope ${INSTALLER} live - - 100 - -`,
      `${STABLE} ${LIVE} ScopeDO do_rows_written scope ${INSTALLER} live - - 20 - -`,
      `${PER_VERSION} - - do_requests script ${OWNER} preview ${VERSION} - 4 - -`,
      `${PER_VERSION} ${PREVIEW} - do_duration_gb_s scope ${OWNER} preview ${VERSION} pr-7 0.25 - -`,
      `${PER_VERSION} ${PREVIEW} - do_rows_written scope ${OWNER} preview ${VERSION} pr-7 1700000 - -`,
    ]);
    expect(listCostRollupDayRows(sql)).toMatchObject([{ day: DAY, rows: 12, error: null, saturated: false }]);
  });

  it('keeps a failed day unread and its rows untouched, and asks a failed scope again only after the retry', async () => {
    const { sql, host, db } = directory();
    const failing = await sweep(host, {
      scopeObjects: { read: async () => Promise.reject(new Error('this deployment predates the route')) },
      cloudflareCosts: costs(async () => Promise.reject(new Error('GraphQL: not authorized'))),
    });
    expect(failing.scopeObjects).toMatchObject({ asked: 2, recorded: 0, failed: 2 });
    expect(failing.errors).toEqual([{ kind: 'cost-rollup', id: DAY, error: 'GraphQL: not authorized' }]);
    expect(listCostRollupDayRows(sql)).toMatchObject([{ day: DAY, readAt: null, rows: null, error: 'GraphQL: not authorized', failingCount: 1 }]);
    // Within the retry nobody is asked; past it (retryMs 0) both are, and both are recorded.
    expect(scopeObjectsDueRows(sql, { nowMs: Date.now(), retryMs: 86_400_000, limit: 10 })).toEqual([]);
    const healed = await sweep(host, {
      scopeObjects: { read: objectIdOf, retryMs: 0 },
      cloudflareCosts: { ...costs(async () => USAGE), retryMs: 0 },
    });
    expect(healed.scopeObjects).toMatchObject({ recorded: 2 });
    expect(healed.cloudflareCosts).toMatchObject({ read: 1, streak: null });
    expect(listCostRollupDayRows(sql)).toMatchObject([{ day: DAY, error: null, rows: 12 }]);
    // A scope whose data moves to another script holds a new object, so it is due again; the
    // preview fork comes first, newest.
    db.exec(`UPDATE scopes SET serving_ref = 'tenant-a-crm-eu' WHERE scope_id = '${LIVE}'`);
    expect(scopeObjectsDueRows(sql, { nowMs: Date.now(), retryMs: 0, limit: 10 })).toEqual([
      { tenantId: INSTALLER, scopeId: LIVE, script: 'tenant-a-crm-eu', vertical: 'tenant-a/crm', kind: 'live', versionId: null, previewTag: null },
    ]);
  });
});
