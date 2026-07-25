# Dashboard

*"Vercel, but for Substrat."* The **tenant-facing self-service surface** — where a customer's
admin runs **their own** org. Sign up, get a tenant; provision apps (vertical instances) into it;
manage members, domains, connections, and the plan. Seeing only their own tenant, gated by
customer sign-up, not staff SSO.

It is the counterpart to the [Console](/platform/console): the Console is the operator's back
office (all tenants, run the platform); the Dashboard is the customer's home (one tenant, run my
org). Same platform, opposite audience and blast radius.

## The bet: the Dashboard is itself a Substrat vertical

The load-bearing decision is that the Dashboard is **built as a Substrat vertical** — the platform,
dogfooded on itself — which is what makes the hard part (authorization) fall out of the kernel
instead of being re-invented. The Vercel analogy maps almost one-to-one:

| Vercel | Substrat |
|---|---|
| Team / account | **Tenant** |
| Project | **Vertical instance** — "Acme HR" is a Meridian instance |
| Deployment / version | a registered **vertical version** bound to a scope |
| Environment | **Scope** — a tenant holds several |
| Team members | **principals + role assignments** |
| Domains | **hostname bindings** |
| Integrations | **connections** (Scrive, Fortnox) |
| "New Project from a template" | **create instance** (catalog → provision) |
| Preview / staging data | **[snapshot](/concepts/snapshots)** — a test copy of an app's data |

Concretely: a customer *is* a tenant; sign-up bootstraps that tenant, one **dashboard scope** (the
customer's home), and the signer as its **owner**. A customer's apps are **scopes** in that same
tenant. The dashboard scope's own operations are the account actions — `dashboard/provision-app`,
`dashboard/list-apps`, `dashboard/mark-app-active`, `dashboard/delete-app` — each a real vertical
operation whose first line is a permission check. Provisioning an app is
`assertAllowed(ctx.check('dashboard:provision-app'))` then a **tenant-narrowed** `provisionScope`
into the caller's own tenant: the kernel refuses a caller without the key before anything is
created, and cannot provision into someone else's tenant by construction.

## Auth

Login is [AuthHero OIDC](/concepts/identity#two-real-choices-made-differently) through the shared
[`@substrat-run/oidc-rp`](/reference/oidc-rp) relying party. Unlike the Console's staff-roster
gate, the Dashboard does a **JIT tenant bootstrap**: a new user's first sign-in provisions their
own tenant and dashboard scope, and makes them its owner.

## Deployments

For a customer who *builds* a vertical (not just instantiates one from the catalog), the
**Deployments** tab is the builder-facing mirror of the staff [console](/platform/console)'s
Verticals view — narrowed to the verticals **this workspace owns** (the ones it
[pushed with the CLI](/guide/deploying)). Per vertical: each version's admission state, and
which channel points where. A builder self-serves `dev`/`staging` promotion right here;
`prod` is shown read-only, because production promotion and admission stay a platform decision
(model B). The tenant is ambient from the session, and every read and promotion is checked to
be one of the caller's own verticals — the dashboard's shared-plane credential can't be turned
into a lever on another tenant's deployment.

## Snapshots

Each app has a **Snapshots** tab — [test copies](/concepts/snapshots) of the app's data.
**Create test copy** forks the app's entire database into an independent copy with a retention
choice (1/7/30 days, or keep until deleted); the list shows each copy's provenance and a live
expiry countdown; expired copies are reaped by the platform's scheduled sweep. A copy is
unmistakably *not* the live app: it receives no traffic, integrations are off, and deleting it
is safe by construction — the platform refuses to hard-delete anything that isn't a copy.

The same machinery backs the **"Snapshot data first"** checkbox (on by default) next to
*Update to latest* in the Deployments tab: an update whose migrations changed takes a copy
before the rebind, so a bad upgrade has a rollback point. A code-only update skips the copy —
the platform compares migration digests, not the checkbox.

Authorization is the same key that manages apps (`dashboard:provision-app`), checked in-scope
before any platform effect; the fork itself runs inside the app's own deployment, so
[no app data crosses to the platform](/concepts/snapshots#where-the-data-goes-and-doesn-t).

## App configuration (the Env tab)

Each app has an **Env** tab for its environment/configuration. It is not a free-form key/value
editor — it is a form **generated from the vertical's declared [`envSpec`](/concepts/modules#declared-environment-envspec)**:
each field carries the manifest's label, description, placeholder, and `required`/`secret`
flags. A vertical opts in by declaring `envSpec`; one that declares nothing shows no fields.
The spec is read from the **registry** (where `registerVertical` stored it), so a pushed
builder vertical gets a config form exactly like a builtin, without the dashboard bundling its
code.

Values are stored per app and authorized by the same grant that provisions apps
(`dashboard:provision-app`). Secret values are **write-only**: masked, never returned by the
API, and left blank to keep. Delivery to the running app follows the app's shape — a hosted
vertical (one shared script across many tenants' scopes) reads its per-tenant config at runtime
rather than through per-app worker secrets.

## Status

Built and connected — self-service sign-up bootstraps a tenant, the catalog offers a real
[Callout](/verticals/callout) entry, and provisioning runs through the tenant-narrowed control-plane
seam (an app becomes a live scope; deleting one deprovisions it for real). Builders manage their
pushed verticals in the Deployments tab (above). It is served as a React SPA bundled into its
worker. The full designed surface (members, domains, connections, billing) is the roadmap the
[design note](https://github.com/substrat-run/substrat/blob/main/docs/design/dashboard.md) lays
out; provisioning, the app lifecycle, and builder deployments are the parts that exist today.
