# 13. Operating it

The last twelve chapters were how the system works and what it records. This one is how it
behaves when something is wrong, which is a different subject.

## Four surfaces, and three more

The pieces that turn "a vertical" into "a vertical serving a customer at a hostname" are four
separate deployments.

| Surface | Audience | Answers |
|---|---|---|
| [Control plane](/platform/control-plane) | the platform | the shared directory every vertical registers against — tenants, scopes, roles, entitlements, the admin log |
| [Console](/platform/console) | Substrat operators | *run the platform* — the whole fleet, every tenant, provisioning, the audit log |
| [Router](/platform/router) | inbound traffic | `hostname → (tenant, scope, surface)`, then dispatch |
| [Dashboard](/platform/dashboard) | a customer's admin | *run my org* — their tenant only |

The split that matters most is **Console versus Dashboard**: the same platform, opposite
audience and opposite blast radius. The Console is the operator's back office — all tenants,
staff SSO. The Dashboard is the customer's home — one tenant, customer sign-up. Neither is
called a "portal", which is reserved for a *vertical's* own end-user surface.

The Dashboard is itself a Substrat vertical, which is the useful kind of dogfooding: the
tenancy model either works for the platform's own product or it does not.

Its shape is worth knowing before you go looking for something in it. Each app has **four
tabs**: *Overview*, *Deployments*, *Data* and *Settings*. Anything about more than one app is a
team page in the left menu, narrowed with an app filter: *Observability* (chapter 10) and
*Audit* (chapter 11) sit under **Operate**, next to Domains, Integrations, Team and Billing under
**Configure**. The rule is deliberate: a fifth tab on the app is almost always a filter on a team
page instead.

Three more deployments sit beside those four:

- **The builder studio**: where a vertical is written with an agent, against its own workspace
  and snapshots.
- **The egress worker**: the hop every outbound call from a dispatched vertical takes, which
  enforces the version's declared allowlist (chapter 8).
- **The hosted issuer**: an OIDC provider that verticals can sign users in against. It runs as
  a vertical, with its own admin console and sign-in log, rather than as a special platform
  component, because authentication is a seam and not something the kernel owns (chapter 6).

## The lifecycle states, operationally

Chapter 2 listed them. Here is what each one *means* when you are the person deciding.

| State | Serves traffic | Data | Reversible |
|---|---|---|---|
| `provisioning` | no | being created | — |
| `active` | yes | live | — |
| `suspended` | **no**, fails closed | intact | yes |
| `archiving` → `archived` | no | intact | yes |
| `reaped` | no | **gone** | **no** |

Tenants have the parallel ladder, where `deleting` is the reversible grace state that makes
every scope beneath it inert without reclaiming anything.

Two things to internalise:

**Suspension is the live weapon.** It takes effect on the next request, because the router
does not cache routes and `getScope` re-checks the directory. When a customer must stop being
served *now*, this is the lever, and its immediacy is paid for with a directory read per
request.

**`archived` is not `deleted`.** The bytes are still there and cost money. Moving to `reaped`
is what frees them, it is irreversible, and — per chapter 9 — nothing does it automatically
unless a retention window has been configured. If your mental model is "archiving cleans up",
it does not.

## Four failures, four instruments

Backup is where people's mental models are usually wrong, because "backup" is four different
things here.

| What is lost | What covers it |
|---|---|
| A scope's data, wrongly changed | **Durable Object PITR** — ~30 days, continuous, per scope. A destructive rewind of the live app. |
| A scope, reaped | **The copy the reap takes first.** A reap is irreversible, so the control plane stores a full-fidelity dump *before any byte goes* and records its address on the admin-log entry. |
| A scope, wanted elsewhere | **`scope pull` / snapshots** — a non-destructive copy that leaves the live app alone. |
| **The directory itself** | **The scheduled directory backup.** |

That last row is the one the others cannot cover, and it is worth understanding why.

The directory is a single Durable Object. Lose it and **no scope can be found**, even though
every scope's data is sitting there completely intact. PITR does not help: PITR rewinds a
database that still exists, and having nothing to point it at is a different failure. And no
scope can rebuild the map from below, because a scope does not know its own tenancy, hostname,
or bound version.

So the control plane backs itself up: a scheduled dump of the whole directory — tenants,
scopes, hostnames, verticals, entitlements, identities, and the audit log — to an object store
outside the DO, once a day, keeping 30 copies.

Two details in that design are worth borrowing for anything similar. The cadence is derived by
reading the newest stored copy rather than from a separate timer, so a missed run is caught up
on the next pass rather than skipped. And retention is pruned only **after** a new copy lands,
so a failed backup can never be the thing that deletes the last good one.

RPO ≤ 24h, RTO ≤ 1h for a directory loss, and the restore is rehearsed rather than merely
designed — the round trip runs in the contract suite against both adapters: capture, diverge,
restore, keep serving.

**Restoring replaces.** The dump's contents *become* the directory; anything created since is
gone. A merge would silently interleave two histories of the same tenant, so replace is the
honest semantic, and the restore refuses a directory that still holds tenants unless the
request explicitly says to overwrite — a guard for the realistic hazard of a restore replayed
against a control plane that has already recovered.

What it does **not** cover, stated plainly: the backup bucket lives in the platform's own
account. This survives losing the directory; it does not survive losing the account. And a
restore does not bring back what was never in the directory — the staff roster, worker
secrets, or the key any sealed credential was sealed with.

## Where to look when something is wrong

Chapters 10 and 11 describe the instruments. What matters when something is wrong is which one
witnessed the thing you are asking about, because reaching for the wrong one is the usual
reason an investigation stalls:

| Question | Instrument | In the dashboard |
|---|---|---|
| Is it slow, or failing, for everyone? | router traffic (sampled) | Observability → Traffic, Health |
| What did this request do, and what did it print? | invocation log | Observability → Logs |
| What happened to this record, and who did it? | the outbox, via `readHistory` | the app's Data tab → a record |
| Why does this event exist? | `causedBy` | a record's event → *Why?* |
| Did the consumer ever handle it? | the delivery journal | a record's event → *What did it do?* |
| Everything this request changed | `invocation_id` | a record's event → *Same call* |
| Has this job stopped running? | sweep runs, freshness | Observability → Schedules |
| Why was this person refused? | the denial log | Observability → Flow (per-operation health) |
| Who changed this app's configuration? | the admin log | Audit |
| Who looked at this tenant's data? | the access log | no view yet: it drains to R2 (chapter 11) |
| Did the platform act on what the app asked for? | the platform-request journal | Settings → Integrations |

Add to those the sweep reports from chapter 9 (`retrying`, `deadLettered`, and per-unit
`errors`), which are the signal that background work is degrading rather than failing loudly.

## A short diagnostic index

Symptoms whose cause is rarely where you first look:

**"The deploy went green and production is unchanged."** A push is not a deploy. Check whether
the version was promoted, and whether the scope is bound to it.

**"One tenant is broken, everyone else is fine."** Very likely a failed migration on that
scope. It fails closed and serves nothing by design. The migration-reconciliation phase records
why; the scope's `migrationFailure` carries the version and the error.

**"The event fired but nothing happened."** Open the event's *What did it do?* tree, which is
the delivery journal. If the consumer is
in-scope, remember from chapter 5 that it **does not retry** — one failure is terminal for that
pair, and waiting will not fix it. If it is an executor, check `next_attempt_at`: it may be
backing off, or already dead-lettered at `maxAttempts`.

**"The app asked for something and it took a quarter of an hour."** The platform intent waited
for the sweep. The vertical is not flagging its responses, so the router never kicked a drain.
Wire `onPlatformRequests` when minting the stub (chapter 5). If the intent never settles at
all, find it in the platform-request journal (Settings → Integrations for a connector's
intents). A handler that keeps throwing leaves the intent pending for about a day and then fails
it, with the last error kept.

**"Observability shows no traffic for an app that is clearly in use."** Either the version
predates the invocation log, or the log is mounted below some routes, or it has no
`routerSecret` and verifies nothing. All three produce silence rather than an error (chapter 10).

**"Recurring work stopped."** Check the scope sweeper's roster. The alarm **lapses on an empty
roster**, and the roster is maintained by `/internal/provision` and `/internal/delete-scope`
rather than read from a directory. A scope that never called `noteScope` is not swept — which
includes every scope provisioned before its vertical wired a sweeper, until a reconcile or a
re-run provisioning notes it. And a scope on the roster can still record every run as
`failed`: a schedule an **engine** declares runs as that engine's module, so the tenant must
hold the engine's entitlement, not only the vertical's.

**"Permission denied and I do not know why."** The denial log gives the key and the node.
`explain` gives the chain. If the permission is tenant-level, remember it reaches the scope by
**projection** — and an absent projection is a deny, which is the safe direction but also a
real cause.

**"It works locally and fails deployed."** The adapters are contract-equivalent, so suspect the
things that are not module code: the router secret, a binding, an unset platform secret, a
grant that was never made. Both trust boundaries fail closed, which means the symptom of a
missing secret is a blanket refusal rather than a subtle misbehaviour. One exception sits in
module code, because it is the engine and not the adapter: a Durable Object's SQLite is
tighter than node's. It refuses a compound `SELECT` of more than 5 terms, more than 100 bound
parameters, a statement over 100 000 bytes, and a `LIKE` or `GLOB` pattern over 50 bytes. The
node adapter enforces the first three on `ctx.sql` with the Durable Object's own messages, so
a statement built from the model or from a caller's unbounded input fails in your own tests
rather than on the deployed host. The `LIKE`/`GLOB` limit is the exception: node's SQLite still
allows 50 000, and only this repository's own suites emulate the limit (a test preload), so a
long pattern built from input still passes a vertical's own tests and fails deployed. The values and how they are counted are in
[SQL limits on `ctx.sql`](/concepts/scope-host#sql-limits-on-ctx-sql).

## What is honestly not solved

Ending on the gaps, because a book that implies completeness is worse than one that names the
edges.

- **The directory is a single control-plane DO.** The tenant-root-DO plus global-D1 split is
  designed and not built. It is the obvious scaling and blast-radius question.
- **Per-jurisdiction DO ids are not built.** `eu` and `us` name guarantees whose enforcement is
  not there yet, which is why provisioning gates them. `global` is what every scope is today.
- **In-scope consumers do not retry.** Deliberate for v0, and worth re-deciding as verticals
  grow consumers that fail for transient reasons.
- **Dual-emit across a schema version is not available.** Postponed with a design, not
  abandoned — but no plan should promise a deprecation window until it exists.
- **Cross-scope reads are a fold, not a join.** Fleet-wide questions cost a read per scope.
  Projections and per-tenant D1 are the current answers, and the many-scope fan-out cost of
  permission projection for a very large tenant is an explicit open question.
- **The lake has no query gateway, no tenant scoping and no erasure.** Tier 2 is filled and
  queried by operators. A subject erased in Tier 1 still has payloads in Tier 2 until lake
  erasure is built (chapter 11).
- **Storage is not metered, and quotas are not enforced.** The platform counts installations,
  engine licences and model calls. It cannot yet say how many bytes a tenant holds, and an
  entitlement's quota is information a module may act on, not a limit the platform applies
  (chapter 12).
- **Denials and deliveries carry no invocation id**, so "same call" reaches a request's events
  but not its refusals.
- **Executors hold the scope's turn on the local SQLite adapter** and not on Durable Objects.
  The two hosts differ only under a slow connector, but they do differ.
- **Grant expiry transitions and facet recency are contract-tested on SQLite only**, because
  the DO host takes no clock. Both hosts run the same SQL; only one can be tested across the
  passage of time.

[What Substrat doesn't have (yet)](/guide/what-substrat-lacks) is the maintained version of
this list.

## Where to go next

You now have the shape. The reference is the right tool from here:

- Building something — [Getting started](/guide/getting-started), then the [todo
  walkthrough](/guide/walkthrough-todo), then [The model](/concepts/model).
- Choosing an engine — [What is an engine?](/engines/) and the five pages each one carries.
- Shipping — [Deploying a vertical](/guide/deploying) and [Environments &
  previews](/guide/environments-and-previews).
- Billing your own customers — the [metering](/engines/metering/) and
  [invoicing](/engines/invoicing/) engines.
- Operating — the four [platform surfaces](/platform/).

And if you are an agent rather than a person: [Agent rules](/guide/agent-rules) is the page to
read before writing any code, and [llms.txt](/llms.txt) is the index.

---

*That is the end of the book. [Back to the start →](/book/)*
