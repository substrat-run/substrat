import { describe, expect, it } from 'vitest';
import {
  node as nodeSchema,
  permissionKey,
  principalId,
  type CheckSubject,
  type Node,
  type PermissionKey,
  type RoleDefinition,
} from '@substrat-run/contracts';
import {
  createTupleEvaluator,
  type PermissionTupleReader,
  type PermissionTupleRow,
  type ScopeTupleReader,
} from '../src/permission-eval.js';

/**
 * The four-rule algebra, tested where it now LIVES (#969) rather than twice over in two
 * adapters. The adapter contract suites still exercise it against real storage; this suite
 * exercises it against a reader with nothing in it but rows, so a rule change that both
 * adapters would inherit fails here first.
 */

const T = '01JZ0000000000000000000001';
const S = '01JZ0000000000000000000002';
const ALICE = '01JZ00000000000000000000A1';
const ORG = '01JZ00000000000000000000B1';

const NODE: Node = nodeSchema.parse({ tenantId: T, scopeId: S });
const TENANT_NODE: Node = nodeSchema.parse({ tenantId: T, scopeId: null });

const row = (
  subject: string,
  relation: string,
  object: string,
  extra: Partial<Pick<PermissionTupleRow, 'expires_at' | 'revoked_at'>> = {},
): PermissionTupleRow => ({
  subject,
  relation,
  object,
  expires_at: extra.expires_at ?? null,
  revoked_at: extra.revoked_at ?? null,
});

interface World {
  tenant?: PermissionTupleRow[];
  scope?: PermissionTupleRow[];
  roles?: Record<string, RoleDefinition>;
  now?: string;
  /** Omit the scope store entirely — the "no open database for this scope" case. */
  noScope?: boolean;
}

const readerFor = (world: World): PermissionTupleReader => {
  const tenant = world.tenant ?? [];
  const scopeRows = world.scope ?? [];
  const scope: ScopeTupleReader = {
    tuples: (subject, prefix) =>
      scopeRows.filter((r) => r.subject === subject && r.relation.startsWith(prefix)),
    grant: (subject, relation, object) =>
      scopeRows.find(
        (r) => r.subject === subject && r.relation === relation && r.object === object,
      ),
    parents: (object) => scopeRows.filter((r) => r.subject === object && r.relation === 'parent'),
  };
  return {
    now: () => world.now ?? '2026-01-01T00:00:00.000Z',
    tenantTuples: (tenantId, subject, prefix) =>
      tenant.filter(
        (r) => tenantId === T && r.subject === subject && r.relation.startsWith(prefix),
      ),
    getRole: (_tenantId, key) => world.roles?.[key],
    scopeFor: () => (world.noScope ? undefined : scope),
  };
};

const p = (key: string): PermissionKey => permissionKey.parse(key);
const WO_READ = p('workorder:read');
const WO_WRITE = p('workorder:write');
const TODO_READ = p('todo:read');
const TODO_WRITE = p('todo:write');
const TODO_SHARE = p('todo:share');
const PROTOCOL_RECORD = p('protocol:record');

const staff = (permissions: PermissionKey[]): RoleDefinition =>
  ({ key: 'staff', permissions, source: 'vertical' }) as RoleDefinition;

const alice: CheckSubject = { kind: 'principal', id: principalId.parse(ALICE) };

describe('createTupleEvaluator', () => {
  it('rule 1 — a role assignment at the scope expands to its permissions, with the proof', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        scope: [row(`principal:${ALICE}`, 'role:staff', `scope:${S}`)],
        roles: { staff: staff([WO_READ]) },
      }),
    );
    const decision = await checker.check(alice, WO_READ, NODE);
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.proof).toEqual([
      { subject: `principal:${ALICE}`, relation: 'role:staff', object: `scope:${S}` },
      { subject: 'role:staff', relation: 'granted:workorder:read', object: `scope:${S}` },
    ]);
  });

  it('denies a permission the role does not carry, naming what was checked', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        scope: [row(`principal:${ALICE}`, 'role:staff', `scope:${S}`)],
        roles: { staff: staff([WO_READ]) },
      }),
    );
    expect(await checker.check(alice, WO_WRITE, NODE)).toEqual({
      allowed: false,
      checked: WO_WRITE,
      node: NODE,
    });
  });

  it('rule 2 — a tenant-level grant is inherited by a scope check', async () => {
    const checker = createTupleEvaluator(
      readerFor({ tenant: [row(`principal:${ALICE}`, 'granted:workorder:read', `tenant:${T}`)] }),
    );
    expect((await checker.check(alice, WO_READ, NODE)).allowed).toBe(true);
  });

  it('rule 4 — membership carries the org’s authority, and the proof leads with the edge', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        tenant: [row(`principal:${ALICE}`, 'member', `org:${ORG}`)],
        scope: [row(`org:${ORG}`, 'granted:workorder:read', `scope:${S}`)],
      }),
    );
    const decision = await checker.check(alice, WO_READ, NODE);
    expect(decision.allowed && decision.proof).toEqual([
      { subject: `principal:${ALICE}`, relation: 'member', object: `org:${ORG}` },
      { subject: `org:${ORG}`, relation: 'granted:workorder:read', object: `scope:${S}` },
    ]);
  });

  it('a connection holds no memberships — only the grants written against it', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        tenant: [row('connection:scrive', 'member', `org:${ORG}`)],
        scope: [row(`org:${ORG}`, 'granted:protocol:record', `scope:${S}`)],
      }),
    );
    const decision = await checker.check(
      { kind: 'connection', id: 'scrive' },
      PROTOCOL_RECORD,
      NODE,
    );
    expect(decision.allowed).toBe(false);
  });

  it('rule 3 — an entity-narrowed grant is found by walking declared parent edges', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        scope: [
          row('task:t1', 'parent', 'list:l1'),
          row(`principal:${ALICE}`, 'granted:todo:read', 'list:l1'),
        ],
      }),
    );
    const decision = await checker.check(alice, TODO_READ, NODE, {
      entityType: 'task',
      entityId: 't1',
    });
    expect(decision.allowed && decision.proof).toEqual([
      { subject: 'task:t1', relation: 'parent', object: 'list:l1' },
      { subject: `principal:${ALICE}`, relation: 'granted:todo:read', object: 'list:l1' },
    ]);
  });

  it('the entity walk stops at depth 4', async () => {
    const chain = [1, 2, 3, 4, 5, 6].map((i) => row(`n:${i}`, 'parent', `n:${i + 1}`));
    const reachable = createTupleEvaluator(
      readerFor({ scope: [...chain, row(`principal:${ALICE}`, 'granted:todo:read', 'n:5')] }),
    );
    const tooFar = createTupleEvaluator(
      readerFor({ scope: [...chain, row(`principal:${ALICE}`, 'granted:todo:read', 'n:7')] }),
    );
    const entity = { entityType: 'n', entityId: '1' };
    expect((await reachable.check(alice, TODO_READ, NODE, entity)).allowed).toBe(true);
    expect((await tooFar.check(alice, TODO_READ, NODE, entity)).allowed).toBe(false);
  });

  it('a revoked parent edge stops the walk (K-21 tombstones reach entity edges too)', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        scope: [
          row('task:t1', 'parent', 'list:l1', { revoked_at: '2025-12-01T00:00:00.000Z' }),
          row(`principal:${ALICE}`, 'granted:todo:read', 'list:l1'),
        ],
      }),
    );
    expect(
      (await checker.check(alice, TODO_READ, NODE, { entityType: 'task', entityId: 't1' }))
        .allowed,
    ).toBe(false);
  });

  it('no scope store means no scope tuples and no entity walk', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        noScope: true,
        scope: [
          row(`principal:${ALICE}`, 'granted:todo:read', `scope:${S}`),
          row(`principal:${ALICE}`, 'granted:todo:read', 'list:l1'),
        ],
      }),
    );
    expect((await checker.check(alice, TODO_READ, NODE)).allowed).toBe(false);
    expect(
      (await checker.check(alice, TODO_READ, NODE, { entityType: 'list', entityId: 'l1' }))
        .allowed,
    ).toBe(false);
  });

  it('expiry is judged against the reader’s clock, not the wall clock (#956)', async () => {
    const world = (now: string): PermissionTupleReader =>
      readerFor({
        now,
        scope: [
          row(`principal:${ALICE}`, 'granted:todo:read', `scope:${S}`, {
            expires_at: '2026-01-02T00:00:00.000Z',
          }),
        ],
      });
    expect(
      (await createTupleEvaluator(world('2026-01-01T00:00:00.000Z')).check(alice, TODO_READ, NODE))
        .allowed,
    ).toBe(true);
    expect(
      (await createTupleEvaluator(world('2026-01-03T00:00:00.000Z')).check(alice, TODO_READ, NODE))
        .allowed,
    ).toBe(false);
  });

  it('covers resolves the effective set once and names what is missing, in request order', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        tenant: [row(`principal:${ALICE}`, 'granted:todo:share', `tenant:${T}`)],
        scope: [row(`principal:${ALICE}`, 'role:staff', `scope:${S}`)],
        roles: { staff: staff([TODO_READ]) },
      }),
    );
    expect(await checker.covers(alice, [TODO_READ, TODO_SHARE], NODE)).toEqual({
      covered: true,
      missing: [],
    });
    expect(await checker.covers(alice, [TODO_WRITE, TODO_READ, TODO_WRITE], NODE)).toEqual({
      covered: false,
      missing: [TODO_WRITE],
    });
    expect(await checker.covers(alice, [], TENANT_NODE)).toEqual({ covered: true, missing: [] });
  });

  it('covers is narrowing-aware — an entity grant never satisfies the assignment bound', async () => {
    const checker = createTupleEvaluator(
      readerFor({ scope: [row(`principal:${ALICE}`, 'granted:todo:read', 'list:l1')] }),
    );
    expect(await checker.covers(alice, [TODO_READ], NODE)).toEqual({
      covered: false,
      missing: [TODO_READ],
    });
  });
});
