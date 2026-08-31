# Control plane

The **shared directory** every vertical registers against — the one deployment the whole platform
has in common. A singleton `ControlPlaneDO` (tenant registry, scope lifecycle, entitlements,
roles, identities, the append-only admin audit log) fronted by the audited
`createControlPlaneApi` HTTP surface. Verticals register their tenant/scope here; the
[Console](/platform/console) reads and acts through it; the [Router](/platform/router) resolves
hostnames against it.

Nothing domain-shaped runs here. It owns no engine, no vertical tables — only the directory. (A
module-less `ScopeDO` binding exists solely because the coordinator's `provisionScope` still
instantiates one; decoupling that is later work.)

## Where it sits

It is the concrete form of the [platform layer](/concepts/platform): the durable authority for
[tenancy](/concepts/tenancy) and, at write time, [permissions](/concepts/permissions#where-tuples-live-a-scope-reads-only-its-own-state).
Under scope-local permissions it is a **write-time** authority that projects roles and
tenant-level tuples into scopes — deliberately *off* the request hot path, so a scope never reads
it to answer a permission check.

The transport in front of the DO is [`@substrat-run/control-plane-api`](https://github.com/substrat-run/substrat/tree/main/packages/control-plane-api)
— the audited `HostAdmin` surface, the same one the CLI's deploy endpoint and the Console call.

## What it manages now

Beyond the base registry, a few capabilities have landed that are worth naming:

- **Tenant delete with a grace window.** `deleting` is a reversible, read-closed containment state that
  stamps `deletingAt`; a scheduled **grace-window sweep** ages the tenant off that timestamp and then
  `reapTenant` clears the directory PII/config rows (identities, membership tuples, roles, entitlements,
  orgs) while keeping the `tenants` row as a burned-slug tombstone and the admin log whole.
- **Reaping an archived scope's DO storage.** Cloudflare never garbage-collects a Durable Object, so
  `reapScope` (archived → reaped) wipes the scope DO's storage explicitly — an archived app stops
  costing storage only once it is reaped.
- **Entitlements delivered with provisioning.** Entitlements are per-tenant SKU flags the kernel enforces
  per operation (`manifest.entitlementKey`); a scope reads its currently-held entitlements at request
  time, and the control plane is what projects them.
- **The hosted-vertical sandbox as a positive allowlist.** A pushed vertical's declared bindings are
  checked against a positive allowlist (`ADMISSIBLE_BINDING_TYPES`) — anything not named is refused. It
  is this sandbox contract, not a staff read of an opaque digest, that lets a **private** vertical's
  version land admitted automatically (its blast radius is its own tenant).
- **Platform-mediated egress: the email relay.** The sandbox refuses *egress-shaped* bindings on
  purpose — `send_email`, `ai`, `browser`, and friends stay off the allowlist because reaching the
  outside world is a platform concern, not a per-vertical one (and a Workers-for-Platforms dispatch
  script cannot bind `send_email` anyway). So a vertical never sends mail directly. Instead it POSTs to
  the control plane's `POST /internal/email/send` **relay**, and the control plane — the one worker that
  holds an outbound-mail credential — sends on its behalf, but **only** if that vertical holds the
  staff-granted `emailSender` capability. This is the general shape for giving a hosted vertical a
  privileged capability without handing it the credential: a manifest *request* (`substrat.sendsEmail`),
  a staff *grant* (`setVerticalEmailSender`, the twin of the tenant-provisioner grant), and a
  platform-held relay that checks the grant on every call. Authentication reuses the `PLATFORM_SECRET`
  the uploader already injects into every dispatch script; the relay re-derives *which* vertical is
  calling from the named `(tenant, scope)` and checks the grant against that, so holding the shared
  secret is not enough. The `from` address is always the platform's onboarded sender.
- **Platform-mediated inference: the `AI` binding.** The one capability handed over as a real
  runtime binding rather than a relay. A vertical still cannot *declare* `ai` — the allowlist
  refuses it, exactly as above — but a version that declares `substrat.usesModels` (#1054) has
  `{ type: 'ai', name: 'AI' }` appended to its bindings by the uploader, **after** the §4 check has
  run on the declared set, and calls `env.AI` directly. Two switches gate it: the platform's own
  fleet-wide `bindAi` kill-switch and this version's declaration — so a vertical that never asked
  holds nothing, and asking is a manifest diff a human reads at admit rather than a default every
  pushed script inherits. The credential is still never the vertical's: the binding draws on the
  platform's AI account, and nothing about it lives in the bundle. The bound worth stating: a
  vertical holding the binding can call `env.AI.run()` outside the metered path.
- **Platform-mediated credential handover: the connection relay.** The inbound twin of the email
  relay. Connecting a provider (Scrive, Fortnox) is a *tenant admin's* act, so the natural place to
  paste a provider credential is the vertical's own admin screen — but a hosted vertical must never
  store one (plaintext in a scope row would ride every export, backup, and PITR window). Instead the
  vertical permission-checks the act with its own `ctx.check`, hands the secret to its harness as an
  effect stripped from the response, and the harness POSTs
  `POST /internal/connections/upsert` — `{tenant, scope, provider, secret, grants?, createdBy}` —
  to the control plane, which seals it into the connection store with the platform's `SecretBox`.
  Upserts are keyed (tenant, vertical, provider, account): a live connection is rotated **in
  place**, so its id and every permission granted to it survive — credential rotation is self-serve,
  no support ticket. The same trust derivation as the email relay applies (the shared secret never
  says *which* vertical; the platform's own scope record does), and the audit records the
  authorizing tenant principal (`createdBy`/`rotatedBy`) — metadata only, never the credential.
  Unlike the email relay there is no staff-granted capability: the tenant hands over its *own*
  credential for its *own* vertical, and the store's grant guards already pin the blast radius to
  that (tenant, vertical).

## Backup and recovery

Four different failures, four different instruments — and the useful thing is knowing which
one covers what, because only one of them is a backup in the usual sense.

| What is lost | What covers it |
|---|---|
| A scope's data, wrongly changed | **Durable Object point-in-time recovery** — ~30 days, continuous, per scope. A destructive rewind of the live app. |
| A scope, reaped | **The copy the reap takes first.** A reap wipes DO storage irreversibly, so the control plane stores a full-fidelity dump *before any byte goes* and records its address on the admin-log entry. |
| A scope, wanted elsewhere | **`scope pull` / snapshots** — a non-destructive copy that leaves the live app alone (see [Snapshots](/concepts/snapshots)). |
| **The directory itself** | **The scheduled directory backup**, below. |

That last row is the one the others cannot cover. The directory is a single Durable Object —
lose it and no scope can be *found*, even though every scope's data is sitting there intact.
PITR does not help, because PITR rewinds a database that still exists; nothing to point it at
is a different failure. And no scope can rebuild the map from below: a scope does not know its
own tenancy, hostname, or bound version.

So the control plane backs itself up. The scheduled sweep dumps the whole directory — tenants,
scopes, hostnames, verticals, entitlements, identities, *and* the audit log — to an object
store outside the DO, **once a day, keeping 30 copies**. The cadence is derived by reading the
newest stored copy rather than from a separate timer, so a missed run is caught up on the next
pass rather than skipped, and the retention window is pruned only *after* a new copy lands —
a failed backup can never be the thing that deletes the last good one.

**RPO ≤ 24h, RTO ≤ 1h** for a directory loss, and the restore has been rehearsed rather than
merely designed: the round trip runs in the [contract test suite](/reference/contract-tests)
against both the Cloudflare and SQLite adapters — capture, diverge, restore, then keep serving
through the directory that was just rewritten.

**Restoring replaces.** The dump's contents *become* the directory; anything created since the
copy was taken is gone. A merge would silently interleave two histories of the same tenant, so
replace is the honest semantic — and the restore refuses a directory that still holds tenants
unless the request explicitly says to overwrite. That guard exists for the realistic hazard: a
restore replayed against a control plane that has already recovered.

**What it does not cover.** The backup bucket lives in the platform's own account, so this
survives losing the *directory* — a bug, a bad migration, a deleted DO — but not losing the
*account*. The store is a provider-neutral seam so an off-account target is a drop-in, but as
shipped that is the honest boundary. A restore also does not bring back what was never in the
directory: the staff roster (its own D1 database), worker secrets, or the key that any sealed
credential was sealed with.

**Self-hosting note.** On the SQLite adapter there is no DO point-in-time recovery to fall back
on, so `exportDirectory`/`restoreDirectory` are not a second line of defence there — they are
the only one. Both adapters implement the same pair, and the same contract tests prove it.

## Auth posture — fail closed

Secure by default: a real `wrangler deploy` sets no dev-actor escape hatch, so every request
**fails closed (401)** until authenticated. Locally, `pnpm --filter @substrat-run/control-plane dev`
turns on `ALLOW_DEV_ACTOR` and trusts an `x-platform-actor` header as a stand-in — never mounted
in production.

Who may act is data, not config: the `staff_actor` table in D1 holds one `PlatformActorId` per
human, so the admin log can name *who* suspended a tenant. Access is revoked with a **tombstone**,
never a `DELETE` (K-21) — the row is the evidence that access was once granted, which is what an
audit asks for. An empty roster means nobody can act; fail-closed is the correct posture. The
roster also gates staff account creation, so a departed operator cannot simply re-register.

The one honest gap: staff auth is still email + password with no MFA and no SSO, on a surface that
can suspend every tenant. That is a tracked open question, not a settled design.

## Run it

```sh
pnpm --filter @substrat-run/control-plane dev     # wrangler dev, no account; ALLOW_DEV_ACTOR on
pnpm --filter @substrat-run/control-plane test    # workerd test
pnpm --filter @substrat-run/control-plane deploy   # Workers Paid plan (DO SQLite)
```
