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
  ancestorsWithin,
  createTupleEvaluator,
  joinedMembershipExpiry,
  liveOrgMembership,
  reachesWithin,
  tenantCoverage,
  type PermissionTupleReader,
  type TenantDirectoryReader,
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
    // `SYSTEM_SWITCH_OFF_PREDICATE`, over rows: a live `switch:off` tuple naming the subject.
    switchedOff: (subject) =>
      scopeRows.some((r) => r.subject === subject && r.relation === 'switch:off' && r.revoked_at === null),
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

  it('reads each role definition once per decision, however many subjects hold it', async () => {
    // On the DO adapter every one of these is an RPC to the control plane, so a subject in
    // three orgs that all hold `staff` used to cost three round-trips for one answer.
    const reader = readerFor({
      tenant: [
        row(`principal:${ALICE}`, 'member', 'org:a'),
        row(`principal:${ALICE}`, 'member', 'org:b'),
      ],
      scope: [
        row(`principal:${ALICE}`, 'role:staff', `scope:${S}`),
        row('org:a', 'role:staff', `scope:${S}`),
        row('org:b', 'role:staff', `scope:${S}`),
      ],
      roles: { staff: staff([TODO_READ]) },
    });
    let reads = 0;
    const counting: PermissionTupleReader = {
      ...reader,
      getRole: (tenantId, key) => {
        reads += 1;
        return reader.getRole(tenantId, key);
      },
    };
    expect(
      await createTupleEvaluator(counting).covers(alice, [TODO_WRITE], NODE),
    ).toMatchObject({ covered: false });
    expect(reads).toBe(1);
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

/**
 * #1856: the walk parses every tuple it puts in a proof, and it used to refuse an
 * upper-case letter in the namespace half, which is how every camelCase entity type is
 * spelled. `ctx.link` wrote the edge; `check()` threw on it. These run on the shared
 * evaluator, so both adapters inherit them; the contract suite repeats the headline pair
 * against real storage.
 */
describe('a camelCase entity type (#1856)', () => {
  const CONV_READ = p('conversation:read');
  const TURN = { entityType: 'aiTurn', entityId: 't1' };

  it('a grant on the parent reaches a camelCase child through the walk, with the edge in the proof', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        scope: [
          row('aiTurn:t1', 'parent', 'conversation:c1'),
          row(`principal:${ALICE}`, 'granted:conversation:read', 'conversation:c1'),
        ],
      }),
    );
    const decision = await checker.check(alice, CONV_READ, NODE, TURN);
    expect(decision.allowed && decision.proof).toEqual([
      { subject: 'aiTurn:t1', relation: 'parent', object: 'conversation:c1' },
      { subject: `principal:${ALICE}`, relation: 'granted:conversation:read', object: 'conversation:c1' },
    ]);
  });

  it('...and without the grant, the same walk DENIES rather than throwing', async () => {
    const checker = createTupleEvaluator(
      readerFor({ scope: [row('aiTurn:t1', 'parent', 'conversation:c1')] }),
    );
    await expect(checker.check(alice, CONV_READ, NODE, TURN)).resolves.toMatchObject({
      allowed: false,
      checked: CONV_READ,
    });
  });

  it('a camelCase parent, and a grant directly on a camelCase entity, both answer', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        scope: [
          row('aiTurn:t1', 'parent', 'widgetSession:w1'),
          row(`principal:${ALICE}`, 'granted:conversation:read', 'widgetSession:w1'),
          row(`principal:${ALICE}`, 'granted:conversation:read', 'kbArticle:k1'),
        ],
      }),
    );
    expect((await checker.check(alice, CONV_READ, NODE, TURN)).allowed).toBe(true);
    expect(
      (await checker.check(alice, CONV_READ, NODE, { entityType: 'kbArticle', entityId: 'k1' })).allowed,
    ).toBe(true);
  });

  /**
   * Stored data: every edge the walk could read before still reads the same. These are
   * the namespace spellings the old pattern accepted that a stricter "letter first"
   * grammar would have refused, which is why the widening is the old set plus A–Z and
   * nothing else.
   */
  it.each(['9item', '_item', '-item', 'kb_source', 'v2-item'])(
    'a stored edge through a %s entity still walks as it did',
    async (type) => {
      const checker = createTupleEvaluator(
        readerFor({
          scope: [
            row(`${type}:x1`, 'parent', 'list:l1'),
            row(`principal:${ALICE}`, 'granted:todo:read', 'list:l1'),
          ],
        }),
      );
      const decision = await checker.check(alice, TODO_READ, NODE, { entityType: type, entityId: 'x1' });
      expect(decision.allowed && decision.proof).toEqual([
        { subject: `${type}:x1`, relation: 'parent', object: 'list:l1' },
        { subject: `principal:${ALICE}`, relation: 'granted:todo:read', object: 'list:l1' },
      ]);
    },
  );
});

describe('a switched-off subject (#1823)', () => {
  const MOD = '@test/sched';
  const sched: CheckSubject = { kind: 'system', id: MOD } as CheckSubject;
  const peer: CheckSubject = { kind: 'vertical', id: 'acme/board-room', scope: S } as CheckSubject;
  const TICK = p('sched:tick');
  const tenantGrant = (subject: string) => row(subject, 'granted:sched:tick', `tenant:${T}`);
  const marker = (subject: string, revoked_at: string | null = null) =>
    row(subject, 'switch:off', `scope:${S}`, { revoked_at });

  it('a live OFF marker denies a TENANT-level grant on that scope, for check and covers alike', async () => {
    const checker = createTupleEvaluator(
      readerFor({ tenant: [tenantGrant(`system:${MOD}`)], scope: [marker(`system:${MOD}`)] }),
    );
    expect(await checker.check(sched, TICK, NODE)).toEqual({ allowed: false, checked: TICK, node: NODE });
    expect(await checker.covers(sched, [TICK], NODE)).toEqual({ covered: false, missing: [TICK] });
  });

  it('twin: the same tenant grant allows once the marker is tombstoned (restored)', async () => {
    const checker = createTupleEvaluator(
      readerFor({ tenant: [tenantGrant(`system:${MOD}`)], scope: [marker(`system:${MOD}`, '2026-01-01T00:00:00.000Z')] }),
    );
    expect((await checker.check(sched, TICK, NODE)).allowed).toBe(true);
    expect(await checker.covers(sched, [TICK], NODE)).toEqual({ covered: true, missing: [] });
  });

  it('denies a live SCOPE-level grant beside the marker too — the marker wins whatever is live', async () => {
    const checker = createTupleEvaluator(
      readerFor({ scope: [row(`system:${MOD}`, 'granted:sched:tick', `scope:${S}`), marker(`system:${MOD}`)] }),
    );
    expect((await checker.check(sched, TICK, NODE)).allowed).toBe(false);
  });

  it('a peer vertical is switched the same way (#1706)', async () => {
    const ref = 'vertical:acme/board-room';
    const off = createTupleEvaluator(readerFor({ tenant: [tenantGrant(ref)], scope: [marker(ref)] }));
    expect((await off.check(peer, TICK, NODE)).allowed).toBe(false);
    const on = createTupleEvaluator(readerFor({ tenant: [tenantGrant(ref)] }));
    expect((await on.check(peer, TICK, NODE)).allowed).toBe(true);
  });

  it('the marker names one subject: another module, and a principal, are untouched', async () => {
    const other: CheckSubject = { kind: 'system', id: '@test/jobs' } as CheckSubject;
    const checker = createTupleEvaluator(
      readerFor({
        tenant: [tenantGrant('system:@test/jobs'), row(`principal:${ALICE}`, 'granted:sched:tick', `tenant:${T}`)],
        scope: [marker(`system:${MOD}`), marker(`principal:${ALICE}`)],
      }),
    );
    expect((await checker.check(other, TICK, NODE)).allowed).toBe(true);
    // A principal is never a switched kind, so even a marker-shaped row naming one is ignored.
    expect((await checker.check(alice, TICK, NODE)).allowed).toBe(true);
  });

  it('a TENANT node has no scope to switch: the tenant grant still allows there', async () => {
    const checker = createTupleEvaluator(
      readerFor({ tenant: [tenantGrant(`system:${MOD}`)], scope: [marker(`system:${MOD}`)] }),
    );
    expect((await checker.check(sched, TICK, TENANT_NODE)).allowed).toBe(true);
  });

  it('fails CLOSED for a switched kind on a scope whose store is unreachable; a principal does not', async () => {
    const checker = createTupleEvaluator(
      readerFor({
        tenant: [tenantGrant(`system:${MOD}`), row(`principal:${ALICE}`, 'granted:sched:tick', `tenant:${T}`)],
        noScope: true,
      }),
    );
    expect((await checker.check(sched, TICK, NODE)).allowed).toBe(false);
    expect((await checker.check(alice, TICK, NODE)).allowed).toBe(true);
  });
});

describe('tenantCoverage (#1184) — `covers` at the tenant node, without yielding', () => {
  /** The same rows as `readerFor`, with every answer in hand, as a directory unit reads them. */
  const directoryFor = (world: World): TenantDirectoryReader => {
    const reader = readerFor(world);
    return {
      now: reader.now,
      tenantTuples: (tenantId, subject, prefix) => reader.tenantTuples(tenantId, subject, prefix) as PermissionTupleRow[],
      getRole: (tenantId, key) => reader.getRole(tenantId, key) as RoleDefinition | undefined,
    };
  };
  const ROLES = { staff: staff([WO_READ, TODO_READ]), lead: { key: 'lead', permissions: [WO_WRITE], source: 'vertical' } as RoleDefinition };
  const me = `principal:${ALICE}`;
  const past = '2025-01-01T00:00:00.000Z';

  /** Every place the two could part: the subject set, liveness, the node, relation shapes. */
  const worlds: Record<string, World> = {
    'nothing held': {},
    'a tenant role': { tenant: [row(me, 'role:staff', `tenant:${T}`)] },
    'a direct tenant grant': { tenant: [row(me, 'granted:todo:write', `tenant:${T}`)] },
    'a role and a grant together': { tenant: [row(me, 'role:lead', `tenant:${T}`), row(me, 'granted:todo:share', `tenant:${T}`)] },
    'a revoked role': { tenant: [row(me, 'role:staff', `tenant:${T}`, { revoked_at: past })] },
    'an expired grant': { tenant: [row(me, 'granted:todo:write', `tenant:${T}`, { expires_at: past })] },
    'an unexpired grant': { tenant: [row(me, 'granted:todo:write', `tenant:${T}`, { expires_at: '2027-01-01T00:00:00.000Z' })] },
    'a role the tenant does not define': { tenant: [row(me, 'role:ghost', `tenant:${T}`)] },
    'an org membership carrying a role': {
      tenant: [row(me, 'member', `org:${ORG}`), row(`org:${ORG}`, 'role:lead', `tenant:${T}`)],
    },
    'an org membership carrying a grant': {
      tenant: [row(me, 'member', `org:${ORG}`), row(`org:${ORG}`, 'granted:protocol:record', `tenant:${T}`)],
    },
    'a revoked org membership': {
      tenant: [row(me, 'member', `org:${ORG}`, { revoked_at: past }), row(`org:${ORG}`, 'role:lead', `tenant:${T}`)],
    },
    'a revoked grant held by a live org': {
      tenant: [row(me, 'member', `org:${ORG}`), row(`org:${ORG}`, 'granted:protocol:record', `tenant:${T}`, { revoked_at: past })],
    },
    'a grant at another tenant\'s node': { tenant: [row(me, 'granted:todo:write', 'tenant:01JZ0000000000000000000009')] },
    'a scope-level role, which no tenant bound counts': { scope: [row(me, 'role:lead', `scope:${S}`)] },
    'an entity-narrowed tenant row': { tenant: [row(me, 'granted:todo:write', 'todo:list-1')] },
  };
  const asks: PermissionKey[][] = [[], [WO_READ], [WO_WRITE], [WO_READ, TODO_READ], [TODO_WRITE, TODO_SHARE], [PROTOCOL_RECORD], [WO_WRITE, WO_READ, WO_WRITE]];

  for (const [name, world] of Object.entries(worlds)) {
    it(`agrees with covers: ${name}`, async () => {
      const w = { ...world, roles: ROLES };
      const checker = createTupleEvaluator(readerFor(w));
      for (const required of asks) {
        const expected = await checker.covers(alice, required, TENANT_NODE);
        expect(tenantCoverage(directoryFor(w), T, ALICE, required), `${name}: ${required.join(',')}`).toEqual(expected);
      }
    });
  }

  it('the worlds above cover both answers — a pin that only ever saw "covered" would prove nothing', () => {
    const answers = new Set<boolean>();
    for (const world of Object.values(worlds)) {
      for (const required of asks) answers.add(tenantCoverage(directoryFor({ ...world, roles: ROLES }), T, ALICE, required).covered);
    }
    expect([...answers].sort()).toEqual([false, true]);
  });
});

describe('the org bound (#2047) — a live membership, and the expiry a join inherits', () => {
  const directory = (tenant: PermissionTupleRow[]): TenantDirectoryReader => {
    const reader = readerFor({ tenant });
    return {
      now: reader.now,
      tenantTuples: (tenantId, subject, prefix) => reader.tenantTuples(tenantId, subject, prefix) as PermissionTupleRow[],
      getRole: () => undefined,
    };
  };
  const me = `principal:${ALICE}`;
  const past = '2025-01-01T00:00:00.000Z';
  const later = '2027-01-01T00:00:00.000Z';

  it('is a member only through a live membership of that very org', () => {
    expect(liveOrgMembership(directory([row(me, 'member', `org:${ORG}`)]), T, ALICE, ORG)).toBeDefined();
    expect(liveOrgMembership(directory([row(me, 'member', `org:${ORG}`, { expires_at: later })]), T, ALICE, ORG)).toBeDefined();
    expect(liveOrgMembership(directory([row(me, 'member', `org:${ORG}`, { revoked_at: past })]), T, ALICE, ORG)).toBeUndefined();
    expect(liveOrgMembership(directory([row(me, 'member', `org:${ORG}`, { expires_at: past })]), T, ALICE, ORG)).toBeUndefined();
    expect(liveOrgMembership(directory([row(me, 'member', 'org:01JZ00000000000000000000B2')]), T, ALICE, ORG)).toBeUndefined();
    // Holding what the org holds is not membership of it.
    expect(liveOrgMembership(directory([row(me, 'granted:todo:write', `tenant:${T}`), row(`org:${ORG}`, 'granted:todo:write', `tenant:${T}`)]), T, ALICE, ORG)).toBeUndefined();
  });

  it('a join expires no later than the inviter, and never earlier than what the joiner already holds', () => {
    const at = (expires_at: string | null) => ({ expires_at });
    expect(joinedMembershipExpiry(at(null), undefined)).toBeNull();
    expect(joinedMembershipExpiry(at(later), undefined)).toBe(later);
    expect(joinedMembershipExpiry(at(later), at(null))).toBeNull();
    expect(joinedMembershipExpiry(at(null), at(later))).toBeNull();
    expect(joinedMembershipExpiry(at(later), at('2026-06-01T00:00:00.000Z'))).toBe(later);
    expect(joinedMembershipExpiry(at('2026-06-01T00:00:00.000Z'), at(later))).toBe(later);
  });
});

/**
 * #1853: the walk reads each distinct node once, however many paths lead to it. A ticket0
 * public message sits under its conversation AND under every widget session on it, and each
 * session sits under the same conversation — so without the dedupe, the conversation (and
 * everything above it) was expanded once per session: 2,001 reads for one message under
 * 1,000 sessions. A live fan-out pays this per committed row.
 */
describe('the entity walk reads each distinct node once (#1853)', () => {
  const NOW = '2026-01-01T00:00:00.000Z';
  function messageUnder(sessions: number) {
    const rows = [row('message:m', 'parent', 'conversation:c'), row('conversation:c', 'parent', 'contact:k')];
    for (let i = 0; i < sessions; i++) {
      rows.push(row('message:m', 'parent', `widgetSession:s${i}`), row(`widgetSession:s${i}`, 'parent', 'conversation:c'));
    }
    let reads = 0;
    const scope = {
      parents: (object: string) => {
        reads += 1;
        return rows.filter((r) => r.subject === object);
      },
    };
    return { rows, scope, reads: () => reads };
  }
  const m = { entityType: 'message', entityId: 'm' };

  it('one read per distinct node, with one session and with a thousand', async () => {
    for (const sessions of [1, 1000]) {
      const world = messageUnder(sessions);
      const up = await ancestorsWithin(world.scope, m, NOW);
      // The message, its conversation, the contact above it, and each session.
      expect(up.size).toBe(sessions + 3);
      // Linear in distinct nodes: no node is read twice, the conversation included.
      expect(world.reads()).toBe(up.size);
    }
  });

  it('answers what it answered before: every root a path reaches, and nothing else', async () => {
    const world = messageUnder(1000);
    const up = await ancestorsWithin(world.scope, m, NOW);
    expect(up.has('widgetSession:s999')).toBe(true);
    expect(up.has('contact:k')).toBe(true);
    expect(up.has('widgetSession:s1000')).toBe(false);
    expect(await reachesWithin(world.scope, m, { entityType: 'contact', entityId: 'k' }, NOW)).toBe(true);
    // And a grant on the shared ancestor still decides a check through any of the paths.
    const checker = createTupleEvaluator(
      readerFor({ scope: [...world.rows, row(`principal:${ALICE}`, 'granted:todo:read', 'contact:k')] }),
    );
    expect((await checker.check(alice, TODO_READ, NODE, m)).allowed).toBe(true);
  });
});
