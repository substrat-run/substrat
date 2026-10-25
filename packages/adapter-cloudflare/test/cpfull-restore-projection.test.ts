import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
  type ScopeDump,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #2555 PR 2 on workerd: a control-plane-full restore or import (`restoreScope`, `importScope`) on a
 * host that projects permissions into its scopes writes the directory's CURRENT permission state in
 * the load's own transaction, judged there against the seats the dump brings. The dump's tenant
 * tuples, entitlements and connection keys never come back over what the directory holds now; the
 * scope's own seats are the dump's and are not revoked; the destination keeps its permission flags.
 */
const USE = 'cpr:use' as PermissionKey;
const RUN = 'cpr:run' as PermissionKey;
const SENTENCE = /^restore refused: role 'staffer' is refused by the reserved-key rule, judged against the roles and seats this scope holds as the write lands \(K-55\); nothing was written$/;

const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);
const stubOf = (scope: ScopeId) => env.SCOPE.get(env.SCOPE.idFromName(scope));

/** Every row of every table the scope holds, in a stable order: what a refused load must leave. */
const everything = (scope: ScopeId) =>
  runInDurableObject(stubOf(scope), (_instance, state) => {
    const sql = state.storage.sql;
    const tables = sql
      .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name`)
      .toArray() as unknown as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [name, sql.exec(`SELECT * FROM "${name}"`).toArray().map((r) => JSON.stringify(r)).sort()]),
    );
  });

/** The permission state a projection writes, and the seats and flags around it. */
const permissionState = (scope: ScopeId) =>
  runInDurableObject(stubOf(scope), (_instance, state) => {
    const sql = state.storage.sql;
    const rows = (q: string) => sql.exec(q).toArray();
    return {
      // A tombstone's time is when it was made, not what it is.
      roles: rows('SELECT tenant_id, role_key, permissions, holder, revoked_at IS NOT NULL AS dropped FROM _substrat_roles ORDER BY tenant_id, role_key'),
      tenantTuples: rows('SELECT tenant_id, subject, relation, object, expires_at, revoked_at FROM _substrat_tenant_tuples ORDER BY subject, relation, object'),
      entitlements: rows('SELECT tenant_id, entitlement_key, expires_at, quota, plan FROM _substrat_entitlements ORDER BY entitlement_key'),
      identities: rows('SELECT tenant_id, provider, external_id, principal_id, scope_id FROM _substrat_identity_links ORDER BY provider, external_id'),
      connectionKeys: rows('SELECT tenant_id, connection_id, provider, key_id, public_key FROM _substrat_connection_keys ORDER BY connection_id'),
      seats: rows('SELECT subject, relation, object, revoked_at FROM _substrat_tuples ORDER BY subject, relation, object'),
      flags: rows(`SELECT key, value FROM _substrat_meta WHERE key IN ('permission_source', 'entitlements_enforced') ORDER BY key`),
    };
  });

/** Write this store's permission flags as given (null: unset), as a scope from another history holds them. */
const setFlags = (scope: ScopeId, flags: Record<'permission_source' | 'entitlements_enforced', string | null>) =>
  runInDurableObject(stubOf(scope), (_instance, state) => {
    for (const [key, value] of Object.entries(flags)) {
      state.storage.sql.exec(`DELETE FROM _substrat_meta WHERE key = ?`, key);
      if (value !== null) state.storage.sql.exec(`INSERT INTO _substrat_meta (key, value) VALUES (?, ?)`, key, value);
    }
  });

/** `dump` with `rows` added to table `name`, each written by column name (a column it leaves out is null). */
const withRows = (dump: ScopeDump, name: string, rows: Record<string, unknown>[]): ScopeDump => ({
  ...dump,
  tables: dump.tables.map((t) => (t.name === name ? { ...t, rows: [...t.rows, ...rows.map((r) => t.columns.map((c) => r[c] ?? null))] } : t)),
});

/** `dump` with its `_substrat_meta` permission flags replaced (null: none). */
const withDumpFlags = (dump: ScopeDump, flags: Record<'permission_source' | 'entitlements_enforced', string | null>): ScopeDump => {
  const meta = dump.tables.find((t) => t.name === '_substrat_meta')!;
  const k = meta.columns.indexOf('key');
  const kept = meta.rows.filter((r) => !(String(r[k]) in flags));
  const added = Object.entries(flags).flatMap(([key, value]) => (value === null ? [] : [meta.columns.map((c) => (c === 'key' ? key : c === 'value' ? value : null))]));
  return { ...dump, tables: dump.tables.map((t) => (t === meta ? { ...t, rows: [...kept, ...added] } : t)) };
};

/** Runs `between` right after `method` of `host` resolves. */
const after = (host: CloudflareScopeHost, method: 'refuseDumpRoles' | 'loadProjectionFor' | 'convergeLoadedProjection', between: () => Promise<void>) => {
  const target = host as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = target[method]!;
  target[method] = async (...args: unknown[]) => {
    const out = await original.apply(host, args);
    await between();
    return out;
  };
  return () => {
    delete target[method];
  };
};

describe('a control-plane-full restore projects the directory’s current permission state in its load (#2555 PR 2)', () => {
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, scopeLocalPermissions: true });
  });
  afterAll(() => host.close());

  /** A tenant with one active scope: alice seated there in `member`, bob in `member` tenant-wide, one entitlement. */
  const setup = async () => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const alice = principalId.parse(ulid());
    const bob = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `cpr-${t.toLowerCase()}`, name: 'Restore projection' });
    await host.admin.defineRole(staff, t, { key: 'member', permissions: [USE], source: 'vertical' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'cpr' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'member', node: { tenantId: t, scopeId: s } });
    await host.admin.assignRole(staff, { principalId: bob, roleKey: 'member', node: { tenantId: t, scopeId: null } });
    await host.admin.grantEntitlement(staff, t, 'sku:kept');
    await host.admin.grantEntitlement(staff, t, 'sku:revoked');
    return { t, s, alice, bob };
  };
  const liveTenantSubjects = (state: Awaited<ReturnType<typeof permissionState>>) =>
    state.tenantTuples.filter((r) => r.revoked_at === null).map((r) => String(r.subject));

  it('nothing the directory has revoked since the dump comes back: a member, an entitlement, a connection grant and key', async () => {
    const { t, s, alice, bob } = await setup();
    const connection = ulid();
    // A dump carrying what the directory no longer holds: written into it as rows, as a scope that
    // held a connection's grant and sealing key when it was exported carries them.
    const dump = withRows(
      withRows(await host.admin.exportScope(staff, t, s), '_substrat_tenant_tuples', [
        { tenant_id: t, subject: `connection:${connection}`, relation: USE, object: `tenant:${t}`, expires_at: null, revoked_at: null },
      ]),
      '_substrat_connection_keys',
      [{ tenant_id: t, connection_id: connection, provider: 'cpr', key_id: ulid(), public_key: 'cHVibGlj' }],
    );
    await host.admin.unassignRole(staff, { principalId: bob, roleKey: 'member', node: { tenantId: t, scopeId: null } });
    await host.admin.revokeEntitlement(staff, t, 'sku:revoked');
    // And a principal seated since, tenant-wide: the directory's, so it is there after the restore.
    const dave = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: dave, roleKey: 'member', node: { tenantId: t, scopeId: null } });

    await host.restoreScope(staff, t, s, dump);
    const state = await permissionState(s);
    expect(liveTenantSubjects(state).some((x) => x.includes(bob))).toBe(false);
    expect(liveTenantSubjects(state).some((x) => x.includes(dave))).toBe(true);
    expect(liveTenantSubjects(state).some((x) => x.includes(connection))).toBe(false);
    expect(state.entitlements.map((e) => e.entitlement_key)).toEqual(['sku:kept']);
    expect(state.connectionKeys).toEqual([]);
    // The scope's own seat, the dump's, is kept: the projection revokes no seat.
    expect(state.seats.filter((r) => r.revoked_at === null && String(r.subject).includes(alice))).toHaveLength(1);
  });

  it('twin: the same restore on a host that does not project carries the dump’s rows as they were', async () => {
    const flagOff = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, scopeLocalPermissions: false });
    try {
      const t = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      await flagOff.admin.createTenant(staff, { id: t, slug: `cpr-off-${t.toLowerCase()}`, name: 'Restore, not projected' });
      await flagOff.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'cpr' });
      await flagOff.admin.activateScope(staff, t, s);
      await flagOff.admin.grantEntitlement(staff, t, 'sku:kept');
      const dump = withRows(await flagOff.admin.exportScope(staff, t, s), '_substrat_entitlements', [
        { tenant_id: t, entitlement_key: 'sku:dumped', expires_at: null, quota: null, plan: null },
      ]);
      await flagOff.restoreScope(staff, t, s, dump);
      // The scope reads the directory over RPC there; its own rows are the dump's.
      expect((await permissionState(s)).entitlements.map((e) => e.entitlement_key)).toEqual(['sku:dumped']);
    } finally {
      await flagOff.close();
    }
  });

  it('the destination keeps its flags: a dump from before the scope was projected does not turn enforcement off', async () => {
    const { t, s } = await setup();
    const before = (await permissionState(s)).flags;
    expect(before).toEqual([
      { key: 'entitlements_enforced', value: '1' },
      { key: 'permission_source', value: 'local' },
    ]);
    const dump = withDumpFlags(await host.admin.exportScope(staff, t, s), { permission_source: 'control-plane', entitlements_enforced: null });
    await host.restoreScope(staff, t, s, dump);
    expect((await permissionState(s)).flags).toEqual(before);
  });

  it('on a host that does not project, the destination’s flags are kept the other way too: the dump’s local reader is not taken', async () => {
    const flagOff = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, scopeLocalPermissions: false });
    try {
      const t = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      await flagOff.admin.createTenant(staff, { id: t, slug: `cpr-flags-${t.toLowerCase()}`, name: 'Restore flags' });
      await flagOff.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'cpr' });
      await flagOff.admin.activateScope(staff, t, s);
      await setFlags(s, { permission_source: null, entitlements_enforced: null });
      const dump = withDumpFlags(await flagOff.admin.exportScope(staff, t, s), { permission_source: 'local', entitlements_enforced: '1' });
      await flagOff.restoreScope(staff, t, s, dump);
      expect((await permissionState(s)).flags).toEqual([]);
      // And a destination that reads locally keeps doing so over a dump that says otherwise.
      await setFlags(s, { permission_source: 'local', entitlements_enforced: '1' });
      await flagOff.restoreScope(staff, t, s, withDumpFlags(dump, { permission_source: 'control-plane', entitlements_enforced: null }));
      expect((await permissionState(s)).flags).toEqual([
        { key: 'entitlements_enforced', value: '1' },
        { key: 'permission_source', value: 'local' },
      ]);
    } finally {
      await flagOff.close();
    }
  });

  it('the end state equals the old load followed by one fan-out', async () => {
    const { t, s, bob } = await setup();
    const dump = await host.admin.exportScope(staff, t, s);
    await host.admin.unassignRole(staff, { principalId: bob, roleKey: 'member', node: { tenantId: t, scopeId: null } });
    await host.admin.revokeEntitlement(staff, t, 'sku:revoked');
    await host.admin.defineRole(staff, t, { key: 'member', permissions: [USE, 'cpr:read' as PermissionKey], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'late', permissions: [USE], source: 'vertical' });

    await host.restoreScope(staff, t, s, dump);
    const projected = await permissionState(s);
    // The old load (the dump as is), then the fan-out every tenant-level write ends with.
    await (stubOf(s) as unknown as { importDump(tables: ScopeDump['tables'], dest: ScopeId, opts: { sourceScopeId: ScopeId }): Promise<unknown> })
      .importDump(dump.tables, s, { sourceScopeId: s });
    await host.reconcileTenantProjection(t);
    expect(await permissionState(s)).toEqual(projected);
  });

  it('a role set refused in the load’s unit leaves every row of the scope as it was', async () => {
    const { t, s, alice } = await setup();
    await host.admin.defineRole(staff, t, { key: 'staffer', permissions: [USE], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'staffer', node: { tenantId: t, scopeId: s } });
    const dump = await host.admin.exportScope(staff, t, s);
    await host.admin.unassignRole(staff, { principalId: alice, roleKey: 'staffer', node: { tenantId: t, scopeId: s } });
    let before: Awaited<ReturnType<typeof everything>> | undefined;
    // The host's pre-check reads `staffer` a person's role and admits the dump; the directory then
    // makes it system-held before the load, and the load's unit sees the dump's seat in it.
    const restore = after(host, 'refuseDumpRoles', async () => {
      await host.admin.defineRole(staff, t, { key: 'staffer', permissions: [RUN], source: 'vertical', holder: 'system' });
      before = await everything(s);
    });
    try {
      const refused = await failure(host.restoreScope(staff, t, s, dump));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(SENTENCE);
      expect(refused?.message).not.toContain(alice);
    } finally {
      restore();
    }
    expect(await everything(s)).toEqual(before);
  });

  it('twin: with no seat in the role in the dump, the same change in between is admitted, and lands judged', async () => {
    const { t, s } = await setup();
    await host.admin.defineRole(staff, t, { key: 'staffer', permissions: [USE], source: 'vertical' });
    const dump = await host.admin.exportScope(staff, t, s);
    const restore = after(host, 'refuseDumpRoles', async () => {
      await host.admin.defineRole(staff, t, { key: 'staffer', permissions: [RUN], source: 'vertical', holder: 'system' });
    });
    try {
      await host.restoreScope(staff, t, s, dump);
    } finally {
      restore();
    }
    expect((await permissionState(s)).roles.find((r) => r.role_key === 'staffer')).toMatchObject({ holder: 'system', dropped: 0 });
  });

  it('a directory role the dump has no part in does not refuse the load: only the loaded state’s roles are asked about', async () => {
    const { t, s } = await setup();
    const dump = await host.admin.exportScope(staff, t, s);
    // Handed to the ScopeDO directly: a person's role holding a key this scope class reserves, which
    // the whole set's walk refuses wherever it is asked (the directory's own door refuses it too, so
    // no restore can carry it). Nothing the dump seats or stores is it.
    const load = (roles: { role_key: string; permissions: string; source: string; holder?: 'person' | 'system' | null }[]) =>
      (stubOf(s) as unknown as { importDumpProjected(...args: unknown[]): Promise<{ value?: unknown; failure?: { message: string } }> }).importDumpProjected(
        dump.tables,
        s,
        { sourceScopeId: s },
        { tenantId: t, roles, tuples: [], entitlements: [], identities: [], connectionKeys: [], judge: { reserved: [], declared: [] } },
      );
    const odd = { role_key: 'odd', permissions: JSON.stringify(['rsv:run']), source: 'vertical', holder: 'person' as const };
    const member = { role_key: 'member', permissions: JSON.stringify([USE]), source: 'vertical', holder: 'person' as const };
    expect((await load([member, odd])).failure).toBeUndefined();
    expect((await permissionState(s)).roles.map((r) => r.role_key)).toContain('odd');
    // Twin: the same role, seated by the dump, is asked about and refused.
    const seated = withRows(dump, '_substrat_tuples', [{ subject: `principal:${ulid()}`, relation: 'role:odd', object: `scope:${s}`, expires_at: null, revoked_at: null }]);
    const refused = await (stubOf(s) as unknown as { importDumpProjected(...args: unknown[]): Promise<{ failure?: { message: string } }> }).importDumpProjected(
      seated.tables,
      s,
      { sourceScopeId: s },
      { tenantId: t, roles: [member, odd], tuples: [], entitlements: [], identities: [], connectionKeys: [], judge: { reserved: [], declared: [] } },
    );
    expect(refused.failure?.message).toMatch(/role 'odd' is refused by the reserved-key rule/);
  });

  it('a directory write between the host’s read and the load is not left stale: the scope is projected once more', async () => {
    const { t, s } = await setup();
    const dump = await host.admin.exportScope(staff, t, s);
    // Fanned out to the scope before the load, which would replace it with the older read.
    const restore = after(host, 'loadProjectionFor', async () => {
      restore();
      await host.admin.grantEntitlement(staff, t, 'sku:between');
    });
    try {
      await host.restoreScope(staff, t, s, dump);
    } finally {
      restore();
    }
    expect((await permissionState(s)).entitlements.map((e) => e.entitlement_key)).toContain('sku:between');
    const audit = (await host.admin.auditLog(staff, { tenantId: t })).filter((r) => r.action === 'restoreScope');
    expect(audit.at(-1)?.after).toMatchObject({ reprojected: true });
  });

  it('a directory write after the second read reaches the scope by its own fan-out; no re-projection is made', async () => {
    const { t, s } = await setup();
    const dump = await host.admin.exportScope(staff, t, s);
    const restore = after(host, 'convergeLoadedProjection', async () => {
      await host.admin.grantEntitlement(staff, t, 'sku:after');
    });
    try {
      await host.restoreScope(staff, t, s, dump);
    } finally {
      restore();
    }
    expect((await permissionState(s)).entitlements.map((e) => e.entitlement_key)).toContain('sku:after');
    const audit = (await host.admin.auditLog(staff, { tenantId: t })).filter((r) => r.action === 'restoreScope');
    expect(audit.at(-1)?.after).not.toHaveProperty('reprojected');
  });

  it('an import lands with the directory’s current state too, its seats kept', async () => {
    const { t, s, alice, bob } = await setup();
    const dump = await host.admin.exportScope(staff, t, s);
    await host.admin.unassignRole(staff, { principalId: bob, roleKey: 'member', node: { tenantId: t, scopeId: null } });
    await host.admin.revokeEntitlement(staff, t, 'sku:revoked');
    const fresh = scopeId.parse(ulid());
    await host.importScope(staff, { tenantId: t, scopeId: fresh, vertical: 'cpr' }, withDumpFlags(dump, { permission_source: 'control-plane', entitlements_enforced: null }));
    const state = await permissionState(fresh);
    expect(liveTenantSubjects(state).some((x) => x.includes(bob))).toBe(false);
    expect(state.entitlements.map((e) => e.entitlement_key)).toEqual(['sku:kept']);
    expect(state.seats.filter((r) => r.revoked_at === null && String(r.subject).includes(alice))).toHaveLength(1);
    expect(state.flags).toEqual([
      { key: 'entitlements_enforced', value: '1' },
      { key: 'permission_source', value: 'local' },
    ]);
  });

  /** A dump seating alice in `staffer`, which the directory makes system-held after the host's pre-check. */
  const refusedImport = async () => {
    const { t, s, alice } = await setup();
    await host.admin.defineRole(staff, t, { key: 'staffer', permissions: [USE], source: 'vertical' });
    const clean = await host.admin.exportScope(staff, t, s);
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'staffer', node: { tenantId: t, scopeId: s } });
    const dump = await host.admin.exportScope(staff, t, s);
    await host.admin.unassignRole(staff, { principalId: alice, roleKey: 'staffer', node: { tenantId: t, scopeId: s } });
    const fresh = scopeId.parse(ulid());
    const restore = after(host, 'refuseDumpRoles', async () => {
      await host.admin.defineRole(staff, t, { key: 'staffer', permissions: [RUN], source: 'vertical', holder: 'system' });
    });
    try {
      return { t, alice, fresh, clean, refused: await failure(host.importScope(staff, { tenantId: t, scopeId: fresh, vertical: 'cpr' }, dump)) };
    } finally {
      restore();
    }
  };

  it('an import refused in the load’s unit takes its never-activated scope down, and a retry with the same id imports', async () => {
    const { t, fresh, clean, refused } = await refusedImport();
    expect(errorCodeOf(refused)).toBe('forbidden');
    expect(refused?.message).toMatch(SENTENCE);
    expect((await host.admin.getScopeRecord(staff, t, fresh)) ?? null).toBeNull();
    // No admin row for a teardown of an import that never happened; its provision row is the record.
    const actions = (await host.admin.auditLog(staff, { tenantId: t })).filter((r) => r.scopeId === fresh).map((r) => r.action);
    expect(actions).not.toContain('importScope');
    expect(actions).not.toContain('deleteSnapshot');
    // The same id, with a dump the rule admits.
    await host.importScope(staff, { tenantId: t, scopeId: fresh, vertical: 'cpr' }, clean);
    expect((await host.admin.getScopeRecord(staff, t, fresh))?.status).toBe('active');
  });

  it('a teardown that fails leaves the refusal as the answer, files a staff-only ops row, and the scope in provisioning', async () => {
    const view = host as unknown as { cp: object };
    const original = view.cp;
    view.cp = new Proxy(original, {
      get: (target, prop) =>
        prop === 'deleteScopeDirectory' ? () => Promise.reject(new Error('directory unavailable')) : Reflect.get(target, prop),
    });
    let outcome: Awaited<ReturnType<typeof refusedImport>>;
    try {
      outcome = await refusedImport();
    } finally {
      view.cp = original;
    }
    const { t, alice, fresh, refused } = outcome;
    expect(refused?.message).toMatch(SENTENCE);
    expect((await host.admin.getScopeRecord(staff, t, fresh))?.status).toBe('provisioning');
    const rows = (await host.admin.listOpsFailures(staff)).filter((r) => r.scopeId === fresh);
    expect(rows).toEqual([expect.objectContaining({ operation: 'importScope', stage: 'refused-import-teardown', tenantId: null })]);
    expect(rows[0]?.message).toMatch(/directory unavailable/);
    // None of the dump was loaded into it.
    expect((await permissionState(fresh)).seats.filter((r) => String(r.subject).includes(alice))).toEqual([]);
  });

  it('a host meeting a ScopeDO without importDumpProjected is refused by the runtime: nothing loaded (version skew)', async () => {
    const { t, s } = await setup();
    const dump = withRows(await host.admin.exportScope(staff, t, s), '_substrat_entitlements', [
      { tenant_id: t, entitlement_key: 'sku:dumped', expires_at: null, quota: null, plan: null },
    ]);
    const before = await everything(s);
    const view = host as unknown as { scopeStub(id: ScopeId): Record<string, unknown> };
    const original = view.scopeStub;
    let unprojected = 0;
    view.scopeStub = (id: ScopeId) =>
      new Proxy(original.call(host, id), {
        get: (target, prop) => {
          // Simulated, as reaching a missing method on a real stub also rejects inside the test harness.
          if (prop === 'importDumpProjected') return () => Promise.reject(new TypeError('The RPC receiver does not implement "importDumpProjected".'));
          if (prop === 'importDump') unprojected += 1;
          return Reflect.get(target, prop);
        },
      });
    try {
      const refused = await failure(host.restoreScope(staff, t, s, dump));
      expect(refused?.message).toMatch(/does not implement "importDumpProjected"/);
    } finally {
      view.scopeStub = original;
    }
    expect(unprojected).toBe(0);
    expect(await everything(s)).toEqual(before);
  });
});
