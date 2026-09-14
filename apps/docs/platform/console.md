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
- **Scopes** — the fleet of provisioned scopes and their status. A scope's detail page
  carries its **Denials** panel — the refusals that scope recorded (K-35), bucketed per
  (actor, permission) first so a probing client's volume cannot push a quiet actor off the
  screen, with the rows as the drill-down behind one bucket.
- **Verticals** — the registered vertical versions, including the ones pushed by
  [`substrat push`](/guide/deploying). A **listed** vertical's pushes land **pending** and are
  admitted here; a **private** vertical's pushes land **admitted automatically**.
  See [the deploy model](/concepts/deploying). Each version's **Outbound** column
  shows the third-party hosts it *declared* ([D-46](/platform/control-plane)) beside the
  ones it was *observed* reaching, with the sampling window stated every time — the admit
  decision is about the difference, and an absent host is not proof it was never called.
- **Create instance** — the catalog → provision flow: pick a vertical, pin it to a version,
  provision a scope for a tenant.
- **Domains** — hostname bindings the [router](/platform/router) resolves.
- **Observability** — the fleet view: per-service invocation metrics and recent logs, read over the
  control plane's provider-neutral observability seam. Tier-3 numbers — sampled, approximate, never
  money — so everything is a rate or a latency, nothing an exact count.
- **Permissions** — the permission surface (keys → roles) read back from the directory.
- **Admin log** — the append-only audit trail, every entry named to the `PlatformActorId` that
  caused it, with a JSON diff of what changed.

Those are the **documented Fleet** views — the state of the world. A second nav group, **Operations**, is
what the platform could *not* do: durable rows the admin log deliberately does not hold, since
it audits successful mutations and a failure changed nothing. A red day is one click there, not
a filter recipe over Fleet.

- **Failures** — every operational failure the platform recorded, read over `/ops-failures`.
  The page narrows by tenant (a picker), by vertical and by upstream reference (both exact),
  and a text box filters the loaded rows by operation, message or scope. The failure records
  include the operation, and, when known, its stage, origin, taxonomy code and HTTP status. It also carries
  the upstream
  `reference = <id>` when one was extracted, so the handle a CI log prints
  resolves to something on our side — and copies out for a provider support ticket, the only
  place a redacted storage fault's reference actually resolves. A vertical's failures strip
  jumps here pre-narrowed to that vertical.
- **Issues** — the same failures grouped by fingerprint (operation + stage + taxonomy code) into
  counted defects with a lifecycle, read over `/issues`: one row per fingerprint with a rising
  count, not one row per retry. Staff give a verdict — **resolve**, **ignore** or **reopen**
  (`PUT /issues/status`); a fresh arrival after resolve flips the row to *regressed*, and ingest
  respects an ignore. Each row links to its exemplar failure rows. The page narrows by status
  (a picker: all, new, regressed, resolved, ignored) and a text box filters the loaded rows by
  operation, code, message or vertical.
- **Sweeps** — the fleet's sweep record, read over `/sweep-runs`: every connector poll, every
  schedule fired or skipped and every freshness verdict, newest first. The page narrows by
  tenant, kind and outcome (pickers) and by unit (exact — `scopeId:operation` or a connection
  id), and a text box filters the loaded rows by unit, operation, event type or error. It is the staff twin of the dashboard's per-app strips — where a
  tenant sees their own connection, staff see the whole fleet's units on one page, so "the
  Tuesday cron never ran anywhere" reads at a glance rather than as a per-tenant tour. Rows
  are kept for 14 days.

## Auth

Login is [AuthHero OIDC](/concepts/identity#two-real-choices-made-differently) through the shared
[`@substrat-run/oidc-rp`](/reference/oidc-rp) relying party, then a **staff-roster lookup** — only
a `PlatformActorId` on the control plane's `staff_actor` roster gets in. The session proves who you
are; the roster decides whether you may act.
