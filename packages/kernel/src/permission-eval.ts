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
  /** Scope-level tuples for `subject` whose relation starts with `relationPrefix`. */
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
 * Rule 3's walk, as ONE function: from `start`, look for a hit at each frontier object, then
 * expand one level of declared `parent` edges, to `ENTITY_WALK_DEPTH`. `probe` decides what a
 * hit is — a live entity-narrowed grant for a principal, the capability's own root for a
 * capability subject — so both subjects travel exactly the same edges, to exactly the same
 * depth, skipping exactly the same revoked edges. A capability that reached further than an
 * entity grant (or less far) would be a second algebra.
 */
async function walkParents<R>(
  scope: ScopeTupleReader,
  start: string,
  now: string,
  probe: (ref: string, chain: RelationTuple[]) => Promise<R | undefined>,
): Promise<R | undefined> {
  type Frontier = { ref: string; chain: RelationTuple[] };
  let frontier: Frontier[] = [{ ref: start, chain: [] }];
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
        if (!live(p, now)) continue;
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
    const getRole = roleReaderFor(node.tenantId);

    // Rule 4 — membership: the subject set is the caller plus its orgs. Shared with
    // `covers` (§ `subjectsOf`).
    const subjects = await subjectsOf(subject, node, now);

    const tuplesFor = async (
      subjectRefValue: string,
      prefix: string,
      scoped: boolean,
    ): Promise<PermissionTupleRow[]> =>
      scoped
        ? scope
          ? scope.tuples(subjectRefValue, prefix)
          : []
        : reader.tenantTuples(node.tenantId, subjectRefValue, prefix);

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
            if (row.object !== nodeObj.obj || !live(row, now)) continue;
            if (row.relation.startsWith('role:')) {
              const role = await getRole(row.relation.slice('role:'.length));
              for (const p of role?.permissions ?? []) held.add(p);
            } else if (row.relation.startsWith('granted:')) {
              held.add(row.relation.slice('granted:'.length));
            }
          }
        }
      }

      // Order follows the request so a refusal reads predictably; deduplicated so a caller
      // passing the same key twice does not see it twice.
      const missing: PermissionKey[] = [];
      for (const p of required) {
        if (!held.has(p) && !missing.includes(p)) missing.push(p);
      }
      return missing.length === 0 ? { covered: true, missing: [] } : { covered: false, missing };
    },

    check,
  };

}
