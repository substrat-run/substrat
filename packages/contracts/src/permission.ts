import { z } from 'zod';
import {
  capabilityId,
  instant,
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  verticalSlug,
} from './ids.js';
import { entityRef } from './events.js';

// ============================================================================
// Authored surface — what humans and agents write (design doc §4.1).
// ============================================================================

// A node in the assignable tree: tenant root (scopeId null) or a scope.
export const node = z.object({
  tenantId,
  scopeId: scopeId.nullable(),
});
export type Node = z.infer<typeof node>;

export const roleKey = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

export const roleDefinition = z.object({
  key: roleKey,
  permissions: z.array(permissionKey).min(1),
  // Who declared this role. Both members mean "declared in CODE" — an engine's
  // manifest or a vertical's provisioning constants. There is deliberately no
  // value for "an operator created this against a live deployment": nothing can
  // create one yet (role writes are not on the control-plane HTTP surface), and
  // an enum member no code path can produce is the same promise-with-no-mechanism
  // this codebase keeps finding. It lands with whatever writes it.
  source: z.union([moduleId, z.literal('vertical')]),
});
export type RoleDefinition = z.infer<typeof roleDefinition>;

/**
 * A role as the directory holds it — the definition plus the tenant it belongs
 * to (control-plane.md §4.5's roles surface). `RoleDefinition` is what a caller
 * AUTHORS, and a tenant is ambient at that point (`defineRole(actor, tenantId,
 * role)`); this is what a caller READS back, where the tenant is the answer to
 * "where does this role apply?" and has to travel with it.
 */
export const tenantRole = roleDefinition.extend({ tenantId });
export type TenantRole = z.infer<typeof tenantRole>;

export const roleAssignment = z.object({
  principalId,
  roleKey,
  node,
});
export type RoleAssignment = z.infer<typeof roleAssignment>;

// Narrow, direct, time-boxable; also the cross-tenant mechanism (§5.4).
// `entity` narrows the grant to one entity and its declared descendants —
// how portal customers see only their own facilities/orders inside a shared
// scope (design doc §4.1, K-12). Always audited.
/**
 * Who is being checked (#97).
 *
 * The model already had more than one kind of subject — a principal, and the
 * orgs it belongs to via membership. This makes the ENTRY subject polymorphic
 * too, so a connection can hold a grant without pretending to be a person.
 *
 * The alternative was to mint a principal per connection and let it flow
 * through unchanged, which is cheaper and wrong: every audit view would then
 * show a `principal:` subject for something that is not one, which is exactly
 * the confusion `PlatformActorId`'s separate brand exists to prevent.
 */
export const checkSubject = z.union([
  z.object({ kind: z.literal('principal'), id: principalId }),
  z.object({ kind: z.literal('connection'), id: z.string().min(1) }),
  // A MODULE acting on a timer (#383) — the scheduler's subject, the third caller
  // #97 named. Like a connection it is not a person and holds no memberships; its
  // authority is exactly the grants written against `system:<moduleId>` (§ the
  // checker skips membership expansion for any non-principal subject). It stamps
  // `{ system: <moduleId> }` on events, so scheduled work reads as the schedule, not
  // as a human who happened to sit down at 03:00.
  z.object({ kind: z.literal('system'), id: moduleId }),
  // WHOEVER HOLDS A CAPABILITY'S SECRET (#1672) — a link share. Resolved against the
  // capability's own directory row rather than against tuples: the row IS the grant
  // (one entity and its declared descendants, specific keys), no `capability:` tuple is
  // ever written, and the minter's own authority is re-checked on every use — so a
  // capability can never hold more than the principal who minted it holds right now.
  z.object({ kind: z.literal('capability'), id: capabilityId }),
  // ANOTHER VERTICAL of the same tenant (#1706), calling through the platform. Resolved by
  // the ordinary tuple path, like a connection or a schedule: its authority is exactly the
  // `vertical:<slug>` grants THIS vertical's manifest declares for it (`peers`), seated at
  // provisioning. `scope` names the calling INSTANCE — it is what the spine records beside
  // the slug — and takes no part in the tuple ref: every live instance of the caller holds
  // the same grants. No memberships (§ the checker expands membership for principals only).
  z.object({ kind: z.literal('vertical'), id: verticalSlug, scope: scopeId }),
]);
export type CheckSubject = z.infer<typeof checkSubject>;

/**
 * The tuple-store ref for a subject: `principal:01J…` / `connection:01J…` /
 * `system:@scope/mod` / `capability:01J…` / `vertical:acme/board-room` — for a vertical the
 * SLUG only, never the calling instance (see `checkSubject`).
 */
export const subjectRef = (subject: CheckSubject): string => `${subject.kind}:${subject.id}`;

/**
 * A capability granted to a CONNECTION rather than a principal (#97).
 *
 * Narrow by construction: a connection is keyed (tenant, vertical, provider),
 * so granting it `protocol:record-signature` reaches only that tenant's scopes
 * running that vertical. The blast radius of a leaked provider token is one
 * permission on one vertical's data, and it is readable in a diff.
 */
export const connectionGrant = z.object({
  connectionId: z.string().min(1),
  permission: permissionKey,
  node,
  expiresAt: instant.optional(),
  grantedBy: platformActorId,
});
export type ConnectionGrant = z.infer<typeof connectionGrant>;

/**
 * A connection grant as the DIRECTORY records it (#592) — the durable, readable half
 * of `grantToConnection`, written alongside the enforcement tuple. The tuple lives
 * where it is checked (the scope's own store); this row is what the platform gathers
 * FROM, so a scope provisioned after the grant receives the same grants as one
 * provisioned before it, and so "what may this connection invoke" is answerable
 * without walking every scope DO (connections.md §6.2.4). Tombstoned (never deleted)
 * by `revokeConnection`'s cascade — a revoked row is evidence, not roster.
 */
export const connectionGrantRecord = z.object({
  connectionId: z.string().min(1),
  tenantId,
  /** The connection's vertical, denormalized at grant time — the gather's filter key. */
  vertical: z.string().min(1),
  permission: permissionKey,
  /** Null = tenant-wide: materialized per scope at provision/reconcile (a CP-less
   *  scope cannot read tenant tuples, so per-scope delivery is the only shape). */
  scopeId: scopeId.nullable(),
  expiresAt: instant.nullable(),
  grantedBy: platformActorId,
  grantedAt: instant,
  revokedAt: instant.nullable(),
});
export type ConnectionGrantRecord = z.infer<typeof connectionGrantRecord>;

/**
 * A connection grant as it travels INTO a deployment (#592) — delivered with
 * provision/reconcile exactly as entitlements (#310) and identity links (#406) are,
 * and projected as the scope-local `connection:<id>` tuple the permission checker
 * reads. Already materialized to ONE scope, so it carries no node; the platform is
 * the authoritative source (it gathers from the directory, never the caller's body),
 * and only LIVE grants of LIVE connections are ever delivered — a revoked
 * connection's grants are simply absent from the next delivery.
 */
export const projectedConnectionGrant = z.object({
  connectionId: z.string().min(1),
  permission: permissionKey,
  expiresAt: instant.optional(),
});
export type ProjectedConnectionGrant = z.infer<typeof projectedConnectionGrant>;

export const capabilityGrant = z.object({
  principalId,
  permission: permissionKey,
  node,
  entity: entityRef.optional(),
  expiresAt: instant.optional(),
  grantedBy: principalId,
});
export type CapabilityGrant = z.infer<typeof capabilityGrant>;

/**
 * A capability granted to a MODULE's system principal rather than a person (#383) —
 * the scheduler analogue of `connectionGrant`.
 *
 * Narrow by construction: it reaches only scopes of the module it names, and only
 * the one permission. It is projected from the module's declared `schedules`
 * (`scheduleSpec.permissions`) at scope provisioning, so what a schedule may do is
 * readable in the permission diff (code). Turning a scope's schedules OFF is not a
 * revoke of one of these but the schedule kill switch, `systemSwitch` below (#1666):
 * a per-permission revoke would leave the gate open and fail the schedule's own
 * `ctx.check` on every pass, and a re-grant must not be able to turn it back on.
 */
export const systemGrant = z.object({
  moduleId,
  permission: permissionKey,
  node,
  expiresAt: instant.optional(),
  grantedBy: platformActorId,
});
export type SystemGrant = z.infer<typeof systemGrant>;

/**
 * The schedule kill switch (#1666) — one module's scheduled work on ONE scope, turned
 * off by `HostAdmin.revokeFromSystem` and back on by `restoreToSystem`.
 *
 * **Module-wide, never per permission.** A grant is per permission and schedules share
 * permissions, so "one schedule" is not expressible as a grant revoke without switching
 * off its siblings too. And a per-permission revoke is worse than none: the gate would
 * stay open on the module's other live grant, and the schedule's own `ctx.check` would
 * then fail it on every pass — noise in place of silence.
 *
 * `reason` is required and lands in the admin log beside the actor, because "who turned
 * a tenant's schedules off, and why" is the question the log exists to answer — a
 * switch pulled in an incident has no other record of what the incident was.
 *
 * The scope is required: the switch is per scope. A tenant-wide form would be a
 * different decision about blast radius, and it is not this one.
 */
export const systemSwitch = z.object({
  moduleId,
  node: z.object({ tenantId, scopeId }),
  reason: z.string().trim().min(1).max(500),
});
export type SystemSwitch = z.infer<typeof systemSwitch>;

/**
 * What the far end of the switch did in the scope's own storage (#1666) — the wire
 * shape `/internal/system-switch` answers with, and what a local host computes itself.
 *
 * `held: false` means the scope holds no `system:<module>` grant and no switch marker
 * for that module at all — a typo'd module id, or a module this scope never ran. Nothing
 * was written. It is an answer, not an error, so that a deployment which predates the
 * route (and answers 404) can never be mistaken for one that simply held nothing.
 */
export const systemSwitchOutcome = z.object({
  held: z.boolean(),
  /** False on a repeat — the switch was already in that position (idempotent). */
  changed: z.boolean(),
  /** The grants this call tombstoned (off) or restored (on), by permission key. */
  permissions: z.array(permissionKey),
});
export type SystemSwitchOutcome = z.infer<typeof systemSwitchOutcome>;

/**
 * What `revokeFromSystem` / `restoreToSystem` answer (#1666) — the position the switch is now
 * in. `operationId` names this call's rows on the admin log (its intent, then its outcome),
 * so an operator can tie what the route answered to what the log recorded.
 */
export const systemSwitchResult = z.object({
  operationId: z.string().min(1),
  moduleId,
  schedules: z.enum(['on', 'off']),
  changed: z.boolean(),
  permissions: z.array(permissionKey),
});
export type SystemSwitchResult = z.infer<typeof systemSwitchResult>;

/**
 * One module's schedule-switch position on a scope (#1674) — bare, with no audit join.
 * The wire shape of `/internal/system-grants`, the vertical's own honest answer: it holds
 * no admin log, so it cannot say who switched a module off or why, only where it stands —
 * the kernel's `systemScheduleState`, the SAME predicate the runner gates on.
 */
export const systemScheduleEntry = z.object({
  moduleId,
  schedules: z.enum(['on', 'off', 'ungranted']),
});
export type SystemScheduleEntry = z.infer<typeof systemScheduleEntry>;

/**
 * The per-scope status read (#1674) — `GET /tenants/:t/scopes/:s/system-grants`, one entry
 * per module the scope holds or has ever held system authority for. Adds the one thing a
 * hosted deployment cannot answer for itself: while off, who switched it off, when, and
 * why — the control plane's own admin log, joined by moduleId to the `intent` row of the
 * `revokeFromSystem` that put it there.
 */
export const systemGrantsStatusEntry = systemScheduleEntry.extend({
  switchedOff: z
    .object({
      actor: platformActorId,
      reason: z.string(),
      at: instant,
    })
    .nullable(),
  /**
   * The position the DIRECTORY records for this module on this scope (#1674), or null when
   * it has no record. `schedules` is what the scope itself says, and it is what the runner
   * gates on. When the two disagree, that is drift, and OFF wins from either side: a record
   * of `off` is put back by the next reconcile, and a record never turns a module on.
   */
  recorded: z.enum(['on', 'off']).nullable(),
});
export type SystemGrantsStatusEntry = z.infer<typeof systemGrantsStatusEntry>;

/**
 * One row of the directory's switch record (#1674) — the fleet read's entry
 * (`GET /system-switches`). Written by `revokeFromSystem` / `restoreToSystem` beside the
 * scope's own marker, and kept for the one thing the scope's storage cannot do for itself:
 * survive that storage being wiped. `operationId` is the switch call's (the admin-log pair
 * that moved it), `at` when it moved, and `vertical` the scope's binding as the directory
 * holds it now.
 */
export const systemSwitchRecord = z.object({
  tenantId,
  scopeId,
  moduleId,
  vertical: z.string().nullable(),
  position: z.enum(['on', 'off']),
  actor: platformActorId,
  reason: z.string(),
  operationId: z.string().min(1),
  at: instant,
});
export type SystemSwitchRecord = z.infer<typeof systemSwitchRecord>;

// ============================================================================
// Evaluation representation — relationship tuples (design doc §4.2, plan D-23).
// Internal to the checker; verticals never author these. The fixed derivation
// algebra (role expansion, tree inheritance, declared entity parent edges,
// membership) lives in the evaluator, not in configurable rewrites.
// ============================================================================

// 'principal:<ulid>' | 'org:<ulid>' | 'tenant:<ulid>' | 'scope:<ulid>' |
// '<entityType>:<entityId>' — namespace:id
//
// The regex is deliberately loose on the id half: entity ids are vertical-owned and
// need not be ULIDs. The kernel-owned namespaces above ARE all branded ULIDs at their
// own boundary — `org:` became one in K-22, which is when this comment stopped being
// aspirational.
export const objectRef = z
  .string()
  .regex(/^[a-z0-9_-]+:[^\s]+$/)
  .brand<'ObjectRef'>();
export type ObjectRef = z.infer<typeof objectRef>;

// 'member' | 'parent' | 'role:staff' | 'granted:workorder:read' …
export const relationName = z.string().regex(/^[a-z0-9_:-]+$/);

export const relationTuple = z.object({
  subject: objectRef,
  relation: relationName,
  object: objectRef,
});
export type RelationTuple = z.infer<typeof relationTuple>;

// ============================================================================
// Decisions — an allow ALWAYS carries its proof: the tuple chain that granted
// access. Powers explain(), "view as user" (§7.8), and the human-readable
// permission diff. An unexplained allow is unrepresentable.
// ============================================================================

export const decision = z.discriminatedUnion('allowed', [
  z.object({
    allowed: z.literal(true),
    proof: z.array(relationTuple).min(1),
  }),
  z.object({
    allowed: z.literal(false),
    checked: permissionKey,
    node,
  }),
]);
export type Decision = z.infer<typeof decision>;

// ============================================================================
// Coverage — "does this subject already hold everything that role carries?"
// K-21 / membership.md §5.1: the bound that makes role assignment safe.
// ============================================================================

/**
 * The answer to §5.1's bound: may this subject confer this set of permissions?
 *
 * **Not a `Decision`, deliberately.** A `Decision` answers about ONE permission and
 * carries a proof, and this asks about a set — so an allow would need N proofs and a
 * refusal would have to pick one permission to name. What a caller actually needs on a
 * refusal is *which* permissions are missing, because that is the sentence a person can
 * act on: "you cannot assign `owner` — you do not hold `billing:manage`".
 *
 * `missing` is empty if and only if `covered`, and is ordered as the request was so an
 * error message reads predictably. That is a **discriminated union rather than a
 * sentence**, for the same reason `Decision` above is one: written as
 * `{ covered: boolean; missing: PermissionKey[] }`, a `covered: true` carrying names in
 * `missing` type-checks and parses, and the caller that reads `covered` and the caller
 * that reads `missing` get opposite answers about the same bound — a refusal that reads
 * as an allow. A producer must now commit to one side, and an empty `missing` beside a
 * `covered: false` is unrepresentable too.
 */
export const coverage = z.discriminatedUnion('covered', [
  z.object({ covered: z.literal(true), missing: z.tuple([]) }),
  z.object({ covered: z.literal(false), missing: z.array(permissionKey).min(1) }),
]);
export type Coverage = z.infer<typeof coverage>;

/**
 * The grant an allow resolved through (K-34), for stamping onto an emitted event's
 * `authorization`. Every allow proof ends with a `granted:<permission>` tuple, but a ROLE
 * expansion's has subject `role:<key>` while a capability grant's has a principal / org /
 * connection subject — only the latter names a grant. Returns that granting tuple's
 * `object` (the entity or node it targets), or `undefined` when the allow came via a role
 * (or, defensively, when no matching tuple is present).
 */
export function grantRefFromProof(
  permission: string,
  proof: readonly RelationTuple[],
): string | undefined {
  const rel = `granted:${permission}`;
  for (let i = proof.length - 1; i >= 0; i--) {
    const t = proof[i];
    if (t && t.relation === rel) return t.subject.startsWith('role:') ? undefined : t.object;
  }
  return undefined;
}

export const effectivePermissions = z.object({
  principalId,
  node,
  permissions: z.array(
    z.object({
      permission: permissionKey,
      proof: z.array(relationTuple).min(1),
    }),
  ),
});
export type EffectivePermissions = z.infer<typeof effectivePermissions>;
