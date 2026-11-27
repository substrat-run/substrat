import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { platformActorId, type CloudflareUsageDay } from '@substrat-run/contracts';
import { runPlatformSweep, type PlatformSweepOptions } from '../src/platform-sweep.js';
import {
  attributeCostDay,
  COST_ROLLUP_DDL,
  listCostDayRows,
  listCostRollupDayRows,
  pruneCostDayRows,
  readCostDirectory,
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
    CREATE TABLE scope_script_copies (tenant_id TEXT NOT NULL, scope_id TEXT NOT NULL, script_ref TEXT NOT NULL,
      move_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (tenant_id, scope_id, script_ref, move_id));
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
    expect(report.cloudflareCosts).toMatchObject({ due: 1, read: 1, failed: 0, recorded: 14 });
    expect(report.errors).toEqual([]);

    const line = (r: ReturnType<typeof listCostDayRows>[number]) =>
      [r.script, r.scopeId ?? '-', r.objectClass ?? '-', r.dimension, r.attribution, r.tenantId ?? '-', r.kind, r.versionId ?? '-',
        r.previewTag ?? '-', r.quantity, r.lower ?? '-', r.upper ?? '-'].join(' ');
    expect(listCostDayRows(sql).map(line)).toEqual([
      `not-in-this-directory - - worker_cpu_us unknown - live - - 5 - -`,
      `substrat-router - - worker_cpu_us platform - live - - 99 - -`,
      // The script-grain CPU is the vertical's owner on the day, never the owner before.
      `${STABLE} - - worker_cpu_us script ${OWNER} live - - 1500 1400.4 1599.6`,
      // An object no scope was recorded for is reported apart: its vertical, no tenant, one row per object.
      `${STABLE} - IdentityDO do_duration_gb_s unmapped - live - - 0.1 - -`,
      `${STABLE} - IdentityDO do_rows_read unmapped - live - - 5 - -`,
      `${STABLE} - IdentityDO do_duration_gb_s unmapped - live - - 0.1 - -`,
      `${STABLE} - IdentityDO do_rows_read unmapped - live - - 7 - -`,
      `${STABLE} - ScopeDO do_requests script ${OWNER} live - - 10 9 11`,
      // A listed vertical's scope is the installing tenant's, not the owner's. Zeros write no row.
      `${STABLE} ${LIVE} ScopeDO do_duration_gb_s scope ${INSTALLER} live - - 1.5 - -`,
      `${STABLE} ${LIVE} ScopeDO do_rows_read scope ${INSTALLER} live - - 100 - -`,
      `${STABLE} ${LIVE} ScopeDO do_rows_written scope ${INSTALLER} live - - 20 - -`,
      `${PER_VERSION} - - do_requests script ${OWNER} preview ${VERSION} - 4 - -`,
      `${PER_VERSION} ${PREVIEW} - do_duration_gb_s scope ${OWNER} preview ${VERSION} pr-7 0.25 - -`,
      `${PER_VERSION} ${PREVIEW} - do_rows_written scope ${OWNER} preview ${VERSION} pr-7 1700000 - -`,
    ]);
    expect(listCostRollupDayRows(sql)).toMatchObject([{ day: DAY, rows: 14, error: null, saturated: false }]);
  });

  it('charges a labelled container to its tenant, and an unlabelled one to the platform (#3316)', () => {
    const empty = { objects: new Map(), slugByScript: new Map(), versionByScript: new Map(), versionById: new Map(), ownerBySlug: new Map(), liveScripts: new Set<string>(), copyTenantByScript: new Map() };
    const box = { applicationId: 'app-1', cpuTimeSec: 2, allocatedMemory: 3 * 1024 ** 3, allocatedDisk: 4e9, txBytes: 0 };
    const rows = attributeCostDay(
      {
        day: DAY, workers: [], doInvocations: [], doObjects: [], namespaces: [],
        containers: [
          { ...box, instanceId: 'i-1', tenant: OWNER, app: 'tenant-a/crm' },
          { ...box, instanceId: 'i-2', tenant: null, app: null },
          // A label that is not a tenant id names no one.
          { ...box, instanceId: 'i-3', tenant: 'not-a-tenant', app: 'tenant-a/crm' },
        ],
      },
      empty,
    );
    expect(rows.map((r) => [r.objectId, r.dimension, r.attribution, r.tenantId ?? '-', r.vertical ?? '-', r.quantity].join(' '))).toEqual([
      // Memory and disk in the units Cloudflare prices them in; a zero writes no row.
      `i-1 container_cpu_s container ${OWNER} tenant-a/crm 2`,
      `i-1 container_memory_gib_s container ${OWNER} tenant-a/crm 3`,
      `i-1 container_disk_gb_s container ${OWNER} tenant-a/crm 4`,
      'i-2 container_cpu_s platform - - 2',
      'i-2 container_memory_gib_s platform - - 3',
      'i-2 container_disk_gb_s platform - - 4',
      'i-3 container_cpu_s unknown - - 2',
      'i-3 container_memory_gib_s unknown - - 3',
      'i-3 container_disk_gb_s unknown - - 4',
    ]);
    expect(new Set(rows.map((r) => `${r.script} ${r.objectClass}`))).toEqual(new Set(['container:app-1 Container']));
  });

  it('charges an installation its own stamped lines, and the rest of a script’s lines and spans to its owner (#3358)', () => {
    const { sql } = directory();
    const lines = (o: Partial<NonNullable<CloudflareUsageDay['observability']>[number]>) =>
      ({ signal: 'logs' as const, script: STABLE, tenantId: null, scopeId: null, events: 10, bytes: 4000, ...o });
    const rows = attributeCostDay(
      {
        day: DAY, workers: [], doInvocations: [], doObjects: [], namespaces: [],
        observability: [
          lines({ tenantId: INSTALLER, scopeId: LIVE }),
          lines({ events: 3, bytes: 900 }),
          // A tenant field that is not a tenant id names no one; its scope is not kept either.
          lines({ tenantId: 'not-a-tenant', scopeId: LIVE, events: 1, bytes: 300 }),
          // A span carries no tenant, and a size the backend did not report is no bytes row, never 0.
          lines({ signal: 'spans', script: PER_VERSION, events: 40, bytes: null }),
          // The platform's own scripts stay the platform's, whoever's request a line was about.
          lines({ script: 'substrat-router', tenantId: INSTALLER, events: 2, bytes: 500 }),
        ],
      },
      readCostDirectory(sql, DAY),
    );
    expect(rows.map((r) => [r.script, r.scopeId ?? '-', r.dimension, r.attribution, r.tenantId ?? '-', r.vertical ?? '-', r.kind, r.quantity].join(' '))).toEqual([
      `${STABLE} ${LIVE} log_events line ${INSTALLER} tenant-a/crm live 10`,
      `${STABLE} ${LIVE} log_bytes line ${INSTALLER} tenant-a/crm live 4000`,
      // The unstamped line and the malformed one land on one script-grain row: the owner's.
      `${STABLE} - log_events script ${OWNER} tenant-a/crm live 4`,
      `${STABLE} - log_bytes script ${OWNER} tenant-a/crm live 1200`,
      `${PER_VERSION} - span_events script ${OWNER} tenant-a/crm preview 40`,
      'substrat-router - log_events platform - - live 2',
      'substrat-router - log_bytes platform - - live 500',
    ]);
  });

  it('attributes a day read before its scopes were known once their object ids are recorded', async () => {
    const { sql, host } = directory();
    await sweep(host, { cloudflareCosts: costs(async () => USAGE) });
    const preview = () => listCostDayRows(sql).filter((r) => r.objectId === hex('b'));
    expect(preview().map((r) => `${r.attribution} ${r.tenantId} ${r.scopeId} ${r.previewTag}`)).toEqual([
      'unmapped null null null',
      'unmapped null null null',
    ]);
    // The ids arrive on a later pass; the day is not read again, its rows are attributed in place.
    const later = await sweep(host, { scopeObjects: { read: objectIdOf }, cloudflareCosts: costs(async () => Promise.reject(new Error('unused'))) });
    expect(later.cloudflareCosts).toMatchObject({ due: 0, read: 0 });
    expect(preview().map((r) => `${r.attribution} ${r.tenantId} ${r.scopeId} ${r.previewTag}`)).toEqual([
      `scope ${OWNER} ${PREVIEW} pr-7`,
      `scope ${OWNER} ${PREVIEW} pr-7`,
    ]);
  });

  it('charges a preview script\'s unrecorded objects to the one tenant the copy ledger names (#3353)', async () => {
    const { sql, host, db } = directory();
    // The preview's copy, and a copy into the live script: a live script also holds scopes provisioned
    // into it, which the ledger never names, so its identity objects stay unmapped.
    db.exec(`
      INSERT INTO scope_script_copies VALUES ('${OWNER}', '${PREVIEW}', '${PER_VERSION}', 'm1', 'done');
      INSERT INTO scope_script_copies VALUES ('${INSTALLER}', '${LIVE}', '${STABLE}', 'm2', 'retained');
    `);
    await sweep(host, { cloudflareCosts: costs(async () => USAGE) });
    const objects = (rows: { objectId: string | null; attribution: string; tenantId: string | null; scopeId: string | null }[]) =>
      rows.filter((r) => r.objectId !== null && r.objectId !== hex('a')).map((r) => `${r.objectId!.slice(0, 1)} ${r.attribution} ${r.tenantId ?? '-'} ${r.scopeId ?? '-'}`);
    // The ledger names the scopes copied into a script, not which object is which: no scope.
    expect(objects(listCostDayRows(sql))).toEqual([
      'c unmapped - -', 'c unmapped - -', 'd unmapped - -', 'd unmapped - -',
      `b copy ${OWNER} -`, `b copy ${OWNER} -`,
    ]);
    // A script holding two tenants' copies names neither.
    db.exec(`INSERT INTO scope_script_copies VALUES ('${INSTALLER}', '01J00000000000000000000S09', '${PER_VERSION}', 'm3', 'done')`);
    expect(objects(attributeCostDay(USAGE, readCostDirectory(sql, DAY))).filter((l) => l.startsWith('b'))).toEqual(['b unmapped - -', 'b unmapped - -']);
  });

  it('attributes rows stored unmapped by the copy ledger on the next day read, and a recorded object id still wins', async () => {
    const { sql, host, db } = directory();
    await sweep(host, { cloudflareCosts: costs(async () => USAGE) });
    const preview = () => listCostDayRows(sql).filter((r) => r.objectId === hex('b')).map((r) => `${r.attribution} ${r.tenantId} ${r.scopeId}`);
    expect(preview()).toEqual(['unmapped null null', 'unmapped null null']);
    db.exec(`INSERT INTO scope_script_copies VALUES ('${OWNER}', '${PREVIEW}', '${PER_VERSION}', 'm1', 'done')`);
    const next = { day: '2026-11-21', workers: [], doInvocations: [], doObjects: [], namespaces: [] };
    recordCostDayRows(sql, { day: next.day, attemptedAt: NOW, usage: next });
    expect(preview()).toEqual([`copy ${OWNER} null`, `copy ${OWNER} null`]);
    await sweep(host, { scopeObjects: { read: objectIdOf }, cloudflareCosts: costs(async () => Promise.reject(new Error('unused'))) });
    expect(preview()).toEqual([`scope ${OWNER} ${PREVIEW}`, `scope ${OWNER} ${PREVIEW}`]);
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
    expect(listCostRollupDayRows(sql)).toMatchObject([{ day: DAY, error: null, rows: 14 }]);
    // A scope whose data moves to another script holds a new object, so it is due again; the
    // preview fork comes first, newest.
    db.exec(`UPDATE scopes SET serving_ref = 'tenant-a-crm-eu' WHERE scope_id = '${LIVE}'`);
    expect(scopeObjectsDueRows(sql, { nowMs: Date.now(), retryMs: 0, limit: 10 })).toEqual([
      { tenantId: INSTALLER, scopeId: LIVE, script: 'tenant-a-crm-eu', vertical: 'tenant-a/crm', kind: 'live', versionId: null, previewTag: null },
    ]);
  });
});
