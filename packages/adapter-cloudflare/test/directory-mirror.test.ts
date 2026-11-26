import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { registryStub, tenantDirectoryStub } from '../src/directory-objects.js';
import { DIRECTORY_PLACEMENT } from '../src/directory-placement.js';
import { MIRRORED_TABLES, mirrorKeyColumns, mirrorTargetsSql, type MirrorBatch } from '../src/directory-mirror.js';

/**
 * K-68 (directory split), step 3b: the directory's dual-write to the registry and the tenant
 * objects (`directory-mirror.ts`, `directory-mirror-apply.ts`). Off by default; `MIRROR_CONTROL_PLANE`
 * is the one directory with it on (`DIRECTORY_MIRROR: 'all'`).
 */
declare const __PROBE_DIRECTORY_MIRROR__: boolean;

const NOW = '2026-11-26T00:00:00.000Z';
const mirrorDirectory = () => env.MIRROR_CONTROL_PLANE.get(env.MIRROR_CONTROL_PLANE.idFromName(`mirror-${ulid()}`));
const tenantObject = (tenantId: string) => tenantDirectoryStub(env.TENANT_DIRECTORY, tenantId, 'global');

type Stub = DurableObjectStub;
const rowsOf = (stub: Stub, sql: string, ...params: unknown[]) =>
  runInDurableObject(stub, (_i, state) => state.storage.sql.exec(sql, ...params).toArray() as Record<string, unknown>[]);

const tenantRow = (id: string, extra: Record<string, string | null> = {}) => ({
  tenant_id: id, slug: `m-${id.toLowerCase()}`, name: 'M', status: 'active', created_at: NOW, deleting_at: null, provisioned_by_tenant: null, ...extra,
});
const orgRow = (tenantId: string, orgId: string, name: string) => ({ org_id: orgId, tenant_id: tenantId, slug: `o-${orgId.toLowerCase()}`, name, created_at: NOW });

describe('directory dual-write (K-68 step 3b)', () => {
  it('is off unless switched on: no trigger, no table, nothing queued', async () => {
    const plain = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`mirror-off-${ulid()}`));
    expect(await (plain as unknown as { directoryMirrorStatus(): Promise<unknown> }).directoryMirrorStatus()).toEqual({ enabled: false });
    expect(await rowsOf(plain, `SELECT name FROM sqlite_master WHERE name GLOB 'dmirror_*' OR name GLOB 'directory_mirror_*'`)).toEqual([]);
  });

  it('routes every mirrored table by SQL that compiles against the directory as built, to an object it is placed in', async () => {
    const directory = mirrorDirectory();
    await runInDurableObject(directory, (_i, state) => {
      for (const table of MIRRORED_TABLES) {
        const keys = mirrorKeyColumns(state.storage.sql, table);
        const targets = mirrorTargetsSql(table, 't');
        // Prepared against the built table, so a column a route or key names that is not there throws here.
        state.storage.sql.exec(`SELECT json_array(${keys.map((k) => `t."${k}"`).join(', ')}), ${targets.join(', ')} FROM "${table}" t LIMIT 0`);
        const to = DIRECTORY_PLACEMENT[table]!.to;
        const text = targets.join(' ');
        if (text.includes(`'registry'`)) expect({ table, to }).toEqual({ table, to: expect.stringMatching(/^(registry|both)$/) });
        if (text.includes(`'tenant:'`) || text.includes('subject')) expect({ table, to }).toEqual({ table, to: expect.stringMatching(/^(tenant|both)$/) });
      }
      const triggers = state.storage.sql.exec(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'dmirror_*'`).one() as { n: number };
      expect(triggers.n).toBe(MIRRORED_TABLES.length * 3);
    });
  });

  it('copies each write to the objects its row is placed in, once the directory has committed it', async () => {
    const directory = mirrorDirectory();
    const t = ulid();
    // A real method: its return kicks the flush, which `settleDirectoryMirror` waits for.
    await directory.createTenant(t, `m-${t.toLowerCase()}`, 'First', NOW);
    await directory.setTenantName(t, 'Second');
    const org = ulid();
    await runInDurableObject(directory, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO orgs (org_id, tenant_id, slug, name, created_at) VALUES (?, ?, ?, 'Gone', ?)`, org, t, `o-${org.toLowerCase()}`, NOW);
      state.storage.sql.exec(`DELETE FROM orgs WHERE org_id = ?`, org);
    });
    await directory.settleDirectoryMirror();
    expect(await directory.directoryMirrorStatus()).toMatchObject({ enabled: true, queued: 0 });
    expect(await tenantObject(t).mirrorStatus()).toMatchObject({ parked: 0 });

    // `tenants` goes to both: D is authoritative, G keeps the projection (rfc §7.3).
    const name = `SELECT name FROM tenants WHERE tenant_id = ?`;
    expect(await rowsOf(tenantObject(t), name, t)).toEqual([{ name: 'Second' }]);
    expect(await rowsOf(registryStub(env.DIRECTORY_REGISTRY), name, t)).toEqual([{ name: 'Second' }]);
    // The org was written and deleted before the flush read it: the object gets the delete, as a tombstone.
    expect(await rowsOf(tenantObject(t), `SELECT org_id FROM orgs WHERE org_id = ?`, org)).toEqual([]);
    expect(await rowsOf(tenantObject(t), `SELECT deleted FROM directory_mirror_rows WHERE tbl = 'orgs' AND row_key = ?`, JSON.stringify([org]))).toEqual([{ deleted: 1 }]);
  });

  it('applies a key once and never backwards: an older copy cannot overwrite a newer write or undo a delete', async () => {
    const t = ulid();
    const org = ulid();
    const object = tenantObject(t);
    const owner = `tenant:${t}`;
    const apply = (version: number, changes: MirrorBatch['changes']) => object.applyMirror(owner, 'global', { version, changes });
    const key = JSON.stringify([org]);
    await apply(1, [{ table: 'tenants', key: JSON.stringify([t]), row: tenantRow(t) }]);
    expect(await apply(5, [{ table: 'orgs', key, row: orgRow(t, org, 'new') }])).toMatchObject({ applied: 1 });
    // A resend, or 3c's backfill page read before version 5: stale.
    expect(await apply(3, [{ table: 'orgs', key, row: orgRow(t, org, 'old') }])).toMatchObject({ applied: 0, stale: 1 });
    expect(await rowsOf(object, `SELECT name FROM orgs WHERE org_id = ?`, org)).toEqual([{ name: 'new' }]);
    await apply(6, [{ table: 'orgs', key, row: null }]);
    expect(await apply(4, [{ table: 'orgs', key, row: orgRow(t, org, 'old') }])).toMatchObject({ stale: 1 });
    expect(await rowsOf(object, `SELECT name FROM orgs WHERE org_id = ?`, org)).toEqual([]);
    // A table not placed here is refused, and parked rather than lost.
    expect(await apply(7, [{ table: 'verticals', key: JSON.stringify(['x']), row: { slug: 'x' } }])).toMatchObject({ parked: 1 });
  });

  it('prunes a tombstone once no older copy of its row can still arrive (a day)', async () => {
    const t = ulid();
    const object = tenantObject(t);
    const owner = `tenant:${t}`;
    const [old, fresh] = [ulid(), ulid()];
    await object.applyMirror(owner, 'global', { version: 1, changes: [{ table: 'orgs', key: JSON.stringify([fresh]), row: null }] });
    await runInDurableObject(object, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO directory_mirror_rows (tbl, row_key, version, deleted, at) VALUES ('orgs', ?, 1, 1, '2026-01-01T00:00:00.000Z')`, JSON.stringify([old]));
    });
    await object.applyMirror(owner, 'global', { version: 2, changes: [{ table: 'tenants', key: JSON.stringify([t]), row: tenantRow(t) }] });
    const kept = await rowsOf(object, `SELECT row_key FROM directory_mirror_rows WHERE tbl = 'orgs' ORDER BY row_key`);
    expect(kept).toEqual([{ row_key: JSON.stringify([fresh]) }]);
  });

  it('parks a change the object refuses, and applies it once the row it needs arrives', async () => {
    const registry = registryStub(env.DIRECTORY_REGISTRY);
    const [provisioner, managed] = [ulid(), ulid()];
    const managedChange = { table: 'tenants', key: JSON.stringify([managed]), row: tenantRow(managed, { provisioned_by_tenant: provisioner }) };
    // The registry holds every tenant and keeps the reference, so the managed tenant waits for its provisioner.
    expect(await registry.applyMirror('registry', 'global', { version: 10, changes: [managedChange] })).toMatchObject({ parked: 1 });
    const healed = await registry.applyMirror('registry', 'global', {
      version: 11,
      changes: [{ table: 'tenants', key: JSON.stringify([provisioner]), row: tenantRow(provisioner) }],
    });
    expect(healed).toMatchObject({ applied: 1, healed: 1 });
    expect(await rowsOf(registry, `SELECT provisioned_by_tenant FROM tenants WHERE tenant_id = ?`, managed)).toEqual([{ provisioned_by_tenant: provisioner }]);
    expect(await rowsOf(registry, `SELECT 1 FROM directory_mirror_parked WHERE row_key = ?`, JSON.stringify([managed]))).toEqual([]);
    // A tenant object has no provisioner row and needs none: the reference is not built there.
    expect(await tenantObject(managed).applyMirror(`tenant:${managed}`, 'global', { version: 12, changes: [managedChange] })).toMatchObject({ applied: 1 });
  });

  it('keeps the rows of an object that refuses a batch queued, and acknowledges the others', async () => {
    const directory = mirrorDirectory();
    const [refusing, fine] = [ulid(), ulid()];
    // Bound to another jurisdiction, so every call addressed `global` is refused.
    await tenantObject(refusing).recordCrossing(`tenant:${refusing}`, 'eu', {
      crossingId: ulid(), kind: 'test', namespace: 'hostname', key: `${ulid().toLowerCase()}.test`, holder: refusing,
    });
    await directory.createTenant(refusing, `m-${refusing.toLowerCase()}`, 'R', NOW);
    await directory.createTenant(fine, `m-${fine.toLowerCase()}`, 'F', NOW);
    await expect(() => directory.settleDirectoryMirror()).rejects.toThrow(/refused a batch/);
    expect(await rowsOf(tenantObject(fine), `SELECT name FROM tenants WHERE tenant_id = ?`, fine)).toEqual([{ name: 'F' }]);
    const queued = await rowsOf(directory, `SELECT DISTINCT target FROM directory_mirror_outbox`);
    expect(queued).toEqual([{ target: `tenant:${refusing}` }]);
  });

  it('survives a restore: the version never goes back, the triggers return, and the objects are marked stale', async () => {
    const directory = mirrorDirectory();
    const t = ulid();
    await directory.createTenant(t, `m-${t.toLowerCase()}`, 'R', NOW);
    await directory.settleDirectoryMirror();
    const before = await directory.directoryMirrorStatus();
    await directory.importDump(await directory.exportDump());
    const after = await directory.directoryMirrorStatus();
    expect(after).toMatchObject({ enabled: true, version: (before as { version: number }).version, restoredAt: expect.any(String) });
    const triggers = await rowsOf(directory, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'dmirror_*'`);
    expect(triggers).toEqual([{ n: MIRRORED_TABLES.length * 3 }]);
  });

  // Part 2: the registry's claims, through the intent-first crossing (rfc §7.3).
  const bindHostname = (stub: Stub, hostname: string, tenant: string) =>
    runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO hostnames (hostname, tenant_id, scope_id, surface, status, created_at) VALUES (?, ?, ?, 'app', 'active', ?)`,
        hostname, tenant, ulid(), NOW,
      );
    });
  const sqlIn = (stub: Stub, sql: string, ...params: unknown[]) =>
    runInDurableObject(stub, (_i, state) => void state.storage.sql.exec(sql, ...params));

  it('claims in the registry what the directory decided: id and slug on create, a hostname on bind, released on delete and reap', async () => {
    const directory = mirrorDirectory();
    const registry = registryStub(env.DIRECTORY_REGISTRY);
    const t = ulid();
    const slug = `m-${t.toLowerCase()}`;
    const hostname = `${ulid().toLowerCase()}.mirror.test`;
    await directory.createTenant(t, slug, 'Claims', NOW);
    await bindHostname(directory, hostname, t);
    await directory.settleDirectoryMirror();
    for (const [namespace, key] of [['tenant-id', t], ['tenant-slug', slug], ['hostname', hostname]] as const) {
      expect(await registry.readClaim(namespace, key)).toMatchObject({ holder: t, state: 'confirmed' });
    }
    await sqlIn(directory, `DELETE FROM hostnames WHERE hostname = ?`, hostname);
    await directory.settleDirectoryMirror();
    expect(await registry.readClaim('hostname', hostname)).toBeNull();
    // A reap frees the slug and keeps the id for good, so it is never reused (rfc §7.3).
    await sqlIn(directory, `UPDATE tenants SET status = 'reaped' WHERE tenant_id = ?`, t);
    await directory.settleDirectoryMirror();
    expect(await registry.readClaim('tenant-slug', slug)).toBeNull();
    expect(await registry.readClaim('tenant-id', t)).toMatchObject({ holder: t, state: 'tombstone' });
    expect(await runInDurableObject(tenantObject(t), (_i, state) => state.storage.sql.exec('SELECT COUNT(*) AS n FROM directory_mirror_releases').one())).toEqual({ n: 0 });
  });

  it('a claim the registry refuses is a difference, not a decision: the crossing fails and the row still applies', async () => {
    const directory = mirrorDirectory();
    const registry = registryStub(env.DIRECTORY_REGISTRY);
    const [t, other] = [ulid(), ulid()];
    const hostname = `${ulid().toLowerCase()}.mirror.test`;
    const claimId = ulid();
    await registry.claim({ namespace: 'hostname', key: hostname, claimId, holder: other, leaseMs: 60_000 });
    await registry.confirmClaim({ namespace: 'hostname', key: hostname, claimId });
    await bindHostname(directory, hostname, t);
    const flush = await directory.settleDirectoryMirror();
    expect(flush?.claims).toMatchObject({ refused: 1, errors: 0 });
    expect(await registry.readClaim('hostname', hostname)).toMatchObject({ holder: other });
    expect(await rowsOf(tenantObject(t), `SELECT tenant_id FROM hostnames WHERE hostname = ?`, hostname)).toEqual([{ tenant_id: t }]);
  });

  // Opt-in (`SUBSTRAT_PROBE_DIRECTORY_MIRROR=1`): the rows the dual-write adds per directory write, by
  // write class: the trigger's outbox row in the directory's own transaction, then the flush's rows in
  // the directory (its version and ack) and in the object (the row, its indexes, its version row).
  it.runIf(__PROBE_DIRECTORY_MIRROR__)('probe: rows written per directory write, mirror off vs on', async () => {
    const N = 20;
    const fill = (sql: SqlStorage, table: string, over: Record<string, unknown>) => {
      const cols = sql.exec(`SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info(?)`, table).toArray() as {
        name: string; type: string; nn: number; d: unknown; pk: number;
      }[];
      const row: Record<string, unknown> = {};
      for (const c of cols) if ((c.nn || c.pk) && c.d === null) row[c.name] = /INT/i.test(c.type) ? 1 : `${c.name}-${ulid()}`;
      Object.assign(row, over);
      const names = Object.keys(row);
      return { sql: `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, params: Object.values(row) };
    };
    type Write = (sql: SqlStorage, t: string, scope: string, i: number) => { sql: string; params: unknown[] };
    const classes: Record<string, Write> = {
      'tenants insert (both objects)': (sql) => { const id = ulid(); return fill(sql, 'tenants', { tenant_id: id, slug: `p-${id.toLowerCase()}`, status: 'active' }); },
      'admin_log insert (tenant)': (sql, t) => fill(sql, '_substrat_admin_log', { id: ulid(), tenant_id: t, scope_id: null }),
      'sweep_runs insert (tenant)': (sql, t, scope) => fill(sql, '_substrat_sweep_runs', { id: ulid(), tenant_id: t, scope_id: scope }),
      'scopes update, bookkeeping column (tenant)': (_sql, _t, scope, i) => ({ sql: `UPDATE scopes SET migration_attempts = ? WHERE scope_id = ?`, params: [i + 1, scope] }),
      'connector_state upsert (via connection)': (sql, t, _s, i) =>
        ({ sql: `INSERT INTO _substrat_connector_state (connection_id, state_key, value, updated_at) VALUES (?, 'cursor', ?, ?) ON CONFLICT (connection_id, state_key) DO UPDATE SET value = excluded.value`, params: [`conn-${t}`, `v${i}`, NOW] }),
    };
    const setup = (sql: SqlStorage, t: string, scope: string) => {
      const tenant = fill(sql, 'tenants', { tenant_id: t, slug: `p-${t.toLowerCase()}`, status: 'active' });
      sql.exec(tenant.sql, ...tenant.params);
      const sc = fill(sql, 'scopes', { scope_id: scope, tenant_id: t });
      sql.exec(sc.sql, ...sc.params);
      const conn = fill(sql, '_substrat_connections', { id: `conn-${t}`, tenant_id: t });
      sql.exec(conn.sql, ...conn.params);
    };
    const measure = async (stub: DurableObjectStub, write: Write) => {
      const [t, scope] = [ulid(), ulid()];
      await runInDurableObject(stub, (_i, state) => setup(state.storage.sql, t, scope));
      await (stub as unknown as { settleDirectoryMirror(): Promise<unknown> }).settleDirectoryMirror();
      return runInDurableObject(stub, (_i, state) => {
        let rows = 0;
        for (let i = 0; i < N; i++) {
          const w = write(state.storage.sql, t, scope, i);
          rows += state.storage.sql.exec(w.sql, ...w.params).rowsWritten;
        }
        return rows / N;
      });
    };
    const report: Record<string, unknown> = {};
    for (const [name, write] of Object.entries(classes)) {
      const off = await measure(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`probe-off-${ulid()}`)), write);
      const mirror = mirrorDirectory();
      const on = await measure(mirror, write);
      const flush = (await mirror.settleDirectoryMirror())!;
      report[name] = {
        directoryOff: off,
        directoryOn: on,
        flushDirectoryPerWrite: flush.rowsWrittenDirectory / N,
        objectsPerWrite: flush.rowsWrittenObjects / N,
        sent: flush.sent,
        parked: flush.parked,
      };
    }
    console.log('directory mirror rows written per write', JSON.stringify(report, null, 2));
  }, 60_000);
});
