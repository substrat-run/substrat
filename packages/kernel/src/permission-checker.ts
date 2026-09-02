import {
  objectRef,
  SubstratError,
  type Coverage,
  type Decision,
  type EntityRef,
  type Node,
  type PermissionKey,
  type CheckSubject,
  type PrincipalId,
} from '@substrat-run/contracts';

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
}

/** Convenience for the overwhelmingly common case. */
export const asPrincipal = (id: PrincipalId): CheckSubject => ({ kind: 'principal', id });

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
