---
status: built
layer: plan
description: The tenant-facing self-service surface. apps/dashboard.
---

# The Dashboard — the tenant-facing self-service surface

**Status:** **built** — `apps/dashboard`. Sibling to [control-plane.md](control-plane.md) (the operator
console) and [kernel-design.md](kernel-design.md) (tenancy, permissions, provisioning). The prompt:
*"Vercel, but for Substrat."*

## 1. What it is, and why it is not the console

Substrat already has one control surface: `apps/console`, the **operator** console — Substrat
staff run the fleet from it (every tenant, the admin log, provisioning for anyone), gated by staff
SSO. It answers *"run the platform."*

The Dashboard answers a different question — *"run **my** org"* — for a **customer's tenant
admin**, self-service, seeing only their own tenant. Same underlying platform; opposite audience
and blast radius.

| | audience | sees | auth | job |
|---|---|---|---|---|
| **Console** (built) | Substrat operators | *all* tenants, the fleet | staff SSO/MFA | run the platform |
| **Dashboard** (this doc) | a customer's admin | *only their own* tenant | customer sign-up | run their org + apps |

Naming is deliberate: "console" reads as an operator/back-office tool; "dashboard" reads as the
customer's home. The docs already use "portal" for a *vertical's* own end-user surface
(boendeportal, customer portal), so the Dashboard does not take that word.

## 2. Vercel, mapped to Substrat

The analogy is close to one-to-one, which is the reason to lean into it:

| Vercel | Substrat |
|---|---|
| Team / account | **Tenant** |
| Project | **Vertical instance** — "Acme HR" is a Meridian instance |
| Deployment / version | a registered **vertical version** bound to a scope |
| Environment (prod/preview) | **Scope** — a tenant holds several |
| Team members | **principals + role assignments** |
| Domains | **hostname bindings** (`bindHostname`) |
| Integrations | **connections** (Scrive, Fortnox — the connection store) |
| Env vars / secrets | connection secrets + module config |
| Plan / billing | **entitlements** (SKU flags) |
| "New Project from a template" | **create instance** (catalog → provision) |

## 3. The bet: the Dashboard is a Substrat vertical

The Dashboard is built **as a Substrat vertical** — the platform, dogfooded on itself. This is the
load-bearing decision, and it is what makes the hard part (authorization) fall out of the kernel
instead of being re-invented.

Concretely:

- **A customer is a tenant.** Sign-up bootstraps that tenant, one **dashboard scope** (the
  customer's home), and the signer as its **owner** (a tenant-admin role).
- **A customer's apps are scopes** in that same tenant — a Meridian scope, a Callout scope — each
  running a vertical. Vercel's Team→Projects is Substrat's Tenant→Scopes.
- **The dashboard scope holds the account's own data**: the app list (a projection of the tenant's
  scopes), the member roster (a projection of role assignments), connected providers, bound
  domains, the plan. Its **operations** are "provision an app", "invite a member", "bind a domain",
  "connect Scrive" — each a vertical operation with a permission check.

So the Dashboard is not special because it is a new kind of thing; it is a vertical whose *domain
is the platform*. Everything a vertical gets for free, it gets: tenancy isolation, the
role/grant permission model, the append-only audit spine, entitlements, and (K-realtime) live
scope updates for an app-status view.

### What it reuses vs what is new

| Reused, unchanged | New for the Dashboard |
|---|---|
| Tenancy (customer = tenant) | Self-service **sign-up** + tenant bootstrap (today a staff action) |
| Roles/grants — **invite = grant a role** | A **tenant-scoped platform authority** (§4) — the crux |
| The provisioning handshake (K-31, `/internal/provision`) | The vertical **catalog** — surface the registry that already exists |
| Hostname binding, the connection store, entitlements | The Dashboard vertical itself + its screens |
| The audit spine (every action recorded) | Sign-up guard rails (verification, quotas, abuse) |

## 4. The authority model — the crux

Provisioning a scope, binding a hostname, granting a role, storing a connection credential are all
**platform actions**: methods on `HostAdmin`, and today the control-plane API authenticates only a
`PlatformActorId` (an operator). A customer's tenant-admin is a **principal**, not staff, and must
be able to do these — *but only inside their own tenant, never another's.* That boundary does not
exist yet, and it is the whole project.

The Dashboard-as-a-vertical gives it the right shape, in two moves the kernel already knows:

1. **Authorize in-scope, with an ordinary permission.** A Dashboard operation's first line is the
   same as any vertical's: `assertAllowed(await ctx.check('dashboard:provision-app'))`. The
   customer's owner role holds `dashboard:*`; an invited member holds a narrower subset. This is
   the *can they?* question, answered by the kernel's permission checker in the customer's scope —
   nothing bespoke.

2. **Effect through a platform authority narrowed to the tenant — a privileged seam.** The
   underlying `HostAdmin` call is made by the Dashboard as **host code**, with a platform actor
   **fixed to the caller's own tenant** (read from the dashboard scope's node). The tenant is not
   an argument the customer supplies; it is ambient, so *cross-tenant is impossible by
   construction* — the same move the #97 connector-authority seam makes ("authority is inherited,
   not re-declared"). Every effected action lands on the audit spine attributed to the customer's
   principal, not to a shared operator.

So "a tenant-admin manages only their tenant" is **not** a new check bolted onto the control-plane
API. It is: the kernel's permission model deciding *can they*, and a **tenant-narrowed platform
actor** deciding *where* — the two halves the kernel already enforces for every scope operation and
every connection.

### The privileged seam, concretely

A normal vertical cannot reach `HostAdmin` (module code gets `OperationContext`, not the
directory) and cannot cross tenants — those bans are the point. The Dashboard needs exactly what
they forbid, so it is a **privileged vertical**: its provisioning operations run as host code with
a **tenant-scoped `HostAdmin`** injected — a facade over the real `HostAdmin` that pins `tenantId`
to the dashboard scope's tenant and refuses any argument that names another. Options for where that
lives (an open question, §6): a dedicated host capability the Dashboard deployment is granted, or a
"control-plane connector" reusing the connector seam's egress + authority machinery. Either way the
safety rests on three things already true elsewhere: the permission check runs first, the tenant is
ambient not supplied, and the action is audited.

This also settles the recursion cleanly: the Dashboard vertical is *deployed once* (like Meridian),
and each customer runs a *scope* of it. The bootstrap (creating the customer's tenant + first
dashboard scope on sign-up) is the one action that cannot be tenant-narrowed — there is no tenant
yet — so it stays a controlled platform action, triggered by sign-up behind quotas and
verification, not by an arbitrary principal.

## 5. The flows

**Sign up (bootstrap).** Email/password (Better Auth, as the verticals use) → the platform creates
a tenant, a dashboard scope running the Dashboard vertical, links the login to a new owner
principal, and assigns the tenant-admin role. The customer lands in an empty Dashboard.

**Create an app.** Pick from the **catalog** (the registered, admitted verticals — Meridian,
Callout, …; entitlements decide which the tenant may instantiate) → name it → the Dashboard's
`provision-app` operation checks the permission, then provisions a **new scope in the customer's
tenant** running that vertical (control-plane `provisionInstance`, tenant pinned), activates it,
and binds a default hostname. The app appears in **My apps** with its URL.

**My apps.** A projection of the tenant's scopes (excluding the dashboard scope itself): name,
vertical, version, status, hostname — with live status if realtime is wired.

**Invite a member.** By email → creates/links a principal in the tenant → grants a Dashboard role
(and, later, roles inside chosen apps). Invitation *is* a grant; the roster is a projection of
assignments; revoke tombstones (K-21).

**Connect a provider / bind a domain / plan.** Thin operations over the connection store,
`bindHostname`, and entitlements — each authorized in-scope, effected tenant-narrowed.

## 6. Staged plan

- **M0 — the real flow (this is the walkthrough):** sign-up → tenant + dashboard scope → catalog →
  provision a Meridian app-scope → My apps + URL. Proves the bootstrap, the catalog, and the
  tenant-narrowed provisioning authority end to end.
- **M1 — team:** invite members, roles, roster (grant/revoke).
- **M2 — ops:** custom domains, connections (connect Scrive from the Dashboard), settings.
- **M3 — plan:** entitlements surfaced read-only. **Billing stays out** (control-plane.md is
  explicit) — this is only the hook.

## 7. Open questions

1. **App = scope-in-tenant, confirmed?** This doc assumes Vercel's Team→Projects → Substrat's
   Tenant→Scopes (one customer tenant, many app-scopes). The console's operator flow instead makes
   *one tenant per instance*. The Dashboard should be scope-in-tenant; the console flow is an
   operator convenience, not the customer model. Worth ratifying.
2. **Where the privileged seam lives** (§4): a new host capability granted to the Dashboard
   deployment, vs a control-plane connector. The connector route reuses #97's authority-narrowing;
   the host-capability route is more direct. Prototype both against one `provision-app` call.
3. **The catalog is registry-fed.** The version registry (`registerVertical`/`publishVersion`/
   `promoteVersion`/`bindScopeVersion`) exists in `HostAdmin` but is not exposed as API routes.
   The Dashboard catalog needs those surfaced (also fixes the console's free-text-slug field).
4. **Sign-up guard rails.** Anyone-can-create-a-tenant is the SaaS default and an abuse vector —
   email verification, per-account quotas, and a soft-provision-then-confirm path (K-31 already
   models the two-phase state).
5. **Console ↔ Dashboard sharing.** The console is the operator superset; the Dashboard is the
   tenant-scoped subset over the same control-plane surface. Shared components (Domains, Members,
   Connections views) parametrised by "all tenants" vs "my tenant" would avoid two implementations
   drifting.
6. **Does the Dashboard compose engines,** or is it a thin control-surface vertical over the
   privileged seam? Likely the latter to start; an "org" engine (members, audit-for-the-customer)
   may factor out later.
