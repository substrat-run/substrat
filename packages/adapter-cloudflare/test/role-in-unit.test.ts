import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  permissionKey,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type RoleDefinition,
  type ScopeDumpPage,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';

/**
 * #2531 part C on workerd: a CP-less host judges the role set a projection or a load writes INSIDE
 * the unit that writes it, against the roles, tombstones and seats the scope holds as it writes.
 *
 * - A projection (`provisionScopeLocal`, `projectRolesLocal`): a seat made after the host's pre-check
 *   and before the projection's unit is seen, and the unit writes nothing.
 * - A load (`restoreScopeLocal`, `restoreStagedScopeLocal` with `roles`): the role repair is judged
 *   on the seats the dump has just brought and projected in the load's transaction, so a refused
 *   load leaves the scope's rows (and a staged load its stage) as they were.
 */
const MIXED = [permissionKey.parse('rsv:use'), permissionKey.parse('rsv:run')];
const member: RoleDefinition = { key: 'member', permissions: [MIXED[0]!], source: 'vertical' };
const staffer: RoleDefinition = { key: 'staffer', permissions: [MIXED[0]!], source: 'vertical' };
// This scope class reserves rsv:run, so a system-held role holding only it is a valid definition.
const stafferSystem: RoleDefinition = { key: 'staffer', permissions: [MIXED[1]!], source: 'vertical', holder: 'system' };
const SENTENCE = /role 'staffer' is refused by the reserved-key rule, judged against the roles and seats this scope holds as the write lands \(K-55\); nothing was written/;

const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);

/** Everything a refused unit must leave as it was: role rows, scope seats, and the meta it writes. */
const snapshot = (scope: ScopeId) =>
  runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) => {
    const sql = state.storage.sql;
    const has = (t: string) => sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, t).toArray().length > 0;
    return {
      roles: has('_substrat_roles') ? sql.exec('SELECT tenant_id, role_key, permissions, holder, revoked_at FROM _substrat_roles ORDER BY role_key').toArray() : [],
      seats: has('_substrat_tuples') ? sql.exec('SELECT subject, relation, object, revoked_at FROM _substrat_tuples ORDER BY subject, relation').toArray() : [],
      meta: has('_substrat_meta')
        ? sql.exec(`SELECT key, value FROM _substrat_meta WHERE key IN ('provisioned_for', 'permission_source', 'entitlements_enforced') ORDER BY key`).toArray()
        : [],
      notes: has('ru_notes') ? sql.exec('SELECT id FROM ru_notes ORDER BY id').toArray() : [],
    };
  });

describe('a CP-less projection judges its role set inside its own unit (#2531)', () => {
  let local: CloudflareScopeHost;
  beforeAll(() => {
    local = new CloudflareScopeHost({ scope: env.SCOPE }); // CP-less, as a deployed vertical's host is
  });
  afterAll(() => local.close());

  /** Runs `between` after the host's pre-check and before the projection's unit. */
  const interleave = (method: 'migrateAndRecord' | 'refuseReservedRoleSet', between: () => Promise<void>) => {
    const target = local as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = target[method]!;
    target[method] = async (...args: unknown[]) => {
      const out = await original.apply(local, args);
      await between();
      return out;
    };
    return () => {
      delete target[method];
    };
  };

  const setup = async () => {
    const scope = scopeId.parse(ulid());
    const tenant = tenantId.parse(ulid());
    const owner = principalId.parse(ulid());
    const release = (roles: RoleDefinition[]) => local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles, ownerRoleKey: 'member' });
    // Release 1: `staffer` a person's role, nobody seated in it yet.
    await release([member, staffer]);
    return { scope, tenant, owner, release };
  };

  it('provisionScopeLocal: a person seated after the pre-check is seen in the unit, which writes nothing', async () => {
    const { scope, release } = await setup();
    const who = principalId.parse(ulid());
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    const restore = interleave('migrateAndRecord', async () => {
      await local.assignScopeRole(scope, who, 'staffer');
      before = await snapshot(scope);
    });
    try {
      // The pre-check reads `staffer` unseated, so making it system-held passes it.
      const refused = await failure(release([member, stafferSystem]));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(SENTENCE);
      expect(refused?.message).toContain(`scope ${scope}: the vertical's roles cannot be defined here: role 'staffer'`);
      // No principal is named by the in-unit sentence.
      expect(refused?.message).not.toContain(who);
    } finally {
      restore();
    }
    // Nothing the unit writes was written: no role row, tombstone, receipt, seat or flip.
    expect(await snapshot(scope)).toEqual(before);
    expect((await snapshot(scope)).roles.find((r) => r.role_key === 'staffer')).toMatchObject({ holder: 'person', revoked_at: null });
  });

  it('twin: with no seat made in between, the same release is admitted and lands', async () => {
    const { scope, release } = await setup();
    const restore = interleave('migrateAndRecord', async () => {
      await local.assignScopeRole(scope, principalId.parse(ulid()), 'member'); // a seat in another role
    });
    try {
      await release([member, stafferSystem]);
    } finally {
      restore();
    }
    expect((await snapshot(scope)).roles.find((r) => r.role_key === 'staffer')).toMatchObject({ holder: 'system', revoked_at: null });
  });

  it('a first provision refused in the unit leaves no receipt, role row, owner seat or permission_source', async () => {
    const scope = scopeId.parse(ulid());
    const tenant = tenantId.parse(ulid());
    const owner = principalId.parse(ulid());
    // A seat in the key on a scope never projected (as a seat can outlive its role's row), made after
    // the pre-check. Written as the row it is: no door seats into an unprojected scope here.
    const restore = interleave('migrateAndRecord', async () => {
      await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO _substrat_tuples (subject, relation, object, expires_at, revoked_at) VALUES (?, 'role:staffer', ?, NULL, NULL)`,
          `principal:${ulid()}`,
          `scope:${scope}`,
        );
      });
    });
    let seatsBefore: unknown;
    try {
      const refused = await failure(
        local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles: [member, stafferSystem], ownerRoleKey: 'member' }),
      );
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(SENTENCE);
      seatsBefore = (await snapshot(scope)).seats;
    } finally {
      restore();
    }
    const after = await snapshot(scope);
    expect(after.roles).toEqual([]);
    expect(after.meta).toEqual([]);
    // Only the seat the interleave made; the owner's seat was not written.
    expect(after.seats).toEqual(seatsBefore);
    expect(after.seats.some((s) => s.subject === `principal:${owner}`)).toBe(false);
  });

  it('projectRolesLocal: a seat made after its pre-check is seen in the unit, which writes nothing; its twin projects', async () => {
    const { scope, tenant } = await setup();
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    const restore = interleave('refuseReservedRoleSet', async () => {
      await local.assignScopeRole(scope, principalId.parse(ulid()), 'staffer');
      before = await snapshot(scope);
    });
    try {
      const refused = await failure(local.projectRolesLocal(tenant, scope, [member, stafferSystem]));
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect(refused?.message).toMatch(SENTENCE);
    } finally {
      restore();
    }
    expect(await snapshot(scope)).toEqual(before);
    // Twin: an unseated key may change holder through the same repair.
    const other = await setup();
    await local.projectRolesLocal(other.tenant, other.scope, [member, stafferSystem]);
    expect((await snapshot(other.scope)).roles.find((r) => r.role_key === 'staffer')).toMatchObject({ holder: 'system' });
  });

  it('a host meeting a ScopeDO without the judged method is refused by the runtime, nothing written (version skew)', async () => {
    const { scope, release } = await setup();
    const before = await snapshot(scope);
    const host = local as unknown as { scopeStub(id: ScopeId): Record<string, unknown> };
    const original = host.scopeStub;
    // An older ScopeDO has no `applyJudgedProjectionReply`: workerd rejects the call with this error
    // (simulated, since reaching a missing method on a real stub also rejects inside the test harness).
    let unjudged = 0;
    host.scopeStub = (id: ScopeId) => {
      const stub = original.call(local, id);
      return new Proxy(stub, {
        get: (target, prop) => {
          if (prop === 'applyJudgedProjectionReply') {
            return () => Promise.reject(new TypeError('The RPC receiver does not implement "applyJudgedProjectionReply".'));
          }
          if (prop === 'applyProjectionReply') unjudged += 1;
          return Reflect.get(target, prop);
        },
      });
    };
    try {
      const refused = await failure(release([member, staffer]));
      expect(refused?.message).toMatch(/does not implement "applyJudgedProjectionReply"/);
    } finally {
      host.scopeStub = original;
    }
    // Refused, not projected unjudged instead.
    expect(unjudged).toBe(0);
    expect(await snapshot(scope)).toEqual(before);
  });
});

describe('a CP-less restore judges and projects its role repair in the load’s transaction (#2531)', () => {
  let local: CloudflareScopeHost;
  beforeAll(() => {
    local = new CloudflareScopeHost({ scope: env.SCOPE });
  });
  afterAll(() => local.close());

  const NOTES = { name: 'ru_notes', ddl: 'CREATE TABLE ru_notes (id TEXT PRIMARY KEY)', columns: ['id'] };

  /** A source scope holding a person's seat in `staffer`, and a destination with rows of its own and no such seat. */
  const world = async () => {
    const tenant = tenantId.parse(ulid());
    const source = scopeId.parse(ulid());
    const dest = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    for (const [scope, note] of [[source, 'from-source'], [dest, 'dest-own']] as const) {
      await local.restoreScopeLocal(scope, [{ ...NOTES, rows: [[note]] }], { sourceScopeId: scope });
      await local.provisionScopeLocal({ tenantId: tenant, scopeId: scope, owner, roles: [member, staffer], ownerRoleKey: 'member' });
    }
    await local.assignScopeRole(source, principalId.parse(ulid()) as PrincipalId, 'staffer');
    return { tenant, source, dest };
  };
  const pagesOf = async (scope: ScopeId) => {
    const pages: ScopeDumpPage[] = [];
    let cursor: string | null = null;
    do {
      const page: ScopeDumpPage = await local.exportScopePageLocal(scope, cursor, { maxBytes: 4_000 });
      pages.push(page);
      cursor = page.next;
    } while (cursor !== null);
    return pages;
  };
  const opts = (tenant: TenantId, source: ScopeId, roles: RoleDefinition[]) => ({ sourceScopeId: source, exact: true, tenantId: tenant, roles });

  it('a whole restore whose dump seats a role the vertical now defines system-held is refused; the scope keeps its rows', async () => {
    const { tenant, source, dest } = await world();
    const before = await snapshot(dest);
    const refused = await failure(local.restoreScopeLocal(dest, await local.exportScopeLocal(source), opts(tenant, source, [member, stafferSystem])));
    expect(errorCodeOf(refused)).toBe('conflict');
    expect(refused?.message).toMatch(SENTENCE);
    expect(await snapshot(dest)).toEqual(before);
    expect((await snapshot(dest)).notes).toEqual([{ id: 'dest-own' }]);
  });

  it('twin: the same restore with the role still a person’s lands with its repair in the same unit', async () => {
    const { tenant, source, dest } = await world();
    // `viewer` is in neither scope: only the repair the load ran can have written it.
    const viewer: RoleDefinition = { key: 'viewer', permissions: [MIXED[0]!], source: 'vertical' };
    const out = await local.restoreScopeLocal(dest, await local.exportScopeLocal(source), opts(tenant, source, [member, staffer, viewer]));
    expect(out.rolesProjected).toBe(true);
    const after = await snapshot(dest);
    expect(after.notes).toEqual([{ id: 'from-source' }]);
    expect(after.roles.filter((r) => r.revoked_at === null).map((r) => r.role_key)).toEqual(['member', 'staffer', 'viewer']);
  });

  it('a staged restore is judged on the seats its staged rows bring, not on what the scope held before: refused, stage kept', async () => {
    const { tenant, source, dest } = await world();
    const stageId = ulid();
    for (const [seq, page] of (await pagesOf(source)).entries()) await local.stageScopePageLocal(dest, stageId, seq, page.tables);
    const before = await snapshot(dest);
    // The destination holds no seat in `staffer`: only the staged rows do.
    expect(before.seats.some((s) => s.relation === 'role:staffer')).toBe(false);
    const refused = await failure(local.restoreStagedScopeLocal(dest, stageId, opts(tenant, source, [member, stafferSystem])));
    expect(errorCodeOf(refused)).toBe('conflict');
    expect(refused?.message).toMatch(SENTENCE);
    expect(await snapshot(dest)).toEqual(before);
    // The stage is kept: the same commit, with the role a person's, still loads from it.
    const out = await local.restoreStagedScopeLocal(dest, stageId, opts(tenant, source, [member, staffer]));
    expect(out.rolesProjected).toBe(true);
    expect((await snapshot(dest)).notes).toEqual([{ id: 'from-source' }]);
  });

  it('a restore given no roles loads as before and says nothing about a repair (an older vertical-host)', async () => {
    const { source, dest } = await world();
    const out = await local.restoreScopeLocal(dest, await local.exportScopeLocal(source), { sourceScopeId: source, exact: true });
    expect(out.rolesProjected).toBeUndefined();
  });

  it('a role repair needs the tenant it is for, refused before anything is loaded', async () => {
    const { source, dest } = await world();
    const before = await snapshot(dest);
    const refused = await failure(local.restoreScopeLocal(dest, await local.exportScopeLocal(source), { sourceScopeId: source, roles: [member] }));
    expect(errorCodeOf(refused)).toBe('validation_failed');
    expect(await snapshot(dest)).toEqual(before);
  });
});
