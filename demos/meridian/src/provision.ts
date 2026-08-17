import {
  connectionId,
  definePermissions,
  platformActorId,
  type ConnectionId,
  type PermissionKey,
  type PrincipalId,
  type RoleDefinition,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { protocolModule, PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import { absenceModule } from '@substrat-run/engine-absence';
import { meridianModule } from './module.js';
import { HR_PERM } from './manifest.js';

/**
 * Provisioning ONE instance of this vertical — what a customer receives.
 *
 * Split out of `seed.ts` so it can run ANYWHERE the kernel runs. `seed.ts` imports
 * `node:fs` and `SqliteScopeHost`, so anything importing provisioning from there
 * dragged `better-sqlite3` and node built-ins along — which the Cloudflare worker
 * cannot load. The seam was already right; the file boundary was not.
 *
 * The host is the neutral `ScopeHost` contract, not a concrete adapter, so the
 * same function provisions on SQLite locally and on Durable Objects in production.
 * The demo story — a second company, an attacker — lives in `seed.ts` and is
 * unreachable from here (#31 blockers 3 and 4).
 */

/** The Scrive vertical slug — the `vertical` half of every scope and connection here. */
export const VERTICAL = 'meridian';

/**
 * OAuth1 credential a Scrive connection stores — the four parts that combine into
 * a PLAINTEXT signature (mirrors the connector's `scriveSecret`). Passed in from
 * the environment; never checked in.
 *
 * A `type`, not an `interface`: the connection store's secret is a
 * `Record<string, string>`, and TS only lets a (non-augmentable) type alias
 * satisfy that index signature.
 */
export type ScriveCredential = {
  clientId: string;
  clientSecret: string;
  tokenId: string;
  tokenSecret: string;
};

/**
 * What ANY instance of this vertical has: one tenant, one scope, an owner.
 *
 * The boundary #31 blocker 3 is about — everything in DemoWorld beyond these three
 * is the DEMO STORY, which a customer must not receive. Separate types make that
 * structural: `provisionMeridian` cannot return a cast, because its return type has
 * no room for one.
 */
export interface MeridianInstance {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The first hr-admin — whoever provisioned it. */
  owner: PrincipalId;
}

/**
 * Registration order = migration order. The engines register before the
 * vertical so their tables exist when its journal runs — protocol for
 * onboarding, absence for the 0003 extraction handoff (which INSERTs into
 * absence_*). Exported for the permission checkpoint emitter (parity with
 * demos/callout).
 */
export const MODULES = [protocolModule, absenceModule, meridianModule];

const hrAdminPerms: PermissionKey[] = [
  HR_PERM.employeeManage,
  HR_PERM.absenceConfigure,
  HR_PERM.absenceApprove,
  HR_PERM.absenceRead,
  HR_PERM.timeRead,
  HR_PERM.projectManage,
  HR_PERM.expenseApprove,
  HR_PERM.expenseRead,
  HR_PERM.payrollExport,
  PROTO.create,
  PROTO.fill,
  // The contract half: freeze the document and send it to Scrive. Note that
  // PROTO.recordSignature is deliberately NOT here and belongs to no human role —
  // it speaks for the provider, not for a person. It is held by the Scrive
  // CONNECTION instead (connectScrive → grantToConnection), the inbound authority
  // seam (#97) now that it and the poll path (#96) have landed.
  PROTO.bind,
  PROTO.requestSignature,
  PROTO.sign,
  PROTO.read,
  PROTO.void,
];

const managerPerms: PermissionKey[] = [
  HR_PERM.absenceApprove,
  HR_PERM.absenceRead,
  HR_PERM.timeRead,
  HR_PERM.expenseApprove,
  HR_PERM.expenseRead,
  PROTO.read,
];

const payrollPerms: PermissionKey[] = [HR_PERM.payrollExport, HR_PERM.expenseRead];

/**
 * This vertical's role table — identical in every tenant, so a plain constant.
 * Employees are NOT a role: their access is entity-narrowed (see EMPLOYEE_SELF).
 */
export const ROLES: RoleDefinition[] = [
  { key: 'hr-admin', permissions: hrAdminPerms, source: 'vertical' },
  { key: 'manager', permissions: managerPerms, source: 'vertical' },
  { key: 'payroll', permissions: payrollPerms, source: 'vertical' },
];

/**
 * What an employee receives, narrowed to their own employee record. Note
 * PROTO.sign: onboarding is *employee-signed* here (they e-sign their own
 * acknowledgements) — vertical policy that differs from Callout, where the
 * arbetsledare signs. Same engine, different who-signs; the grant draws the line.
 */
export const EMPLOYEE_SELF: PermissionKey[] = [
  HR_PERM.absenceRead,
  HR_PERM.absenceRequest,
  HR_PERM.timeReport,
  HR_PERM.timeRead,
  HR_PERM.expenseSubmit,
  HR_PERM.expenseRead,
  PROTO.fill,
  PROTO.sign,
  PROTO.read,
];

/** Entity-narrowed grant SHAPES — the reviewable half of the permission diff. */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'employee', permissions: EMPLOYEE_SELF },
];

/**
 * The single typed source for this vertical's permission surface — what the permission
 * checkpoint and `substrat push` read (discovered via `package.json` `substrat.permissions`).
 * Derived from the same `MODULES`/`ROLES` the host registers, so it cannot drift from what runs.
 */
export const permissions = definePermissions({ modules: MODULES, roles: ROLES, entityGrants: ENTITY_GRANTS });

/**
 * Give an instance a live Scrive connection and the one grant that lets the
 * reconcile driver write a completed signature back into the scope as the
 * connection itself (#97).
 *
 * The connection is keyed (tenant, `meridian`, `scrive`) and holds ONLY
 * `protocol:record-signature` — the key no human role holds. That is the whole
 * authority a leaked Scrive token would carry: record a signature on this
 * vertical's data, nothing else, and it shows up in the permission diff.
 */
export async function connectScrive(
  host: ScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; secret: ScriveCredential },
): Promise<ConnectionId> {
  const staff = platformActorId.parse(ulid());
  const id = connectionId.parse(ulid());
  await host.admin.createConnection(staff, {
    id,
    tenantId: input.tenantId,
    vertical: VERTICAL,
    provider: 'scrive',
    label: 'Scrive (testbed)',
    secret: input.secret,
  });
  // What the connection may do in the scope, and nothing more. Three keys, each
  // for one leg of the round trip — a permission-diff line apiece, and every one
  // of them narrowed to this scope.
  for (const permission of [
    // Inbound: record a signature the provider reports (#97).
    PROTO.recordSignature,
    // Inbound: land the sealed signed PDF on the instance (#476 step 2). This was
    // MISSING — the reconcile has been trying to attach and reporting the refusal
    // as a `skipped` reason in its result, which is the designed behaviour and
    // means nobody was told.
    PROTO.attach,
    // Outbound: read the document the vertical bound, so the counterparty is sent
    // the avtal rather than an attestation sheet (#711). Without this the dispatch
    // refuses rather than substituting other paper.
    PROTO.read,
  ]) {
    await host.admin.grantToConnection(staff, {
      connectionId: id,
      permission,
      node: { tenantId: input.tenantId, scopeId: input.scopeId },
      grantedBy: staff,
    });
  }
  return id;
}

/**
 * Provision ONE instance of this vertical — what a customer gets (#31 blocker 3).
 *
 * Tenant, scope, entitlements, roles, identity pool, and an owner holding
 * `hr-admin`. No cast, no fixtures, no second company. Idempotent, so it is
 * safe on every start and safe against an instance that already exists.
 *
 * This is the function an instantiate button (and `POST /internal/provision`) calls.
 */
export async function provisionMeridian(
  host: ScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; owner: PrincipalId; slug: string; name: string },
  opts: { scrive?: ScriveCredential } = {},
): Promise<MeridianInstance> {
  const staff = platformActorId.parse(ulid());

  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  // K-23: a provider declares its topology before it may link an identity.
  await host.admin.registerIdentityPool(staff, {
    provider: 'better-auth',
    topology: 'central',
    tenantId: null,
  });
  // Entitlements (§4.3) are default-deny, so the SKU flags for the modules this
  // vertical runs must be granted before any of its operations resolve.
  for (const key of ['protocol', 'absence', 'meridian']) {
    await host.admin.grantEntitlement(staff, input.tenantId, key);
  }
  await host.provisionScope(staff, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    jurisdiction: 'eu',
    // The scope must name its vertical for a connection to reach it — a
    // connection is keyed (tenant, vertical, provider), and `getConnectorScope`
    // refuses a scope running a different one. Correct regardless of Scrive.
    vertical: VERTICAL,
  });
  // Provisioning writes the row as `provisioning`; nothing may use the scope until
  // it is active (K-31). Here the platform and the vertical are the same process, so
  // the confirmation is immediate — hosted, it arrives from the vertical over a
  // separate call, which is the gap the state exists to make observable.
  await host.admin.activateScope(staff, input.tenantId, input.scopeId);
  for (const role of ROLES) await host.admin.defineRole(staff, input.tenantId, role);
  await host.admin.assignRole(staff, {
    principalId: input.owner,
    roleKey: 'hr-admin',
    node: { tenantId: input.tenantId, scopeId: null },
  });

  // Wire the provider BEFORE any contract is issued: a dispatch fires post-commit,
  // so the connection has to exist by the time `hr/issue-employment-contract`
  // emits, or the connector fails with no credential. Only when Scrive is enabled.
  if (opts.scrive) {
    await connectScrive(host, {
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      secret: opts.scrive,
    });
  }

  return { tenantId: input.tenantId, scopeId: input.scopeId, owner: input.owner };
}
