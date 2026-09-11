# 10. Operating it

The last nine chapters were how the system works. This one is how it behaves when something
is wrong, which is a different subject.

## Four surfaces

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

Four logs, and they witness different things. Reaching for the wrong one is the usual reason
an investigation stalls.

**The outbox** (`_substrat_outbox`, per scope) records every **allowed mutation**, with the
full envelope. This is the audit trail and the timeline. Read it through `readTimeline` /
`readHistory` rather than hand-rolled SQL, because those decode the envelope and — importantly
— distinguish a `null` that is a *fact* from one that is missing data.

**The delivery journal** (`_substrat_deliveries`, per scope) records what happened to each
event per consumer. A row with an `error` is a dead letter. This is where "the invoice never
appeared" is actually answered.

**The denial log** (`_substrat_denials`, per scope) records refusals — the one moment where an
actor's intent and the permission model visibly disagree. No other log witnesses it. When a
user says "it says I can't", this names the permission key.

**The admin log** (control plane, append-only) records directory changes: who provisioned,
suspended, granted, admitted, reaped. It is the compliance witness and is **never swept**, even
when a tenant is reaped.

Add to those the sweep reports from chapter 9 — `retrying`, `deadLettered`, and per-unit
`errors` — which are the signal that background work is degrading rather than failing loudly.

## A short diagnostic index

Symptoms whose cause is rarely where you first look:

**"The deploy went green and production is unchanged."** A push is not a deploy. Check whether
the version was promoted, and whether the scope is bound to it.

**"One tenant is broken, everyone else is fine."** Very likely a failed migration on that
scope. It fails closed and serves nothing by design. The migration-reconciliation phase records
why; the scope's `migrationFailure` carries the version and the error.

**"The event fired but nothing happened."** Check the delivery journal. If the consumer is
in-scope, remember from chapter 5 that it **does not retry** — one failure is terminal for that
pair, and waiting will not fix it. If it is an executor, check `next_attempt_at`: it may be
backing off, or already dead-lettered at `maxAttempts`.

**"Recurring work stopped."** Check the scope sweeper's roster. The alarm **lapses on an empty
roster**, and the roster is maintained by `/internal/provision` and `/internal/delete-scope`
rather than read from a directory. A scope that never called `noteScope` is not swept.

**"Permission denied and I do not know why."** The denial log gives the key and the node.
`explain` gives the chain. If the permission is tenant-level, remember it reaches the scope by
**projection** — and an absent projection is a deny, which is the safe direction but also a
real cause.

**"It works locally and fails deployed."** The adapters are contract-equivalent, so suspect the
things that are not module code: the router secret, a binding, an unset platform secret, a
grant that was never made. Both trust boundaries fail closed, which means the symptom of a
missing secret is a blanket refusal rather than a subtle misbehaviour.

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
- **Grant expiry transitions are contract-tested on SQLite only**, because the DO host takes no
  clock. Both hosts run the same predicate; only one can be tested across the transition.

[What Substrat doesn't have (yet)](/guide/what-substrat-lacks) is the maintained version of
this list.

## Where to go next

You now have the shape. The reference is the right tool from here:

- Building something — [Getting started](/guide/getting-started), then the [todo
  walkthrough](/guide/walkthrough-todo), then [The model](/concepts/model).
- Choosing an engine — [What is an engine?](/engines/) and the five pages each one carries.
- Shipping — [Deploying a vertical](/guide/deploying) and [Environments &
  previews](/guide/environments-and-previews).
- Operating — the four [platform surfaces](/platform/).

And if you are an agent rather than a person: [Agent rules](/guide/agent-rules) is the page to
read before writing any code, and [llms.txt](/llms.txt) is the index.

---

*That is the end of the book. [Back to the start →](/book/)*
