# Scope-local permissions — taking the control plane off the request hot path

**Status:** **built.** All three stages of §8 have shipped — the pluggable local reader (#163),
projection-on-write (#165), and CP-less verticals with Callout as the first (#166/#167). The
design below is preserved as the rationale; `scopeLocalPermissions` / `provisionScopeLocal` on
`CloudflareScopeHost` are the landed surface. Prerequisite for genuinely isolated, self-serve,
untrusted verticals (dashboard.md §6 step 5; self-serve-deploy.md — "the untrusted trust
model"). It landed staged, behind the two human checkpoints (permission diff, migration diff).

## 1. The problem — one global DO on every check

The control-plane directory is a **single global Durable Object**:
`controlPlane.get(idFromName('control-plane'))` — one named instance for the whole
environment. And the ScopeDO's permission checker reads it **per operation**: in
`checker.ts`, `check()` calls `cp.tenantTuples(...)` (memberships + tenant-level
assignments/grants) and `cp.getRole(...)` (the role *definition*, consulted even for a
**scope-level** role assignment). So today every permission check that touches a role or a
tenant-level tuple — which is most of them — funnels through one single-threaded DO.

Three separate problems, one cause:

- **Scaling / noisy-neighbour.** A single DO serialises. Every tenant's checks contend on
  it; one tenant's load degrades everyone's. Scopes are not isolated on the permission hot
  path. This is the same hot-path concern K-30 already flagged for the router's directory
  read (and why KV-caching it was rejected).
- **Isolation.** "Each app is its own isolated scope" is not true while every scope shares
  one authority DO per request.
- **Trust / self-serve.** An **untrusted** vertical (self-serve-deploy.md) MUST NOT hold a
  `CONTROL_PLANE` binding — `assertSandboxContract` refuses it. So an untrusted vertical
  *cannot* do the per-op CP read at all. The current model is structurally incompatible
  with the untrusted-vertical vision the platform is built around.

All three converge on the same fix.

## 2. The principle

> **A scope evaluates permissions from its own local state only. The control plane is a
> write-time authority that projects into scopes; it is never a read-time dependency on the
> request path.**

Cost moves from the **read path** (every request) to the **write path** (rare role/grant
changes). For a read-heavy, multi-tenant system that is the correct direction, and it is
what makes a scope actually isolated — and deployable as its own WfP worker with no platform
binding.

## 3. What is already local, and what is not

| Checker input | Today | |
|---|---|---|
| Scope-level **direct grants** (`granted:<perm>` on `scope:<id>`) | ScopeDO SQL | already local |
| **Entity walk** (declared parent edges, depth ≤ 4) | ScopeDO SQL | already local |
| **Role definitions** (`getRole`) | ControlPlaneDO | hot-path CP read |
| **Role assignments** at tenant level, **tenant grants**, **org membership** | ControlPlaneDO | hot-path CP read |
| **Entitlements** | ScopeDO (projected), else ControlPlaneDO | **projected** (#304) |
| **Identity links** (`resolveIdentity`'s input) | ScopeDO (projected), else ControlPlaneDO | **projected** (#406) |

So the checker's `ControlPlaneReader` is the **sole** per-request CP dependency. Everything
it returns can instead be **projected into the ScopeDO** and read locally.

**Entitlements ride the same projection (#304).** They used to be a coordinator-only,
trust-at-provision check — which gated *module loading* but gave a hosted vertical no way to
read plan/quota/tier at *request time* without the forbidden `CONTROL_PLANE` binding. They are
now projected into the scope's `_substrat_entitlements` alongside roles/tuples: `ctx.entitlement`
reads them locally, and the per-operation gate fails closed against the projection. A grant or
revoke is a tenant-level write, so it fans out to invalidate — the same project-on-write /
event-invalidation shape as roles, which is exactly kernel open-question 5's answer. Expiry is
applied at **read** (an expired grant is absent from the view and the gate), and `plan`/`quota`
are carried but not kernel-enforced — the vertical reads the number and enforces its own quota.
Enforcement flips **per scope** the first time entitlements are projected (an `entitlements_enforced`
marker): a scope provisioned before #304 keeps trusting upstream until a fan-out / reconcile /
re-provision back-fills it, so the switch strands no live scope.

A **dispatched** vertical has no control plane to project from, so the platform delivers the
tenant's entitlements **with provisioning** (#310): the control-plane's provision endpoint gathers
them itself (`admin.listEntitlements`, never trusting the caller) and hands them to the vertical,
which projects them in `provisionScopeLocal`. A grant/revoke *after* provision rides a re-provision
(idempotent, K-31 — the same channel role-definition changes use); expiry still enforces locally in
the meantime because the projected row carries it.

**Identity links ride the same projection (#406).** The control plane stays the audited
source of truth (`linkIdentity`/`unlinkIdentity`); a link/unlink is a tenant-level write, so
it fans out into the tenant's projected scopes (`_substrat_identity_links`) like every other
tenant-level change, and the CP-less delivery is the same provision/reconcile channel
entitlements use (`admin.listIdentityLinks`, gathered by the platform, never the caller).
The vertical's auth adapter resolves `(provider, externalId) → principal` from the scope's
own storage via `resolveIdentityLocal` — replacing the login map compiled into the bundle,
which made offboarding a deploy and let a version rollback resurrect a removed login. The
projection is a full replace with no tombstones (the admin log is the audit; `unlinkIdentity`
hard-deletes), so a removed link is absent from the next snapshot — absence is a deny, the
fail-closed direction, and the reconcile sweep repairs any dropped fan-out. K-22's
tenant-scoped key is preserved: links are gathered and projected per tenant, never globally.

## 4. The model — projection on write

The `ControlPlaneReader` interface (`tenantTuples`, `getRole`) stays; its **implementation**
changes from an RPC to the singleton into a **local read over projected rows** in the
ScopeDO's own SQLite. Two new scope-local tables (append-only, tombstoned like
`_substrat_tuples`):

- `_substrat_roles` — the role definitions this scope needs (`key`, `permissions`, `source`).
- `_substrat_tenant_tuples` — the tenant-level assignments/grants/memberships that apply to
  principals acting in this scope, projected as rows the checker reads exactly as it reads
  scope tuples today.

**Writes fan out.** When the control plane `defineRole` / assigns a tenant-level role /
grants at tenant level / adds an org member, it **projects the effective rows into every
scope in that tenant**. When a scope is created, it **pulls the current projection** for its
tenant. The four-rule algebra in `checker.ts` is unchanged — it just reads projected rows
instead of calling the singleton.

A scope provisioned for an **untrusted / CP-less vertical** takes the extreme case: it holds
its role definitions locally and receives only **scope-level** assignments, so its reader
never needs a tenant projection at all — and the `CONTROL_PLANE` binding disappears.

## 5. Security invariants (this is the trust core)

1. **Fail closed.** An absent or empty projection is a **deny**, byte-for-byte the current
   deny path. Missing data can only ever *remove* authority, never grant it — there is no
   code path where "no projection" means allow.
2. **Completeness is the only risk, and it is safe-directional.** If a projection is
   incomplete, a legitimate allow becomes a deny (a customer sees "permission denied," not a
   breach). We must still guarantee no *stale* projection grants **more** than intended —
   which is the revocation invariant below.
3. **Revocation fans out as tombstones (K-21).** Revoking a tenant role or grant writes a
   `revoked_at` tombstone into **every** scope it was projected to. A revoked principal must
   lose access everywhere the projection reached; a dropped fan-out is a security bug, so the
   fan-out is backed by a **reconciliation sweep** (the same durability pattern K-31 uses).
4. **Check-after-write consistency is preserved *within* a scope.** The checker still runs in
   the ScopeDO's serialisation domain, so a scope-level grant is visible to the very next
   check ("no zookies"). The **only** new window is on **tenant-level changes**, which are
   now eventually consistent across the tenant's scopes (§6).

## 6. Consistency & revocation

- **Scope-level grants/roles: unchanged** — synchronous, local, immediately consistent.
- **Tenant-level changes: eventually consistent** across the tenant's scopes, bounded by the
  fan-out + reconciliation sweep. This is a deliberate trade: role changes are rare; requests
  are constant. A short propagation window on an admin action is acceptable where a per-request
  singleton read is not.
- **Scope lifecycle (suspend/archive) stays at the router**, which already gates forwarding on
  directory status — it is not a permission-check concern and does not move.
- **Fan-out cost is bounded by a tenant's scope count.** For most tenants this is small. The
  platform's own dashboard tenant (many app-scopes) is the stress case and an explicit open
  question (§9).

## 7. What this does NOT change

The four-rule tuple algebra and its proof-carrying allow; K-21 tombstone semantics; the
router's node assertion and secret; the shared control plane as the **directory** (tenants,
scopes, hostnames, lifecycle) the router reads. This is about *where permission tuples —
and now entitlements (#304) — are read*, nothing else. (Entitlement *gating* was provision-only
before #304; it now reads the projection at request time, but the grant of an entitlement is
still a control-plane act.)

## 8. Staged plan (each stage behind the permission/migration checkpoints)

1. **Pluggable local reader.** Add `_substrat_roles` + `_substrat_tenant_tuples` and a
   `LocalControlPlaneReader` over them; the ScopeDO builds the checker with it. When the
   `CONTROL_PLANE` binding is present the reader can still fall back to RPC (parity), so this
   stage changes no behaviour on its own — it only makes the read *local-capable*. Fail-closed
   on empty.
2. **Projection on write.** `defineRole` / tenant `assignRole` / tenant `grant` / membership
   fan out into the tenant's scopes; scope creation pulls the projection; a reconciliation
   sweep repairs drift. Now the RPC path is dead for projected scopes.
3. **CP-less verticals.** Provision verticals with scope-level assignments + local role defs;
   drop `CONTROL_PLANE` + `CONTROL_PLANE_SVC`; trust the router-asserted node. Make **Callout**
   the first: push it into the WfP dispatch namespace via `createWfpUploader` (the CF-API
   uploader already wired behind `CF_API_TOKEN`), promote a prod version, and the dashboard's
   `bindScopeVersion` step drives dynamic dispatch. Drop the static `VERTICAL_CALLOUT` bindings.

## 9. Open questions

1. **Fan-out for large tenants** — synchronous on assign vs a sweep only; the dashboard's own
   many-scope tenant is the case to size.
2. **Migration of existing scopes** — back-fill the projection tables for scopes provisioned
   before this; a one-shot reconciliation.
3. **Org membership projection** — memberships are tenant-level today; whether verticals that
   don't use orgs skip it entirely (they can) or it is always projected.
4. **Does the dashboard's own scope go CP-less too**, or does the platform vertical keep a
   privileged reader? It runs in the platform's own deployment, so it is not forced to.
