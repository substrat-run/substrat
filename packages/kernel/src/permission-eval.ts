import {
  objectRef,
  subjectRef,
  type Coverage,
  type Decision,
  type EntityRef,
  type Node,
  type PermissionKey,
  type CheckSubject,
  type RelationTuple,
  type RoleDefinition,
} from '@substrat-run/contracts';
import type { PermissionChecker } from './permission-checker.js';
import { capabilityGrantOf, capabilityLive, type CapabilityRow } from './capability.js';
import { isSwitchableSubjectKind } from './system-switch.js';
import { walkGrantedEntities, type GrantWalkRow } from './grant-scoped-read.js';

/**
 * The built-in constrained relationship-tuple evaluator (design doc §4.2, plan D-23),
 * as ONE implementation both adapters call.
 *
 * kernel-design.md §8 says permission evaluation is "the same code (it's pure)". It was
 * the same code *twice* — `adapter-sqlite/src/checker.ts` and
 * `adapter-cloudflare/src/checker.ts` carried the identical four-rule algebra and differed
 * only in how tuples were fetched, so the permission contract suite was testing two
 * evaluators that had to be kept in step by hand (#969).
 *
 * The algebra is fixed — role expansion, tenancy-tree inheritance, declared entity parent
 * edges (depth ≤ 4), membership — with no negation and no configurable rewrites. Every
 * allow carries its tuple proof.
 *
 * What an adapter still owns is the READ: where tuples live and how they are reached. A
 * `PermissionTupleReader` is the whole seam — the pure adapter answers synchronously off
 * better-sqlite3, the Durable-Object adapter answers scope reads synchronously off its own
 * SQL and tenant reads over RPC. Every reader method may return a value or a promise, so
 * neither shape pays for the other.
 */

const ENTITY_WALK_DEPTH = 4;

type MaybePromise<T> = T | Promise<T>;

/**
 * One tuple row as the spine stores it — snake_case, because that is what both adapters
 * `SELECT`. `expires_at`/`revoked_at` are what `live()` judges; a revoked row is still
 * here and still readable as evidence (K-21), it just stops granting.
 */
export interface PermissionTupleRow {
  subject: string;
  relation: string;
  object: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * The scope-local half of the read: scope-level assignments/grants, entity-narrowed grants,
 * and the declared `parent` edges the entity walk follows. Entity tuples are scope-local by
 * construction, so all three live together.
 */
export interface ScopeTupleReader {
  /** Keyset grant root and reverse parent edge reads for grant-scoped enumeration. */
  nextGrant?(subject: string, relation: string, after: string): GrantWalkRow | undefined;
  nextChild?(parent: string, after: string): GrantWalkRow | undefined;
  /**
   * Scope-level tuples for `subject` whose relation starts with `relationPrefix`. A
   * pre-filter only: the adapters answer it with SQL `LIKE`, which ignores ASCII case and
   * reads `_` as a wildcard, so the evaluator re-judges every row's relation exactly (#1869).
   */
  tuples(subject: string, relationPrefix: string): MaybePromise<PermissionTupleRow[]>;
  /** The one grant tuple (subject, relation, object), if it exists. */
  grant(
    subject: string,
    relation: string,
    object: string,
  ): MaybePromise<PermissionTupleRow | undefined>;
  /** The declared `parent` edges out of `object`. */
  parents(object: string): MaybePromise<PermissionTupleRow[]>;
  /**
   * The capability row a `{ kind: 'capability' }` subject names (#1672), read with
   * `capabilityByIdQuery` — capabilities live in the scope's own spine beside the entities
   * they reach. Optional so a reader written before capabilities still compiles; ABSENT
   * means every capability check DENIES, never that one is waved through.
   */
  capability?(id: string): MaybePromise<CapabilityRow | undefined>;
  /**
   * Is a kill switch holding `subject` (`system:<module>`, `vertical:<slug>`) off on this
   * scope (#1666, #1706)? While it answers true the evaluator denies that subject here
   * whatever grants it holds, scope- or tenant-level (#1823). Both adapters answer it today
   * from the scope's own OFF marker, with `SYSTEM_SWITCH_OFF_QUERY` — the spelling the
   * schedule gate and the grant refusal share. Required, so no reader can leave it out and
   * fail open.
   */
  switchedOff(subject: string): MaybePromise<boolean>;
}

/**
 * Everything the evaluator needs to know, and nothing about where it comes from.
 *
 * `scopeFor` takes the whole `Node` rather than a scope id so an adapter decides for itself
 * when a scope store is reachable: the pure adapter resolves `node.scopeId` against its open
 * databases and answers `undefined` when there is none, while a ScopeDO simply *is* one
 * scope and always answers itself.
 */
export interface PermissionTupleReader {
  /** What "now" means when a tuple's `expires_at` is judged (#956). */
  now(): string;
  /** Tenant-level tuples for `subject` whose relation starts with `relationPrefix`. */
  tenantTuples(
    tenantId: string,
    subject: string,
    relationPrefix: string,
  ): MaybePromise<PermissionTupleRow[]>;
  /** A role definition, or `undefined` — which is a deny, so an absent projection fails closed. */
  getRole(tenantId: string, key: string): MaybePromise<RoleDefinition | undefined>;
  /** The scope store this node's check reads, if there is one. */
  scopeFor(node: Node): ScopeTupleReader | undefined;
}

const t = (subject: string, relation: string, object: string): RelationTuple => ({
  subject: objectRef.parse(subject),
  relation,
  object: objectRef.parse(object),
});

/**
 * A tuple grants only while it is unexpired AND unrevoked. Same predicate at every site
 * that consults a row, so there is one definition of "live" rather than two.
 */
const live = (row: PermissionTupleRow, now: string): boolean =>
  (row.expires_at === null || row.expires_at > now) && row.revoked_at === null;

/**
 * `live`, as a SQL predicate — for a query that must agree with the walk about which edges
 * exist (`ctx.relink`, #1864). Binds ONE parameter: the same `now`.
 */
export const liveTupleSql = (alias?: string): string => {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  return `${col('revoked_at')} IS NULL AND (${col('expires_at')} IS NULL OR ${col('expires_at')} > ?)`;
};

/**
 * Inheritance (rule 2): a scope check also consults tenant-level tuples. Scope first, so a
 * scope-level allow proves itself without a tenant read.
 */
const nodeObjectsOf = (node: Node): { obj: string; scoped: boolean }[] =>
  node.scopeId
    ? [
        { obj: `scope:${node.scopeId}`, scoped: true },
        { obj: `tenant:${node.tenantId}`, scoped: false },
      ]
    : [{ obj: `tenant:${node.tenantId}`, scoped: false }];

/**
 * "Is this subject switched off on this scope?" — asked before any tuple is read, by `check`
 * and `covers` alike, so a switched-off subject is denied on the scope whatever it holds
 * (#1823). OFF tombstones the subject's SCOPE-level grants, but a TENANT-level grant lives in
 * the directory (and, on the Durable-Object adapter, in every scope's projection of it), and
 * OFF touches neither: without this, a tenant grant made before the switch was pulled kept the
 * module's authority alive on a scope its operator had switched off. Asking the scope, rather
 * than tombstoning the tenant tuple, is what confines the denial to the ONE scope (the algebra
 * has no per-scope negative tuple), and what makes it survive a re-projection: no projection
 * writes the switch's state.
 *
 * The answer is the reader's `switchedOff` — one seam, so where the switch's state is read
 * from is the adapter's decision and the rule is the evaluator's. Fails CLOSED when a scope
 * node has no reachable store: the switch cannot be read, so no grant can be vouched for.
 */
async function switchedOff(subject: CheckSubject, node: Node, scope: ScopeTupleReader | undefined): Promise<boolean> {
  if (!isSwitchableSubjectKind(subject.kind) || !node.scopeId) return false;
  return scope ? await scope.switchedOff(subjectRef(subject)) : true;
}

/**
 * Rule 3's walk, as ONE function: from `start`, look for a hit at each frontier object, then
 * expand one level of declared `parent` edges, to `ENTITY_WALK_DEPTH`. `probe` decides what a
 * hit is — a live entity-narrowed grant for a principal, the capability's own root for a
 * capability subject — so both subjects travel exactly the same edges, to exactly the same
 * depth, skipping exactly the same revoked edges. A capability that reached further than an
 * entity grant (or less far) would be a second algebra.
 */
async function walkParents<R>(
  scope: Pick<ScopeTupleReader, 'parents'>,
  start: string,
  now: string,
  probe: (ref: string, chain: RelationTuple[]) => Promise<R | undefined>,
): Promise<R | undefined> {
  type Frontier = { ref: string; chain: RelationTuple[] };
  let frontier: Frontier[] = [{ ref: start, chain: [] }];
  // Each node is probed and expanded once, at the first (shallowest) depth it is reached,
  // so the walk costs one `parents` read per distinct node — not one per PATH to it. A
  // multi-parent row whose parents share an ancestor (a ticket0 message under N widget
  // sessions, each under one conversation) would otherwise expand that ancestor N times
  // (#1853). Shallowest-first keeps the answer: a later sighting is never closer to a hit
  // and never reaches further within the depth bound.
  const visited = new Set<string>([start]);
  for (let depth = 0; depth <= ENTITY_WALK_DEPTH && frontier.length > 0; depth++) {
    for (const candidate of frontier) {
      const hit = await probe(candidate.ref, candidate.chain);
      if (hit !== undefined) return hit;
    }
    // Nothing consults the frontier past the last depth, so expanding it there is a
    // read per candidate for an answer no one asks for.
    if (depth === ENTITY_WALK_DEPTH) break;
    const next: Frontier[] = [];
    for (const candidate of frontier) {
      for (const p of await scope.parents(candidate.ref)) {
        // A revoked parent edge stops expanding. Without this the tombstone would work
        // for grants and membership but silently NOT for entity edges — which is the
        // case open question 15 is actually about (a facility moving management
        // company must stop being reachable).
        if (!live(p, now) || visited.has(p.object)) continue;
        visited.add(p.object);
        next.push({
          ref: p.object,
          chain: [...candidate.chain, t(p.subject, 'parent', p.object)],
        });
      }
    }
    frontier = next;
  }
  return undefined;
}

/**
 * Is `entity` the `root`, or does it lie beneath it along live declared `parent` edges?
 *
 * The walk a capability check makes to its own root (`checkCapability` above), with no
 * subject and no grant: a live read narrowed `within` an entity (#1853) asks exactly this
 * of every frame, so it travels the same edges to the same depth, skipping the same
 * revoked ones. A row linked to two parents (`ctx.link` twice) reaches either root; a row
 * `ctx.relink`ed away from one reaches only the other (#1864).
 */
export async function reachesWithin(
  scope: Pick<ScopeTupleReader, 'parents'>,
  entity: EntityRef,
  root: EntityRef,
  now: string,
): Promise<boolean> {
  const target = `${root.entityType}:${root.entityId}`;
  const hit = await walkParents(scope, `${entity.entityType}:${entity.entityId}`, now, async (ref) =>
    ref === target ? true : undefined,
  );
  return hit === true;
}

/**
 * Every root `reachesWithin` would answer `true` for, as `entityType:entityId` refs — the
 * entity itself included. The same walk, run to its full depth once, for a caller asking
 * about many roots: a live fan-out with one socket per widget session (#1853).
 */
export async function ancestorsWithin(
  scope: Pick<ScopeTupleReader, 'parents'>,
  entity: EntityRef,
  now: string,
): Promise<Set<string>> {
  const seen = new Set<string>();
  await walkParents(scope, `${entity.entityType}:${entity.entityId}`, now, async (ref) => {
    seen.add(ref);
    return undefined;
  });
  return seen;
}

/**
 * Build the evaluator over one adapter's reader. Stateless per call: everything it knows it
 * reads at check time, which is what makes check-after-write consistent (the "no zookies"
 * property) and what lets `reader.now()` decide expiry rather than the wall clock.
 */
export function createTupleEvaluator(reader: PermissionTupleReader): PermissionChecker {
  /**
   * `reader.getRole`, memoized for the length of ONE decision. A subject in three orgs that
   * all hold `role:staff` asked for the definition three times, and on the DO adapter every
   * one of those is an RPC to the control plane. The cache is per invocation and never
   * outlives it, so a decision still reads whatever the roles are when it starts — which is
   * also what makes it consistent: one decision cannot see a role change halfway through.
   */
  const roleReaderFor = (tenantId: string) => {
    const seen = new Map<string, Promise<RoleDefinition | undefined>>();
    return (key: string): Promise<RoleDefinition | undefined> => {
      const hit = seen.get(key);
      if (hit) return hit;
      const pending = Promise.resolve(reader.getRole(tenantId, key));
      seen.set(key, pending);
      return pending;
    };
  };

  /**
   * The subject set a check reasons over: the caller, plus every org it is a live member of
   * (rule 4). Shared by `check` and `covers` so the two cannot disagree about who someone
   * is — a divergence here would let the bound be computed over a smaller subject set than
   * the check that later allows the action.
   *
   * A CONNECTION has no memberships and never will (#97): its authority is exactly the
   * grants written against `connection:<id>`.
   */
  const subjectsOf = async (
    subject: CheckSubject,
    node: Node,
    now: string,
  ): Promise<{ ref: string; via?: RelationTuple }[]> => {
    const selfRef = subjectRef(subject);
    const out: { ref: string; via?: RelationTuple }[] = [{ ref: selfRef }];
    if (subject.kind === 'principal') {
      for (const m of await reader.tenantTuples(node.tenantId, selfRef, 'member')) {
        if (m.relation === 'member' && live(m, now)) {
          out.push({ ref: m.object, via: t(m.subject, m.relation, m.object) });
        }
      }
    }
    return out;
  };

  /**
   * A CAPABILITY subject (#1672). Resolved against the capability's own directory row —
   * never against tuples, so no `capability:` tuple anywhere could widen it — in four steps,
   * each of which denies on its own:
   *
   * 1. **Usable.** The row exists, can act (`mode: 'act'`), and is neither revoked nor
   *    expired — `capabilityLive`, the predicate the session door and the exchange share.
   * 2. **The key.** `permission` is one the capability carries.
   * 3. **The subtree.** An entity is named, and it is the capability's root or lies beneath
   *    it along declared parent edges — `walkParents`, the walk entity grants take. A
   *    capability holds NO node-level authority: a check without an entity denies.
   * 4. **The minter, now.** The principal who minted it must hold `permission` on this
   *    entity at this moment, by the ordinary check. This is what makes "a capability never
   *    grants more than its minter holds" true on every use rather than only at mint time:
   *    revoke the minter's access and their links stop granting it.
   *
   * The proof is the minter's own chain, a `minted-by` link, the parent chain, and last the
   * capability's grant on its root — last so K-34's `grantRefFromProof` names the root.
   */
  async function checkCapability(
    id: string,
    permission: PermissionKey,
    node: Node,
    entity: EntityRef | undefined,
  ): Promise<Decision> {
    const deny: Decision = { allowed: false, checked: permission, node };
    if (!entity || !node.scopeId) return deny;
    const scope = reader.scopeFor(node);
    if (!scope?.capability) return deny;
    const now = reader.now();
    const row = await scope.capability(id);
    if (!row || !capabilityLive(row, now)) return deny;
    const grant = capabilityGrantOf(row);
    if (!grant || !grant.mintedBy || !grant.permissions.includes(permission)) return deny;
    const root = `${grant.entity.entityType}:${grant.entity.entityId}`;
    const self = `capability:${id}`;
    const chain = await walkParents(
      scope,
      `${entity.entityType}:${entity.entityId}`,
      now,
      async (ref, walked) =>
        ref === root ? [...walked, t(self, `granted:${permission}`, root)] : undefined,
    );
    if (!chain) return deny;
    const minter = await check(
      { kind: 'principal', id: grant.mintedBy },
      permission,
      node,
      entity,
    );
    if (!minter.allowed) return deny;
    return {
      allowed: true,
      proof: [...minter.proof, t(self, 'minted-by', `principal:${grant.mintedBy}`), ...chain],
    };
  }

  async function check(
    subject: CheckSubject,
    permission: PermissionKey,
    node: Node,
    entity?: EntityRef,
  ): Promise<Decision> {
    if (subject.kind === 'capability') {
      return checkCapability(subject.id, permission, node, entity);
    }
    const now = reader.now();
    const deny: Decision = { allowed: false, checked: permission, node };
    const scope = reader.scopeFor(node);
    if (await switchedOff(subject, node, scope)) return deny;
    const getRole = roleReaderFor(node.tenantId);

    // Rule 4 — membership: the subject set is the caller plus its orgs. Shared with
    // `covers` (§ `subjectsOf`).
    const subjects = await subjectsOf(subject, node, now);

    // The readers' prefix match is a pre-filter (SQL LIKE ignores case), so every row is held
    // to the prefix exactly here: `Role:admin` must not expand as `role:admin` (#1869).
    const tuplesFor = async (
      subjectRefValue: string,
      prefix: string,
      scoped: boolean,
    ): Promise<PermissionTupleRow[]> =>
      (scoped
        ? scope
          ? await scope.tuples(subjectRefValue, prefix)
          : []
        : await reader.tenantTuples(node.tenantId, subjectRefValue, prefix)
      ).filter((row) => row.relation.startsWith(prefix));

    for (const nodeObj of nodeObjectsOf(node)) {
      for (const s of subjects) {
        // Rule 1 — role expansion.
        for (const row of await tuplesFor(s.ref, 'role:', nodeObj.scoped)) {
          if (row.object !== nodeObj.obj || !live(row, now)) continue;
          const roleKey = row.relation.slice('role:'.length);
          const role = await getRole(roleKey);
          if (role?.permissions.includes(permission)) {
            return {
              allowed: true,
              proof: [
                ...(s.via ? [s.via] : []),
                t(row.subject, row.relation, row.object),
                t(`role:${roleKey}`, `granted:${permission}`, nodeObj.obj),
              ],
            };
          }
        }
        // Direct grants at the node.
        for (const row of await tuplesFor(s.ref, `granted:${permission}`, nodeObj.scoped)) {
          if (
            row.object === nodeObj.obj &&
            row.relation === `granted:${permission}` &&
            live(row, now)
          ) {
            return {
              allowed: true,
              proof: [...(s.via ? [s.via] : []), t(row.subject, row.relation, row.object)],
            };
          }
        }
      }
    }

    // Rule 3 — entity walk along declared parent edges (entity grants are scope-local by
    // construction, so no scope store means no walk).
    if (entity && scope) {
      const found = await walkParents(
        scope,
        `${entity.entityType}:${entity.entityId}`,
        now,
        async (ref, chain): Promise<Decision | undefined> => {
          for (const s of subjects) {
            const grant = await scope.grant(s.ref, `granted:${permission}`, ref);
            if (grant && live(grant, now)) {
              return {
                allowed: true,
                proof: [
                  ...(s.via ? [s.via] : []),
                  ...chain,
                  t(grant.subject, grant.relation, grant.object),
                ],
              };
            }
          }
          return undefined;
        },
      );
      if (found) return found;
    }

    return deny;
  }

  return {
    grantedEntities: async (subject, permission, node, entityType, checkEntity, options) => {
      if (subject.kind === 'capability') return { kind: 'incomplete', reason: 'capability' };
      const scope = reader.scopeFor(node);
      if (!scope?.nextGrant || !scope.nextChild) return { kind: 'incomplete', reason: 'checker' };
      // The same subject expansion and liveness predicate `check` uses, including orgs.
      const now = reader.now();
      const subjects = (await subjectsOf(subject, node, now)).map((s) => s.ref);
      return walkGrantedEntities(
        { nextGrant: scope.nextGrant, nextChild: scope.nextChild },
        subjects, permission, entityType, now, checkEntity, options,
      );
    },
    /**
     * The subject's effective permission set at the node, compared against `required`
     * (K-21, membership.md §5.1).
     *
     * Reads every `role:` and `granted:` tuple for each subject at each node object in one
     * pass — two reads per (subject, level) pair — rather than re-walking per permission,
     * which matters most on the DO adapter where each tenant-level read is an RPC.
     *
     * Entity tuples are never consulted, which is what makes this narrowing-aware: an
     * entity-narrowed grant has an `entityType:entityId` object and so matches no node
     * object here, by construction rather than by a filter someone has to remember.
     */
    async covers(
      subject: CheckSubject,
      required: readonly PermissionKey[],
      node: Node,
    ): Promise<Coverage> {
      // Nothing required is trivially covered — and asking the database would be a walk to
      // prove the empty set is a subset of anything.
      if (required.length === 0) return { covered: true, missing: [] };
      // A capability holds no node-level authority by construction (#1672) — everything it
      // carries is narrowed onto one entity — so it covers nothing and can confer nothing.
      if (subject.kind === 'capability') {
        return { covered: false, missing: [...new Set(required)] as [PermissionKey, ...PermissionKey[]] };
      }

      const now = reader.now();
      const scope = reader.scopeFor(node);
      if (await switchedOff(subject, node, scope)) {
        return { covered: false, missing: [...new Set(required)] as [PermissionKey, ...PermissionKey[]] };
      }
      const subjects = await subjectsOf(subject, node, now);
      const getRole = roleReaderFor(node.tenantId);

      const held = new Set<string>();
      for (const nodeObj of nodeObjectsOf(node)) {
        for (const s of subjects) {
          const rows = nodeObj.scoped
            ? scope
              ? await scope.tuples(s.ref, '')
              : []
            : await reader.tenantTuples(node.tenantId, s.ref, '');
          for (const row of rows) {
            const grant = heldBy(row, nodeObj.obj, now);
            if (grant?.role !== undefined) for (const p of (await getRole(grant.role))?.permissions ?? []) held.add(p);
            else if (grant) held.add(grant.permission);
          }
        }
      }
      return coverageOf(required, held);
    },

    check,
  };

}

/**
 * A directory read that never yields (#1184): what a directory UNIT — one SQLite transaction,
 * one synchronous ControlPlaneDO method — can consult without letting another write in. The
 * tenant-level half of `PermissionTupleReader`, with every answer in hand.
 */
export interface TenantDirectoryReader {
  now(): string;
  tenantTuples(tenantId: string, subject: string, relationPrefix: string): PermissionTupleRow[];
  getRole(tenantId: string, key: string): RoleDefinition | undefined;
}

/**
 * `covers` at the TENANT node, synchronously (#1184): the K-21 set comparison over the
 * principal and every org it is a live member of, each one's live tenant-level `role:` and
 * `granted:` tuples, roles expanded. The membership executor's bound, asked again inside the
 * unit that writes the role, so a grant, role definition or demotion landing between its
 * early check and its write cannot be written past.
 *
 * The same answer as `createTupleEvaluator(reader).covers(principal, required, tenantNode)` —
 * a tenant node has no scope store, no entity walk and no switch — which
 * `permission-eval.test.ts` pins over the cases where the two could part.
 */
export function tenantCoverage(
  reader: TenantDirectoryReader,
  tenantId: string,
  principal: string,
  required: readonly PermissionKey[],
): Coverage {
  if (required.length === 0) return { covered: true, missing: [] };
  const now = reader.now();
  const tenantObj = `tenant:${tenantId}`;
  const roles = new Map<string, readonly string[]>();
  const permissionsOf = (key: string): readonly string[] => {
    let permissions = roles.get(key);
    if (!permissions) roles.set(key, (permissions = reader.getRole(tenantId, key)?.permissions ?? []));
    return permissions;
  };
  const held = new Set<string>();
  const fold = (rows: readonly PermissionTupleRow[]) => {
    for (const row of rows) {
      const grant = heldBy(row, tenantObj, now);
      if (grant?.role !== undefined) for (const p of permissionsOf(grant.role)) held.add(p);
      else if (grant) held.add(grant.permission);
    }
  };
  // Rule 4, as `subjectsOf` has it: the principal's own rows, then each live org's — one read
  // of the principal yields both its memberships and its own grants.
  const own = reader.tenantTuples(tenantId, `principal:${principal}`, '');
  fold(own);
  for (const m of own) {
    if (m.relation === 'member' && live(m, now)) fold(reader.tenantTuples(tenantId, m.object, ''));
  }
  return coverageOf(required, held);
}

/**
 * `principal`'s live membership of `orgId` — its tuple, or `undefined` (#2047). Synchronous, for
 * the org bound a directory unit asks: joining someone to an org, or taking them out of it,
 * needs the inviter or remover to be a live member themselves.
 *
 * That is the exact K-21 bound for an org. Membership confers the same thing on every member,
 * at every node — the org's tenant grants, its grants in each scope's own store, its
 * entity-narrowed grants, and whatever it is granted later — so a member holds everything a
 * join would confer, and a non-member does not. No scope store is read, because none needs to
 * be: equality of membership is the comparison.
 */
export function liveOrgMembership(
  reader: TenantDirectoryReader,
  tenantId: string,
  principal: string,
  orgId: string,
): PermissionTupleRow | undefined {
  const now = reader.now();
  const org = `org:${orgId}`;
  return reader
    .tenantTuples(tenantId, `principal:${principal}`, 'member')
    .find((row) => row.relation === 'member' && row.object === org && live(row, now));
}

/**
 * The org half of a membership change's unit (#2047), decided once for both adapters: whether
 * `boundedBy` may join `principal` to the org or take them out of it, and — for a join — when
 * the membership it writes expires. Reads only; the adapter writes.
 */
export function orgChangeBound(
  reader: TenantDirectoryReader,
  tenantId: string,
  change: { op: 'add' | 'remove'; principal: string; boundedBy: string; orgId: string },
): { bounded: false } | { bounded: true; expiresAt: string | null } {
  const bound = liveOrgMembership(reader, tenantId, change.boundedBy, change.orgId);
  if (!bound) return { bounded: false };
  if (change.op === 'remove') return { bounded: true, expiresAt: null };
  return {
    bounded: true,
    expiresAt: joinedMembershipExpiry(bound, liveOrgMembership(reader, tenantId, change.principal, change.orgId)),
  };
}

/** The `after` of an `addMember` audit row: the expiry only when there is one, as before #2047. */
export const memberAddedAudit = (principal: string, orgId: string, expiresAt: string | null) => ({
  principal,
  orgId,
  ...(expiresAt ? { expiresAt } : {}),
});

/**
 * When a membership written by a join expires (#2047): never later than the membership of the
 * principal whose authority bounded it, so a temporary member cannot confer a permanent one,
 * and never earlier than a live membership the joiner already holds, which a re-invitation must
 * not cut short. `null` is "never".
 */
export function joinedMembershipExpiry(
  bound: Pick<PermissionTupleRow, 'expires_at'>,
  existing: Pick<PermissionTupleRow, 'expires_at'> | undefined,
): string | null {
  if (!existing) return bound.expires_at;
  if (existing.expires_at === null || bound.expires_at === null) return null;
  return existing.expires_at > bound.expires_at ? existing.expires_at : bound.expires_at;
}

/**
 * What one tuple row contributes at `nodeObj` — a role to expand, a permission held directly, or
 * nothing — for `covers` and `tenantCoverage` alike, so the two read a row the same way.
 */
function heldBy(
  row: PermissionTupleRow,
  nodeObj: string,
  now: string,
): { role: string; permission?: undefined } | { role?: undefined; permission: string } | undefined {
  if (row.object !== nodeObj || !live(row, now)) return undefined;
  if (row.relation.startsWith('role:')) return { role: row.relation.slice('role:'.length) };
  if (row.relation.startsWith('granted:')) return { permission: row.relation.slice('granted:'.length) };
  return undefined;
}

/**
 * `required` against `held`. Order follows the request so a refusal reads predictably;
 * deduplicated so a caller passing the same key twice does not see it twice.
 */
function coverageOf(required: readonly PermissionKey[], held: ReadonlySet<string>): Coverage {
  const missing: PermissionKey[] = [];
  for (const p of required) {
    if (!held.has(p) && !missing.includes(p)) missing.push(p);
  }
  return missing.length === 0 ? { covered: true, missing: [] } : { covered: false, missing };
}
