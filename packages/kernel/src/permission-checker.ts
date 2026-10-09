import {
  errorCodeOf,
  objectRef,
  substratError,
  SubstratError,
  type Actor,
  type Coverage,
  type Decision,
  type EntityRef,
  type Node,
  type PermissionKey,
  type CheckSubject,
  type PrincipalId,
} from '@substrat-run/contracts';
import type { GrantedEntitiesPage } from './grant-scoped-read.js';

/**
 * The evaluation seam (D-16): the MODEL is kernel-owned, the evaluation engine
 * is an adapter — the built-in default is a constrained relationship-tuple
 * engine (design doc §4.2, plan D-23), OpenFGA-swappable behind this same
 * interface. Both must satisfy the same contract tests.
 *
 * `entity` narrows the check to one entity: evaluated as node-level first
 * (staff see everything in the scope), then via the declared parent-edge walk
 * against entity-narrowed grants (§4.2 rule 3).
 */
export interface PermissionChecker {
  /**
   * `subject` rather than `principal` since #97: a connection can hold a grant,
   * and must not be laundered through a principal to do it. Every existing
   * caller passes `{ kind: 'principal', id }` and behaves exactly as before.
   */
  check(
    subject: CheckSubject,
    permission: PermissionKey,
    node: Node,
    entity?: EntityRef,
  ): Promise<Decision>;
  /** Optional for a pluggable checker; an absent implementation is reported as incomplete. */
  grantedEntities?(
    subject: CheckSubject,
    permission: PermissionKey,
    node: Node,
    entityType: string,
    checkEntity: (entity: EntityRef) => Promise<boolean>,
    options?: { limit?: number; cursor?: string },
  ): Promise<GrantedEntitiesPage>;
  /**
   * Does `subject` already hold every one of `required` at `node`? (K-21,
   * membership.md §5.1.)
   *
   * The bound that makes role assignment safe: *a principal may assign role `R` at node
   * `N` only if the assigner already holds every permission `R` carries at `N`.* Without
   * it the definition/assignment checkpoint protects nothing — an `admin` promoting
   * themselves to `owner` widens no role, calls no `defineRole`, and shows up in no diff.
   *
   * **One resolution, not N checks.** `check` answers about one permission and walks the
   * tuples to do it; asking it twenty times for a twenty-permission role walks them
   * twenty times, on every invite acceptance. An implementation resolves the subject's
   * effective set once and compares.
   *
   * **Narrowing-aware, and this is the load-bearing part.** Only authority held at the
   * NODE counts. An entity-narrowed grant (§4.2 rule 3) does not satisfy the bound for
   * the unnarrowed permission — otherwise narrowing launders into full authority by way
   * of assignment: share one work order with someone, and they could assign a role
   * carrying `workorder:read` over every work order there is.
   *
   * Membership still expands (rule 4): authority a subject holds through an org is
   * authority it holds, and can therefore confer.
   *
   * Returns which permissions are MISSING rather than a bare boolean, because the
   * refusal a person can act on names them.
   */
  covers(
    subject: CheckSubject,
    required: readonly PermissionKey[],
    node: Node,
  ): Promise<Coverage>;
  /**
   * What `subject` holds at `node` (#1686): every permission it holds at the node itself — the
   * set `covers` compares against — and every live entity-narrowed grant it holds in the scope,
   * each through the same subject expansion (its orgs included). What the bound on minting a
   * `become` capability reads about the principal being become.
   *
   * Optional for a pluggable checker; an absent implementation makes that bound refuse.
   */
  holdings?(subject: CheckSubject, node: Node): Promise<Holdings>;
}

/** What `PermissionChecker.holdings` answers. */
export interface Holdings {
  /** Held at the node (scope or tenant level), roles expanded, deduplicated — what `covers` compares. */
  permissions: PermissionKey[];
  /** The role keys held at the node, as assigned — unexpanded, deduplicated. */
  roles: string[];
  /** The permissions granted directly at the node (not through a role), deduplicated. */
  granted: PermissionKey[];
  /** Live entity-narrowed grants, one per (permission, entity). */
  narrowed: { permission: PermissionKey; entity: EntityRef }[];
}

/**
 * What `canAssign` throws, in an operation and on the host, for a role the tenant does not
 * define (#1931). One builder and one recogniser: a caller that must tell "no such role" apart
 * from every other `not_found` (the invite revoke route) matches the thrower, not a copy of its
 * words. The recogniser names the role, so a `not_found` about anything else, including a
 * different role, is not mistaken for it.
 */
const unknownRoleMessage = (roleKey: string): string => `no such role in this tenant: ${roleKey}`;
export const unknownRoleError = (roleKey: string): SubstratError => substratError('not_found', unknownRoleMessage(roleKey));
export const isUnknownRoleError = (err: unknown, roleKey: string): boolean =>
  err instanceof Error && errorCodeOf(err) === 'not_found' && err.message === unknownRoleMessage(roleKey);

/** Convenience for the overwhelmingly common case. */
export const asPrincipal = (id: PrincipalId): CheckSubject => ({ kind: 'principal', id });

/**
 * The spine ACTOR a check subject is recorded as — on an event, a denial, a platform
 * intent. One mapping, so the four places that record "who" cannot disagree about it: a
 * principal is its bare id, and every subject that is not a person is the object form that
 * says what it is instead (#97, #383, #1672, #1706).
 */
export const actorOf = (subject: CheckSubject): Actor => {
  switch (subject.kind) {
    case 'principal':
      return subject.id;
    case 'system':
      return { system: subject.id };
    case 'connection':
      return { connection: subject.id };
    case 'capability':
      return { capability: subject.id };
    case 'vertical':
      // #1706: the caller's slug AND the instance that called — see `verticalActor`.
      return { vertical: subject.id, scope: subject.scope };
  }
};

/**
 * A refused check. The message constructor stays the public surface modules use
 * (`throw new PermissionDenied('…')` for their own policy denials). `assertAllowed`
 * additionally attaches the denied `permission` and the `node` it was checked at (K-35),
 * so the host can record the denial (actor, permission, where) without re-parsing the
 * message — and a plain message-only denial simply carries neither and is not recorded.
 */
export class PermissionDenied extends SubstratError {
  readonly permission?: PermissionKey;
  readonly node?: Node;
  constructor(message: string, detail?: { permission: PermissionKey; node: Node }) {
    super('permission_denied', message, detail ? { permission: detail.permission } : {});
    // NOT `Substrat.permission_denied`, which is what `SubstratError` would have set:
    // `vertical-host`'s classifier and several verticals match this exact string, and
    // the taxonomy recognises it as the code (contracts' `CODE_BY_ERROR_NAME`). A
    // rename here would be a silent behaviour change smuggled into a refactor.
    this.name = 'PermissionDenied';
    this.permission = detail?.permission;
    this.node = detail?.node;
  }
}

/** Throw unless the decision is an allow. The standard first line of an operation. */
export function assertAllowed(decision: Decision): asserts decision is Extract<
  Decision,
  { allowed: true }
> {
  if (!decision.allowed) {
    throw new PermissionDenied(`permission denied: ${decision.checked}`, {
      permission: decision.checked,
      node: decision.node,
    });
  }
}

/** Secure default: deny everything. Hosts require an explicit checker to allow anything. */
export const denyAllChecker: PermissionChecker = {
  check: async (_principal, permission, node) => ({
    allowed: false,
    checked: permission,
    node,
  }),
  // Holds nothing, so it covers nothing — every required permission comes back missing.
  // A role with no permissions is still coverable, which is not a special case: the
  // empty set is a subset of the empty set, and conferring nothing confers nothing.
  covers: async (_subject, required) =>
    required.length === 0
      ? { covered: true, missing: [] }
      : { covered: false, missing: [...required] },
};

/**
 * Dev/test-only checker. The name is deliberately alarming: it grants every
 * permission to every principal via a synthetic self-granted proof tuple.
 * Never wire it into anything a tenant can reach.
 */
export const UNSAFE_allowAllChecker: PermissionChecker = {
  // Holds everything, so it covers everything — including the escalation bound, which
  // is exactly why this must never be wired anywhere a tenant can reach.
  covers: async () => ({ covered: true, missing: [] }),
  check: async (principal, permission, node) => ({
    allowed: true,
    proof: [
      {
        subject: objectRef.parse(`principal:${principal}`),
        relation: `granted:${permission}`,
        object: objectRef.parse(
          node.scopeId ? `scope:${node.scopeId}` : `tenant:${node.tenantId}`,
        ),
      },
    ],
  }),
};
