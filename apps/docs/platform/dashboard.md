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
| Preview deployment | **[preview](/guide/environments-and-previews)** — a version bound to a scope with data, at its own URL |
| Preview / staging *environment* | a **pinned preview + custom domain** — there is no `staging` channel, [only `prod`](/concepts/deploying#the-one-channel-prod) |

Concretely: a customer *is* a tenant; sign-up bootstraps that tenant, one **dashboard scope** (the
customer's home), and the signer as its **owner**. A customer's apps are **scopes** in that same
tenant. The dashboard scope's own operations are the account actions — every self-service affordance
in the UI is a real vertical operation whose first line is a permission check. They fall into a
handful of groups:

- **App lifecycle** — `provision-app`, `mark-app-active`, `mark-app-failed`, `list-apps`,
  `app-events`, `update-app`, `delete-app`.
- **Data & previews** — `snapshot-app`, `delete-app-snapshot`, `export-app-data`, `restore-app-data`.
- **Hostnames** — `bind-app-hostname`, `unbind-app-hostname`.
- **Environment** — `set-app-env`, `list-app-env`, `delete-app-env`.
- **Identity** — `set-app-auth`, `get-app-auth`.
- **Members & invites** — `init-team`, `invite-member`, `accept-invite`, `preview-invite`,
  `resend-invite`, `revoke-invite`, `list-members`, `remove-member`, `leave-self`, `delete-team`.
- **Connections** — `begin-connection`.

Provisioning an app is `assertAllowed(ctx.check('dashboard:provision-app'))` then a
**tenant-narrowed** `provisionScope` into the caller's own tenant: the kernel refuses a caller
without the key before anything is created, and cannot provision into someone else's tenant by
construction.

## Auth

Login is [AuthHero OIDC](/concepts/identity#two-real-choices-made-differently) through the shared
[`@substrat-run/oidc-rp`](/reference/oidc-rp) relying party. Unlike the Console's staff-roster
gate, the Dashboard does a **JIT tenant bootstrap**: a new user's first sign-in provisions their
own tenant and dashboard scope, and makes them its owner.

## The app detail: five tabs

Opening an app lands on its detail page, whose tab bar is five real nouns —
**Overview · Data · Deployments · Previews · Settings**. The day-to-day configuration surfaces
(Environment, Domains, Integrations) live as sections *inside* Settings rather than as top-level
tabs, so the bar stays short. Old `snapshots` / `env` / `domains` / `integrations` tab URLs are
aliased to their new homes, so bookmarks and in-flight links keep working.

### Overview

Real fields from the app row: the vertical, the **running version** (the version the app's scope is
actually pinned to — what the router serves, not a hardcoded label), status, created-by, scope id,
and a live activity timeline read from the app's own audit trail. A **Production** card lists one
public URL per surface the vertical fronts (K-26), each with a copy button and a *Visit*. Beside it
an **API card** surfaces the app's OpenAPI document (`/openapi.json`) and an *API docs* link into the
app's [Scalar](https://scalar.com) reference — which rides the app's own session, so you sign in to
the app first.

#### Owner seat {#owner-seat}

Next to them sits the **Owner seat** card: whether anyone has signed in to claim this instance,
read live from the app's own identity directory (the platform relays it through the vertical's
`/internal/owner-seat` route). Provisioning mints the seat **empty** — the platform knows the
principal it minted, not the login the tenant's issuer will emit — and for **15 minutes after
provision** the first person to sign in at the app's address becomes the owner. That is the
install flow, where you open the app seconds later; the card shows the deadline while it is open.
Once the window has closed, a plain sign-in claims nothing, and the card says so. Either way,
**Get claim link** mints a short-lived `/?claim=<token>` link, shown once with a copy button and
stored nowhere on the platform: open it yourself, or send it to the person who should own the
instance. Minting again retires the earlier link (the card names the outstanding one's expiry),
and a claimed seat shows its owner. An app whose vertical keeps no owner seat says that instead
of a state. The rule itself — the window, the claim, why a re-provision never re-opens a claimed
seat — is on the [vertical-auth reference](/reference/vertical-auth); the two hooks a vertical
wires to answer the card are in [Deploying](/guide/deploying#ship-it-substrat-push).

### Data

A read-only browser of the app's **own** database: the vertical's tables on one side (with the
`_substrat_*` spine grouped apart), a paged view of the selected table on the other, and a
collapsible **SQL console** for the one read-only `SELECT` the table browser can't express. Read-only
is enforced below the seam — raw writes would bypass the event log and forge invariants — and every
read is audited. Below it sits **Export & import**: *Export* downloads the app's data as a
`.dump.json` the CLI accepts (personal data redacted unless it's a staff/CLI full-fidelity export);
*Import* replaces the app's data with an uploaded dump, behind a danger dialog and always after the
platform forks a safety preview first.

### Deployments

For a customer who *builds* a vertical (not just instantiates one from the catalog), the
**Deployments** tab is the builder-facing mirror of the staff [console](/platform/console)'s
Verticals view — narrowed to the verticals **this workspace owns** (the ones it
[pushed with the CLI](/guide/deploying)). Per vertical: each version's admission state, and whether
**`prod`** — the one channel ([dev/staging retired](/concepts/deploying#the-one-channel-prod)) —
points at it. "Running" is the version this app's scope is pinned to (what the router dispatches on),
not the vertical's prod channel — they diverge when prod moves after install. A builder self-serves
`prod` promotion right here for an **owned, private** vertical; a **listed** vertical's prod promotion
is a platform decision (the marketplace gate). A non-production environment is not a second channel to
promote — it is a [preview](#previews-environments) below. Every read and promotion is checked to be
one of the caller's own verticals — the dashboard's shared-plane credential can't be turned into a
lever on another tenant's deployment. Beside promotion, a **Bind version** action pins *this* scope to
any admitted version of its vertical — the per-scope catch-up (and the primitive behind a canary or a
test environment); it carries the same *Snapshot data first* safety copy as an update.

When prod points somewhere other than where this app is pinned, **Update to latest** rebinds it. Two
safety affordances sit alongside it. A **Snapshot data first** checkbox (on by default) takes a copy
before a migration-crossing update, so a bad upgrade has a rollback point — a code-only update
snapshots nothing, because the platform compares migration digests, not the checkbox. And after a
migration, a time-boxed **Back out** offer appears while the pre-migration bookmark is inside the
window the platform honors (~24h): rewinding the whole database to just before the migration —
*discarding everything written since* — an honest first-hours backout, not a merge. For anything
older, restore a preview instead.

### Previews & environments {#previews-environments}

There are two preview surfaces, because a preview does two jobs — a **data** test copy of one install,
and a **non-production environment** for a vertical you build.

**Per-app previews** (an install's **Previews** tab) are [test copies](/concepts/snapshots) of *that
app's* data. **Create preview** forks the app's entire database into an independent copy with a
retention choice (1/7/30 days, or keep until deleted); the list shows each copy's provenance, its own
URL, and a live expiry countdown; expired copies are reaped by the platform's scheduled sweep. A
preview is unmistakably *not* the live app: it receives no traffic, integrations are off, and deleting
it is safe by construction — the platform refuses to hard-delete anything that isn't a copy. The same
machinery backs the *Snapshot data first* checkbox in Deployments (above) and the safety copy taken
before a data import. Authorization is the same key that manages apps (`dashboard:provision-app`),
checked in-scope before any platform effect; the fork itself runs inside the app's own deployment, so
[no app data crosses to the platform](/concepts/snapshots#where-the-data-goes-and-doesn-t).

**Builder environments** (on the **Deployments** side, for a vertical you *push*) are the same
primitive turned outward: a preview is a version bound to a scope with data, at its own URL, and it is
how you run every non-production environment now that [there is only a `prod`
channel](/concepts/deploying#the-one-channel-prod). From here a builder can, for a vertical they own
(private **or** listed — publishing widens who may *install*, not who may preview their own code):

- **Create a preview** of any pushed version — a fork of prod, or an `--empty` clean room for a
  vertical with no prod scope yet. The [PR-preview CI](/guide/deploying#deploy-from-ci) creates and
  updates these automatically; the list mirrors what the [`substrat preview`](/reference/cli#preview)
  CLI shows.
- **Pin a preview** (no expiry) and **attach a custom domain** to it — turning it into a long-lived
  **test environment** at a stable address like `crm-test.ahero.se`. The domain binds to the scope
  (Settings → Domains works on a preview scope too), and a merge-to-main job rebinds that scope to the
  head of `main` so the environment always runs the latest code.

The full workflow — sticky-per-PR + per-build URLs, the pinned test environment, canary rollout, and
the release candidate — is [Environments & previews](/guide/environments-and-previews).

### Settings

Configuration, not daily-driver surfaces — gathered under one tab with its own sections, each keeping
its own URL (`settings/environment` …) so deep links survive:

- **General** — rename the app, read its kind, and the danger zone (deleting an app deprovisions its
  scope for real; the audit history is retained). It also carries the **Identity** card: the
  `substrat:auth` choice made at install (which issuer the app trusts), readable and editable after
  the fact — the client secret is write-only.
- **Environment** — the former *Env* tab. Not a free-form key/value editor, but a form **generated
  from the vertical's declared [`envSpec`](/concepts/modules#declared-environment-envspec)**: each
  field carries the manifest's label, description, placeholder, and `required`/`secret` flags. The
  spec is read from the **registry** (where `registerVertical` stored it), so a pushed builder
  vertical gets a config form exactly like a builtin, without the dashboard bundling its code. Values
  are per app; secret values are **write-only** — masked, never returned by the API, left blank to
  keep. Delivery follows the app's shape: a hosted vertical reads its per-tenant config at runtime
  rather than through per-app worker secrets.
- **Domains** — custom-hostname binding (K-26 multi-surface). One scope can front several surfaces,
  and the hostname decides which surface the vertical serves. A **platform** hostname is minted from
  the app's label and is live immediately (it rides the wildcard cert); a **custom** domain lands
  `pending` and walks DNS validation + certificate issuance, going live only when `active`. The
  default hostname can't be removed here — deleting the app retires it. Backed by
  `dashboard/bind-app-hostname` / `unbind-app-hostname`.
- **Integrations** — third-party **connections** (Scrive, Fortnox), begun with
  `dashboard/begin-connection` and its signed OAuth handshake.

## Status

Built and connected — self-service sign-up bootstraps a tenant, the catalog offers a real
[Callout](/verticals/callout) entry, and provisioning runs through the tenant-narrowed control-plane
seam (an app becomes a live scope; deleting one deprovisions it for real). Most of the designed
surface is now shipped: the app lifecycle, builder **Deployments**, a read-only **Data** browser with
export/import, **Previews**, per-app **Environment**, custom **Domains**, team **members** (invite /
accept / remove / leave, with a Team view), and third-party **connections** (an Integrations view).
Billing and the plan are the main pieces still on the roadmap the
[design note](https://github.com/substrat-run/substrat/blob/main/docs/architecture/dashboard.md) lays out.
It is served as a React SPA bundled into its worker; the account menu lives in the sidebar footer.
