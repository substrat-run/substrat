# Console

The **operator console** — where Substrat staff run the fleet. It answers one question:
*run the platform.* A React SPA served by the [control-plane](/platform/control-plane) worker,
acting through the same audited `HostAdmin` surface every other client uses, gated by staff SSO.

It is the *operator* surface, not the customer's. The [Dashboard](/platform/dashboard) is the
customer's home (one tenant, self-service); the Console sees **all** tenants and the whole fleet.
Same platform, opposite audience and blast radius.

## What it shows

The views map onto the directory the control plane owns:

- **Tenants** and **Tenant detail** — the registry, and a drill-down into one tenant's scopes,
  members, and lifecycle.
- **Scopes** — the fleet of provisioned scopes and their status.
- **Verticals** — the registered vertical versions, including the ones pushed by
  [`substrat push`](/guide/deploying) that are **pending admission**. Admitting a version here is
  the human gate that lets a scope bind and serve it.
- **Create instance** — the catalog → provision flow: pick a vertical, pin it to a version,
  provision a scope for a tenant.
- **Domains** — hostname bindings the [router](/platform/router) resolves.
- **Observability** — the fleet view: per-service invocation metrics and recent logs, read over the
  control plane's provider-neutral observability seam. Tier-3 numbers — sampled, approximate, never
  money — so everything is a rate or a latency, nothing an exact count.
- **Permissions** — the permission surface (keys → roles) read back from the directory.
- **Admin log** — the append-only audit trail, every entry named to the `PlatformActorId` that
  caused it, with a JSON diff of what changed.

## Auth

Login is [AuthHero OIDC](/concepts/identity#two-real-choices-made-differently) through the shared
[`@substrat-run/oidc-rp`](/reference/oidc-rp) relying party, then a **staff-roster lookup** — only
a `PlatformActorId` on the control plane's `staff_actor` roster gets in. The session proves who you
are; the roster decides whether you may act.
