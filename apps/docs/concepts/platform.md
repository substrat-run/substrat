# The platform layer

A Substrat vertical is not a SaaS product that happens to share some libraries. It is an
application deployed **onto a platform** — and the platform below it owns tenancy, routing,
custom domains, identity, entitlements, and the event history tier. This page is about that
layer: what it gives you, what it deliberately does *not* share, and why the boundary falls
where it does.

::: info Status
The platform layer is specified in full and implemented in part. Shipping today in the
pure-SQLite adapter: **scope provisioning**, the **directory**, the **tenant registry**,
**tenant + scope lifecycle transitions** (with fail-closed gating), the **entitlement
gate**, and the **host admin** surface — every mutation of which takes a platform actor and
writes an append-only **audit log**. Everything marked *(planned)* below — custom-domain
routing and the ops **console** UI — is designed and not yet built. This page marks the
difference rather than blurring it.
:::

## One platform, N deployments

Each vertical gets **its own kernel-runtime deployment**, hosting that vertical's scopes.
Different verticals are separate deployments with separate storage namespaces. It's tempting
to read that as *every vertical re-erects the whole platform*. It doesn't — and the split
between what's shared and what isn't is the design:

| | Shared — the platform owns it | Per-vertical |
|---|---|---|
| **Routing** | Resolves `hostname → (tenant, scope, vertical)` *(planned)* | — |
| **Custom domains** | Hostname issuance, DNS validation, certificate lifecycle — part of scope provisioning *(planned)* | — |
| **Tenancy** | Tenant registry, scope directory, provisioning lifecycle | — |
| **Identity** | Auth callbacks, principal derivation, capability minting | — |
| **Entitlements** | The store and the module-load gate | The `entitlementKey` each manifest declares |
| **History & analytics** | The event spine and its history tier | — |
| **Admin** | Directory, audit log; ops console *(planned)* | — |
| **Execution** | — | **The scope's code**: kernel + engines + your modules, and their migrations |

Everything a vertical would hate to rebuild is already shared. The only per-vertical thing
is *the code that runs inside a scope*.

> **The scope's code is the app binary; the platform beneath it is one platform.**

So building a second vertical does not mean standing up a second Substrat. It means shipping
a second binary onto the same substrate — new modules, new vocabulary, new screens, against
the same tenancy, the same permission model, the same event spine, the same domains
machinery.

## Why the deployments don't merge

The obvious follow-up: if the platform is shared anyway, why not run every vertical's modules
in **one** deployment and let entitlements decide which are active per scope?

It's a coherent design — it's how ordinary multi-tenant SaaS works — and it is rejected, for
one reason that dominates the others:

- **Migrations would be globally ordered across unrelated verticals.** Every scope would
  carry every vertical's modules, and module registration order is a
  [migration-ordering contract](/concepts/modules). A change to *another* vertical's
  migration list would touch *your* scopes.
- **Blast radius would merge.** A bad deploy of someone else's module code would take down
  your scopes.
- **Upgrades would go lockstep.** A shared binary means every vertical upgrades together —
  so you could not stay on engine v2 while another vertical moves to v3. Verticals on
  Substrat are often owned by *different companies*. Forcing one to upgrade because another
  shipped is the forced-upgrade treadmill that has degraded every extensible business
  platform that tried it.

The shared-bundle alternative also trades a **structural** guarantee for a **configuration**
guarantee — isolation would hold because the entitlement config says so, rather than because
nothing is addressable. Substrat consistently refuses that trade: vertical code never gets a
raw handle to the storage namespace, it gets a
[capability stub](/concepts/scope-host) for one scope, so cross-scope access isn't *denied* —
it's *unreachable*.

## Scope lifecycle

`provisioning → active → suspended ⇄ active → archiving → archived`

Provisioning is idempotent and journaled, safe to re-run and safe to drive from a
reconciliation sweep ([Tenants & scopes](/concepts/tenancy)). Provisioning requires an
existing **active tenant** — a scope can never be orphaned. The rest of the lifecycle is
control-plane work; every transition is validated (an illegal one fails closed) and audited:

- **Suspend** fails `getScope` closed for every scope under the tenant. It's how an incident
  or a non-payment is contained without deleting anything — the same fail-closed path that
  stops a confused-deputy bug.
- **Archive** exports the scope's storage and releases it, keeping the registry row and the
  event history forever. **Un-archive is a restore, not a flag flip.**
- **Jurisdiction is immutable.** Fixed at provisioning; a scope's execution domain can never
  relocate. There is no edit affordance because there is no edit.

## Entitlements gate modules, not features

Every [manifest](/concepts/modules) declares an `entitlementKey`. The platform holds a set of
entitlements per tenant, and checks it **when a scope invokes an operation** — default-deny,
uncached today (a DO-cached variant is an open benchmark).

A module whose key the tenant does not hold **does not register** — its operations simply do
not resolve, exactly as if the module had never existed. This is the same mechanism as a
manifest `withdraws` declaration, and it is deliberately blunter than a feature flag: there
is no half-loaded engine, no operation that exists but refuses, no code path where an
unlicensed invariant is half-enforced. A tenant either has the work-order engine or does not
have it.

That bluntness is what makes the *load gate* safe to enforce at the boundary rather than
sprinkled through business logic.

**The flag also carries a plan.** Since #33 an entitlement is not only an on/off SKU: it
carries a `plan` — `quota`, `expiresAt`, and a `tier` — that a vertical reads at request time
through `ctx.entitlement(key)` / `ctx.entitlements()` to gate features and enforce quota
*within* a module it already holds. So entitlements are the load gate **and** a
feature/plan surface — the earlier "not a feature flag" line was too absolute. The kernel
enforces two things itself: presence (the load gate above) and **expiry**, which fails closed
at the gate exactly as a revoke would; `quota` and `tier` are expression only — the vertical
reads the number and enforces its own meaning. For a **hosted** vertical these are read from a
**scope-local projection**, so gating a feature needs no control-plane binding. It is the same
mechanism as the load gate and, like it, **uncached today** (a DO-cached variant is the open
benchmark).

## Why the admin console isn't a vertical

Substrat's admin surface — provisioning scopes, suspending tenants, granting entitlements —
runs **outside** the module system, and this is worth understanding because it's a good test
of whether the isolation story is real.

A super-admin, by definition, acts across every tenant. So: could you just build it as a
vertical, with the platform as its own tenant?

**No — and not because it would be dangerous. Because it would be inert.** A vertical's code
reaches data through exactly one path: a capability stub for one `(tenant, scope)` pair that
the kernel minted for it. It holds no handle to the storage namespace and no way to name a
scope it wasn't invoked for — including, in production, scopes belonging to *other verticals'
deployments*, which it cannot address at all. An admin vertical would sit there with no way
to reach the thing it exists to manage. To give it that reach you'd have to build a
privileged out-of-band path — which is the control plane, arrived at by a longer road.

This is the isolation guarantee doing its job on its own author. The interesting half:
*record-keeping* about tenants — who they are, which plan, what staff did — is ordinary
scope-shaped data, and can perfectly well be a vertical on Substrat like any other. It's
*acting* across tenants that cannot be.

## What this means for you

- **Don't build tenancy, domains, audit, or identity.** They're below you. Verticals that
  rebuild them are a smell that the kernel drew a line wrong. Authentication in particular is
  a swappable edge adapter — see [authentication &amp; identity](/concepts/identity).
- **Your scopes carry your code only.** Your migrations are ordered against your modules and
  the engines you depend on — never against a stranger's vertical.
- **You upgrade on your schedule.** Per-vertical deployments exist so that engine versions,
  migrations, and blast radius stay yours.
- **Declare an `entitlementKey` and mean it.** It is the unit at which your module is sold,
  licensed, and switched off.

See [Tenants & scopes](/concepts/tenancy) for the entities and addressing model, and
[Modules & the manifest](/concepts/modules) for what a deployment is made of.
