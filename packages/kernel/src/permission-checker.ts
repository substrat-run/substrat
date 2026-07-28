import {
  objectRef,
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
export class PermissionDenied extends Error {
  readonly permission?: PermissionKey;
  readonly node?: Node;
  constructor(message: string, detail?: { permission: PermissionKey; node: Node }) {
    super(message);
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
};

/**
 * Dev/test-only checker. The name is deliberately alarming: it grants every
 * permission to every principal via a synthetic self-granted proof tuple.
 * Never wire it into anything a tenant can reach.
 */
export const UNSAFE_allowAllChecker: PermissionChecker = {
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
