# Control plane design

**Status:** partly implemented. Implements plan decision 30; kernel design log K-20.
§4.1 (tenant record), §4.2 (scope lifecycle, minus hostnames), §4.3 (entitlement store), and
§4.4 (`PlatformActor` + admin audit log) are **shipped on both adapters and covered by
contract tests**. §4.5's permission diff shipped its **build-time half** outside the console
(`tools/permission-diff.mts` → checked-in `demos/*/PERMISSIONS.md`, CI-diffed) — see §4.5.

The **directory read side** now exists — `listScopes`, `getScopeRecord`, `listRoles`, and a
filtered/paged `auditLog` — which is what the console needed and what §3.2's "only complete
inventory" claim required to be true at all. `packages/control-plane-api` is the audited HTTP
surface over `HostAdmin` (§4.5), and `apps/console` is the console: tenants, the fleet scope
directory, lifecycle, entitlements, the admin log with before/after diffs, and the review
queue over runtime permission changes.

§4.6's **staff access log** is decided (K-24) and not yet built — reads remain
unaudited until it lands (#43).

§4.7's **hostname map and router** are built: the directory data and its lifecycle in
both adapters, and `apps/router` — the environment-wide worker that resolves a hostname
and dispatches over a service binding. The staff actions are on the audited HTTP surface and in
the console's **Domains** view, and the console's per-scope portal link now reads the
scope's canonical hostname instead of a `VITE_PORTAL_BASE` env var. Hostname
**provisioning** is now built (#305): binding a custom domain drives the Cloudflare for
SaaS custom-hostnames API through `pending → verifying → active|failed` — DNS-record
issuance on bind, and a scheduled reconcile pass that polls validation + cert state (no
more setting `active` by hand). A PLATFORM hostname under a base domain we control still
rides the wildcard and skips issuance. Registrable-suffix (PSL) isolation is enforced at
bind (`@substrat-run/psl`), so a custom domain that is a bare public suffix is refused.
The `verifying` state and the `custom_hostname_id` / `validation_records` columns are
the issuance record. Also still unbuilt: §5's meters; **capability-grant enumeration** — a grant is a tuple in the
scope's own database, so listing them needs §5.4's admin-query RPC, unlike roles which are
directory-local (this is the sharpest remaining consequence of §7's "no back door into scope
DBs"); and **four-eyes approval**, which §6 says the action list should settle — the action
list is now real (kernel open question 14). §2's "the tenant does not exist" finding is
**historical** — it is what this document caused to be fixed; it is kept because the argument
for the shared layer still reads from it.
**What this is:** the **shared platform layer that N per-vertical deployments sit on** —
the tenant registry, scope lifecycle, entitlements, custom hostnames, the audited admin
surface, and the console over them. Plus what is deliberately *not* built: billing.

Read alongside [kernel-design](kernel-design.md) §3.2 (directory), §3.3 (provisioning
lifecycle), §5.4 (operating the scope fleet), §5.5 (deployment topology), and
[master-plan](../master-plan.md) §9 (the four meters).

---

## 1. The frame: one platform, N deployments

§5.5 pins **one kernel-runtime deployment per vertical** — separate DO namespaces,
separate code, per-vertical blast radius and versioning. It is tempting to read that as
"every vertical replicates the platform." It does not, and the distinction is the whole
design:

| Layer | Shared (kernel-owned) | Per-vertical |
|---|---|---|
| Routing | Router worker resolves `hostname → (tenant, scope, vertical)` (§5.5) | — |
| Custom domains | Cloudflare for SaaS: custom-hostnames API, DNS validation, cert lifecycle — part of **scope provisioning** | — |
| Tenancy | Tenant registry, scope directory, provisioning lifecycle | — |
| Identity | Auth callbacks, principal derivation, capability minting (D-16) | — |
| Entitlements | The store; the module-load gate (D-20) | The `entitlementKey` each manifest declares |
| Analytics / history | Outbox → Pipelines → Iceberg; Tier 2 (§5.3) | — |
| Admin | This document: console, audit log, admin-query RPC | — |
| **Execution** | — | **The scope-DO class**: kernel + engines + that vertical's modules, and their migrations |

Everything a vertical would hate to rebuild is already shared. The *only* per-vertical
thing is the code that executes inside a scope. **The DO class is the app binary; the
platform beneath it is one platform.** The router already returns a `vertical` — multi-
vertical is designed in, not bolted on.

**The control plane is that shared layer.** Not an admin screen with a database behind it —
the layer that makes N independently-versioned, independently-owned vertical deployments
behave like one product. Orchestrating those N deployments (open question 9) is therefore
not a footnote to this design; it is the thing the design is *for*.

### 1.1 Why the deployments do not merge

Collapsing the N scope-DO classes into one shared deployment buys a single deploy to
operate. Rejected, on the layer it would damage:

- **Migrations become globally ordered across unrelated verticals.** Every scope would
  carry every vertical's modules, and module registration order is already a migration-
  ordering contract. A change to vertical B's migration list would touch vertical A's
  scopes.
- **Blast radius merges.** A bad deploy of B's module code takes down A's scopes — the
  exact property §5.5 splits deployments to keep.
- **Versioning goes lockstep**, and this is the disqualifying one. A shared binary means
  every vertical upgrades together — but per §9's ownership map, verticals are owned by
  *different companies*. Forcing one company's vertical to upgrade because another shipped
  is push-upgrade-across-a-fleet-you-don't-control: §7.8 and open question 12 name it as
  *the most documented failure mode across every platform ecosystem studied*. Adopting the
  Odoo/SAP treadmill to save operating a deployment is a bad trade.

The coherent counter-design is a shared bundle where the entitlement store registers only
the relevant vertical's modules per scope. It is not stupid — it is how ordinary
multi-tenant SaaS works — but it converts a **structural** guarantee into a **config**
guarantee, the move this codebase refuses everywhere else (K-8 bans the raw DO namespace
binding rather than trusting vertical code not to use it; K-3 fails closed rather than
trusting the caller). It also puts every vertical's code in every isolate, against a real
Workers bundle ceiling as engines accumulate.

**A third shape exists, and this section predates it.** Durable Object facets (Dynamic
Workers, open beta) would allow *one supervisor loading N independently-versioned vertical
bundles per scope* — which is not the shared bundle rejected above, and dodges all three
objections: migrations stay per-facet, code blast radius stays split across worker versions,
and each bundle pinning its own engine versions makes per-vertical upgrade cadence
structural rather than incidental. It is not adopted, and the argument above stands for now
— but the reasoning is "one bundle with everything compiled in is wrong," not "N deployments
is the only answer." See [generated-verticals](generated-verticals.md) §6.3, which is where
the pressure to revisit will come from, and §3.2 there for why facets do *not* buy
untrusted-vertical safety.

## 2. The finding this starts from

**The tenant does not exist.** §3.2 specifies the directory as "the **only** complete
inventory of tenants and scopes, and the input to reconciliation, migration sweeps,
billing, and ops." What is implemented is the *scope* half of that sentence. There is no
`tenants` table in any adapter: a tenant is a foreign-key string on scope rows and a
subject in tuples. The `tenant` schema in `packages/contracts/src/tenancy.ts` — slug, name,
status, createdAt — is parsed by nothing and persisted nowhere. You create a tenant by
provisioning a scope with a ULID nobody has used before.

The hole runs through the whole shared layer:

| Designed | Implemented |
|---|---|
| Tenant registry (§3.2) | — nothing; tenant is an FK string |
| Lifecycle `provisioning → active → suspended ⇄ active → archiving → archived` (§3.3) | `provisionScope` only; `status` exists, nothing transitions it |
| Entitlements gate module loading (D-20); `manifest.entitlementKey` on every module | The field is declared and **read by nothing** |
| Audited admin-query RPC in an ops console (§5.4, plan §6) | `HostAdmin` — five methods, no caller identity, no record |
| Active-scope billing meter (§9; §3.3 "keeps the meter honest") | No meter, and nothing ever leaves `active` |
| Hostname → (tenant, scope, vertical) map as directory data (§5.5) | — |

The console is not a feature on a finished kernel. It is what forces the shared layer that
a year of decisions already specified to actually get built. The UI is the cheap half.

## 3. What can be a vertical, and what cannot

The admin's two halves have different answers, and conflating them was an error worth
naming.

**The effecting half cannot be module code.** Provisioning, suspend, archive, entitlement
flips, hostname issuance, the admin-query RPC — these mutate the directory and reach into
*other deployments'* DO namespaces. Module code cannot do this and should never be able
to: a vertical's app worker holds exactly one privileged binding, a service binding to its
own kernel entrypoint, and **never a raw DO namespace binding** (K-8). An admin vertical
would run in its own deployment, in its own DO namespace, and would have no addressable
path to another vertical's scopes. It is not *dangerous* — it is **impotent**. Granting it
the path means building the out-of-band control plane anyway, with extra steps.

**The record-keeping half can be a vertical**, and probably should be, eventually. The
tenant registry, plan and contacts, staff roles, and the admin action trail are ordinary
scope-shaped data. A "platform tenant" scope would get the outbox (audit for free),
the tuple engine (staff permissions, and the permission-diff checkpoint on real
machinery), and migrations — from the kernel, rather than reimplemented beside it. The
tell that this is right: §4.4 below proposes an append-only admin log, stamped
platform-side with actor/action/target, which the caller cannot forge. *That is
`_substrat_outbox`.* Rebuilding the kernel's audit mechanism next to the kernel is a smell.

The bridge between the halves is a pattern the plan already owns — **D-18's triage rule:
effects on the outside world are connectors.** The control-plane vertical emits
`tenant.provision_requested`; a privileged executor outside module code consumes it, acts
through the host admin surface, and emits the result back. Module code still never obtains
a cross-tenant stub, so K-3 and K-8 are untouched.

**That executor is now built** (K-22 §4.2, #61), for membership rather than
provisioning: `host.registerExecutor(id, eventType, handler)`, dispatched inline after
commit with the outbox as the retry backstop, and stamping `causedBy` on every admin row
it writes so the split trail joins. Provisioning would be a second registration on the
same mechanism, which is what "not a one-off" meant.

**Sequencing, honestly.** The split is more elegant, it dogfoods, and the dogfooding is a
sales asset. It is also more moving parts: provisioning becomes async (compatible — §3.3
already requires idempotent and journaled — but *suspend-for-incident* being async is worse
than a synchronous call); the audit trail splits across the vertical's outbox and the
executor's log and needs correlation; and there is a bootstrap chicken-and-egg (who
provisions the platform tenant's scope? an out-of-band seed — trivial, but real). Against
that, the hand-rolled audit log the split would save is perhaps fifty lines.

So: **build the effecting half out-of-band now** — there is no alternative — and treat
record-keeping-as-a-vertical as a sequenced option, taken when the platform tenant holds
enough data to earn a deployment. Decide it at the second vertical, which is also when
open question 9 stops being theoretical. What must *not* happen is writing "the admin is
never a vertical" into the log: it is false, and it forecloses the dogfooding.

**Taken (D-31, [membership.md](membership.md)).** The trigger fired earlier than this
section predicted, and for a different reason: self-service, not accumulated data. The
effecting/record-keeping line above is unchanged; what moved is that membership, invites
and plan-shaped entitlements turn out to be engines with two consumers (the admin and
every hosted vertical), and that membership is not reachable from module code at all —
see membership.md §4 for the kernel seam that blocks it.

## 4. What gets built

### 4.1 The tenant record

A `tenants` table in the directory, persisting the `tenant` contract that already exists.
`createTenant` becomes a real idempotent control-plane operation instead of a side effect
of minting a ULID.

`status: active | suspended | deleting | reaped` acquires meaning: `suspended` fails `getScope`
for every scope under the tenant — fails closed, the same path as K-3 — which is what makes
non-payment or an incident containable without deleting anything. `deleting` and `reaped` are
the tenant delete lifecycle; see §4.8.

### 4.2 Scope lifecycle

Implement the §3.3 transitions that exist only on paper: `suspend`, `unsuspend`, `archive`,
`unarchive`. Two properties carry over from the design doc and must not be quietly softened:

- **Un-archive is a restore, not a flag flip.** §3.3 says so, and §9's meter depends on it:
  if archiving is free to reverse, "active scope" is not a number anyone can charge on.
- **Jurisdiction is immutable** — fixed at provisioning (K-7). The console displays it and
  offers no edit affordance.

Hostname provisioning (custom-hostnames API, DNS validation, cert lifecycle) is part of
this lifecycle, per §5.5 — it is control-plane work, and the `hostname → (tenant, scope,
vertical)` map is directory data the router reads.

#### A reap leaves a recoverable copy ([#493](https://github.com/substrat-run/substrat/issues/493))

`reapScope` is the one lifecycle step with no undo: it frees the scope's Durable Object
storage — Cloudflare never garbage-collects a DO, so an archived app's bytes persist
forever otherwise — and the row survives only as a tombstone. Before #493 the copy that
made that survivable was **the operator's job to remember**, taken from a different
surface, which is a guarantee only for as long as nobody is in a hurry.

So the copy moved into the route. `POST …/scopes/:s/reap` writes a **full-fidelity dump**
to a platform-held store *before any byte is wiped*, and records its address on the
reap's admin-log entry (`after.backupRef`, `null` when none was taken — "nobody backed
this up" is a fact the witness states, not one an operator infers). The ordering is the
whole guarantee: a store that throws aborts the reap with the scope intact, answered as a
`502` that says so rather than a bare 500.

Three decisions worth not re-litigating:

- **A dump, not a snapshot fork.** The cheap move — fork the scope before reaping — fails
  the case the flow exists for. `orchestratedSnapshot` provisions the fork *inside the
  vertical's own deployment* and activates it, so its bytes live in the very deployment a
  retirement is about to delete, and it counts as a live scope in `countScopesForVertical`
  — re-blocking the `deleteVertical` the reap was clearing. A dump leaves the deployment,
  and `POST …/restore` already loads one back, so export → store → restore is the round
  trip that closes.
- **Full fidelity, never masked.** The `GET …/export` route masks by default because it
  hands bytes to a *caller* (§6's governed pull). A backup goes platform→platform and is
  never handed out, so the masking default does not apply — and a masked dump restores a
  structurally-valid but factually wrong scope. A backup that cannot restore is a false
  promise, and the promise is the point.
- **The tenant reap defaults the other way.** §4.8 is partly an Art. 17 erasure path, so
  `POST /tenants/:t/reap` takes **no** backup unless staff explicitly ask: silently writing
  a customer's data into a bucket the reap does not clear would defeat the request it was
  made to satisfy. Retiring a tenant and erasing one are different acts, and the default
  should be the safe one for each.

Asking for a backup where the platform has **no** store configured is refused (`501`),
never silently skipped — the console always asks, so a control plane deployed with the
bucket unbound fails loudly instead of quietly dropping the guarantee. Retention of the
stored copies is indefinite for now and belongs to
[#36](https://github.com/substrat-run/substrat/issues/36)'s retention decision;
jurisdiction-pinned scopes are refused outright until a per-jurisdiction store exists
(K-32), because the reap must not wipe what the platform may not legally copy.

### 4.3 The entitlement store

D-20 says entitlements gate module loading, and every manifest declares an
`entitlementKey`. Nothing reads it, so the SKU model is a promise with no mechanism.

Build the smallest thing that makes the declaration true: an entitlement set per tenant in
the directory, checked at module load. A module whose key is not held does not register —
its operations do not resolve, exactly as if it had never been registered (the same shape
as manifest `withdraws`). Granting an entitlement is a control-plane action; it is the
point of the console.

Open: whether the check sits on the hot path of every module load or is cached in scope DOs
with event invalidation — kernel-design open question 5. Building the store is what forces
it. Start simple (check at load, no cache); let a benchmark decide.

**Widened by [#33](https://github.com/substrat-run/substrat/issues/33): the flag expresses a
plan.** A grant carries `expiresAt`, `quota`, `plan`, and `grantedAt`/`grantedBy`. Per D-33
these describe the *builder's* subscription (the paying customer), measured in the tenants
underneath. Only expiry is enforced here: an expired grant fails closed at the gate exactly
as if revoked — evaluated lazily at check time like tuple expiry, never swept, and the row
stays listed so a lapsed trial reads as lapsed rather than never-granted. Quota and tier are
expression only; counting usage against them is the builder portal's job (§5's meters).
Grant calls are PATCH-shaped: an omitted field preserves what the row carries (a bare
re-grant on an idempotent provisioning path must not quietly turn a trial perpetual), an
explicit null clears it, and any effective change is a renewal audited with before/after.

**Read at request time, without the CP binding ([#304](https://github.com/substrat-run/substrat/issues/304)).**
Gating module loading is not the same as letting a running vertical *read* its plan: a hosted
vertical needs `quota`/`plan`/`tier` at request time to gate a feature or enforce its own quota,
and it may not hold the forbidden `CONTROL_PLANE` binding. Entitlements are therefore **projected
into each scope** alongside roles/tuples (scope-local-permissions.md): `ctx.entitlement(key)` /
`ctx.entitlements()` read the projection locally (a console-managed scope reads it over the same
RPC the permission checker uses), and the per-operation gate fails closed against the projected
view. A grant/revoke fans out to invalidate. This is **open question 5's answer** — cached in
scope DOs with event invalidation, the same project-on-write mechanism §4 (below) says to settle
once for both the entitlement check and the routing/suspension cache, not to answer twice.

### 4.4 The platform actor and the admin audit log

The one thing that must not be retrofitted. Every control-plane mutation:

- takes a **`PlatformActor`** — an opaque authenticated subject, **typed distinctly from a
  tenant `PrincipalId`** so the compiler refuses to confuse them (a platform actor is not a
  principal in any tenant);
- writes an **append-only audit row**, stamped platform-side with actor, action, target
  `(tenantId, scopeId?, vertical?)`, before/after, timestamp — never supplied by the caller.

Same argument as K-4, and the reason the kernel is trusted at all: a surface that can act
without a durable record of who acted is worse than no surface. (If §3's record-keeping
vertical lands, this log *becomes* that scope's outbox rather than a second mechanism.)

`HostAdmin`'s five existing methods (defineRole / assignRole / grant / grantToOrg /
addMember) move behind this actor-taking, audited surface. Their current signature — no
caller, no record — is a v0 stopgap the code comment already admits.

One invariant this log carries alone, worth naming: grant tuples persist no `grantedBy` —
the tuple table stores `(subject, relation, object, expires_at, revoked_at)` and nothing
else — so the admin log is the **only witness** of who granted what, and effective grant
provenance exists exactly as long as every grant write flows through this audited surface.
Any future write path that touches tuples without landing here (a scope-local mint, a
migration backfill) silently destroys provenance; per §4.2's algebra rule, that is a
decision-log event, not a patch.

**Retention: the admin log is never swept ([#36](https://github.com/substrat-run/substrat/issues/36)).**
Because it is the sole witness of grant provenance (above), and because Tier-2 directory
history is kept indefinitely for bokföringslagen (kernel-design §5.3), the admin log has **no
TTL and no retention sweeper** — a decision, not a gap. Its only cost is unbounded growth, and
the mitigation is a bound on *reads*, not on the record: the HTTP read surface (`GET /admin-log`)
**defaults** a page size rather than dumping the whole table, and `nextCursor` still walks the
entire log (ULID order is chronological, so the last row's id is the cursor). The in-process
`auditLog(filter)` stays deliberately unbounded — an internal caller that wants everything asks
for everything; a silent cap there would let a truncated page pass for the whole log. When a
tenant is reaped (§4.8) its scope data and PII directory rows are destroyed, but its admin-log
rows are **kept** — the witness of what was done to that tenant must outlive the tenant.

**The admin-log read pattern is now the platform-wide list convention** (contracts
`pagination.ts`): every GET list route on the control-plane surface — tenants, scopes,
verticals, versions, channels, channel history, hostnames, roles, the admin log — accepts
`limit` (default 20, max 200) + `cursor` (+ `order` where the walk direction is meaningful)
and returns `{ entries, nextCursor }`, keyset over the list's own sort key. `nextCursor` is
the last entry's key when the page came back full, `null` when short (the walk is done).
The same two-layer rule holds everywhere: kernel `HostAdmin.list*` reads stay unbounded
unless a page is passed (internal enumerate-everything callers — sweeps, catalogs,
reconciliation — must never mistake a page for the inventory); only the HTTP egress
defaults a page. Dashboard list routes (`/api/apps`, `/api/apps/:id/deployments`,
`/api/apps/:id/events`, …) follow the identical shape.

### 4.5 The console

Thin, over the above. In build order:

1. Tenant list; tenant detail (scopes, entitlements, status, **which vertical** each scope runs).
2. Create tenant; provision scope; suspend / archive.
3. Entitlement grants.
4. **Roles and grants — the permission diff** (the *runtime* half; see below).
5. Read-only history: the admin audit log; per-scope events via §5.4's admin-query RPC.
6. Fleet view: per-vertical deployment versions, migration status, scopes-behind counts —
   the §5.4 "fleet questions never fan out" surface, answered from the directory index.

**The permission diff is the sleeper feature** — and it split in two once built.

The **build-time half shipped first, without the console and without a kernel change**:
`tools/permission-diff.mts` renders `demos/*/PERMISSIONS.md` from each vertical's exported
`MODULES` + `ROLES`, checked in and CI-diffed with `--check`. It turns out roles are
tenant-agnostic constants and manifests are exported consts, so the whole artifact is a pure
function of code — nothing to boot, and therefore no ULID to launder out of the output. It is
also the **first instance of D-22/D-29's emit → check-in → CI-diff pipeline**, which both
decisions describe in the present tense and neither had built; OAS and event-schema emission
plug into the same convention.

Plan decision 39 gives the build-time artifact a **runtime home**: the deploy manifest
carries the registry itself (keys + descriptions, role templates, entity-grant shapes)
beside the `digests.permission` hash that already committed to that exact content.
Per-version and immutable — stamped at push, so it cannot drift from the bundle — which
lets admission render a mechanical version-to-version permission diff and lets any
tenant-facing surface (the dashboard's permissions view) display the declared surface
without a hardcoded copy. Deliberately *not* a mutable "current permissions" table (a
second source of truth for a code-declared fact) and *not* a self-describe endpoint on
running verticals (a build-time fact should not be a runtime question). On an
opaque-bundle push the registry is pusher-claimed exactly as the digest is
(self-serve-deploy.md §3) — verified only under the controlled build.

That leaves the console the **runtime half**, which the artifact structurally cannot cover:
capability **grants** (per-principal, per-entity, minted with random ULIDs — only their
declared *shapes* are in the artifact) and **operator-defined roles** (created against a live
deployment, never in provisioning code). Rendering those is exactly what D-23's proof paths
were built to power ("explain / view-as / the reviewable permission diff").

So the argument for the console is now narrower and more honest than "the checkpoint has no
home". It has one; CI goes red on an unreviewed change to shipped role design. What the
console adds is the surface for permission state that *only exists at runtime* — and turning
"someone should read this diff" into "someone clicked approve".

Plan §6 already lists the ops console as **build, internal first** — registry/tenant health,
migration and reconciliation status, billing state, and consented, audited support
impersonation. This is that line item.

### 4.6 The staff access log (K-24)

§4.4 records who **changed** the directory. It does not record who **read** it, and
until #42 there was no point: every operator shared one actor, so a read log would have
said "someone" four thousand times.

With per-person actors real, reads get their own log — `_substrat_access_log`, holding
actor, method, the tenant/scope asked about, a bounded parameter summary, and the
**result count**.

**Where it lives:** the directory, in the ControlPlaneDO's own SQLite, beside the admin
log — the same store, because it is the same kind of fact about the same data. Not D1
(that is Better Auth's store and the staff roster, an app concern), and not the outbox
(that is per-scope, for domain events).

**Why not in the admin log:**

| | admin log | access log |
|---|---|---|
| records | mutations | reads |
| is | permanent evidence | operational history |
| lifetime | append-only, forever | drains to Tier 2, then prunes |

One table would force one retention policy on both. The stricter would win, so read
noise would be kept forever *and* would bury the mutation rows an auditor came for.

**All reads, not a curated subset.** "Who enumerated every tenant" is what an incident
asks, and a subset decides in advance which reads will not matter. Reading the access
log is itself logged.

`result_count` is what makes a row worth keeping. *"Called listScopes"* is navigation;
*"enumerated 4,000 tenants"* is an incident, and only the count tells them apart.

**Denials land here too (K-35).** `assertAllowed` throws `PermissionDenied` and, until
this, nothing recorded it — a refused call left no row in any log, because both
`recordAdmin` and `recordAccess` run only on the success path. A denial is
attacker-influenceable volume (a probing client mints unlimited rows), which is exactly
the retention argument above: operational history, not permanent evidence, so it belongs
beside reads — rate-bucketed per actor/key/window if volume demands — and never in the
admin log. Denials raised inside scope operations are deferred (they need a path to this
directory-side log, or a scope-local twin that drains); the control-plane surface, where
the log already lives, goes first.

#### Hot storage is not retention

The log ships with a **`drained_at` marker**, and only drained rows are pruned.

Pruning purely on age would destroy evidence while calling itself a retention policy —
if the window is 90 days and an auditor asks about March, the answer is gone. That is
the failure K-21 rejected for tuples, one layer up.

So the DO window bounds **storage**, and the record's **lifetime** belongs to Tier 2.
The precedent is the outbox, which carries `drained_at` for exactly this reason (§5's
meters note it is written nowhere yet — the column exists ahead of the sink, which is
the point).

**Until the Tier-2 sink exists, the window *is* the retention.** That is a stated
limitation of this design, not a policy anyone chose, and it is the thing to fix first
if a compliance commitment needs longer.

**Volume is not the pressure.** These are staff reads — a handful of operators, thousands
of rows a day rather than millions, which a singleton DO absorbs comfortably. The
pressure is **duration**: an append-only log with no drain grows forever in a store that
cannot be sharded. That argues for the marker, not against the DO.

**The §7 bound stays.** There is no admin-query RPC into scope databases, so this covers
directory metadata and never tenant business data. The exposure being closed is the
directory — adding logging must not be the moment that limit quietly widens.

### 4.7 The router and the hostname map (K-26)

§4.2 provisions a scope. Nothing yet gives it a URL, so "validate it works in
production" has nowhere to point — the console fakes it with a `VITE_PORTAL_BASE`
env var. This is what #31 step 4 builds.

**One router for the whole environment.** A kernel-owned worker resolves
`hostname → (tenant, scope, vertical, surface, region)` from directory data and
dispatches to the vertical's worker.

The map half is built: `bindHostname` / `setHostnameStatus` / `setHostnameIssuance` /
`listHostnames` on `HostAdmin`, and `resolveHostname` — which takes **no actor and is not
logged**, the same machine-path carve-out `resolveIdentity` gets (K-24), because it runs
once per request. It resolves only `active` bindings, and deliberately does **not**
re-check suspension: `getScope` owns that, and a second enforcement point is a second
thing that can disagree.

The **issuance** half is built too (#305). A custom-domain bind no longer stops at a
`pending` row a human flips: the control plane calls Cloudflare for SaaS
(`custom_hostnames`) through an injected `CustomHostnameProvisioner` seam — created on
bind (→ `verifying`, with the DNS records the tenant must publish stored on the row), and
polled by a scheduled reconcile pass (`reconcilePendingHostnames`) to `active` or
`failed`. The seam is injected like the WfP uploader, so the transport package holds no
Cloudflare credential and the builder never holds one (D-34). A PLATFORM hostname minted
under a base domain we control (`PLATFORM_BASE_DOMAINS`) rides the wildcard cert and is set
`active` on bind — no per-hostname CF call. Binding is guarded by the vendored Public
Suffix List (`@substrat-run/psl`): a custom domain that is a bare public suffix (`co.uk`,
`pages.dev`) is refused, because a cookie on it would span tenants (D-35). Absent a SaaS
zone (dev / self-host), a custom bind records `pending` and issuance simply does not run.

Not one router per vertical: cert and DNS lifecycle in one place means a new
vertical gets custom domains for free instead of repeating the Cloudflare for SaaS
dance. And **not one per jurisdiction** — see residency below.

This does not erode D-30, and it is worth saying why, because a shared component in
front of every vertical resembles the shortcut D-30 rejects. That shortcut is one
DO class per customer's code, which forces lockstep engine upgrades across verticals
owned by different companies. A router forwards; deployments stay separate.

#### `surface` — a scope can front two apps

§5.5 specified `hostname → (tenant, scope, vertical)`. One hostname per scope is
already wrong: the shop serves a **storefront** and a **back office** from one scope,
and RallyPoint a **player app** and a **manager console**. Same data, different
audience and chrome — the split is deliberate and it is not a second source of truth.

So the map says which app answers. Adding that once hostnames are issued and DNS
records exist is the retrofit `OrgId` and the identity key already paid for.

#### The trust boundary

Vertical workers get **no public route** — only a service binding from the router.

Otherwise the router's assertion of `(tenant, scope)` is a header, and anyone who can
reach the worker directly can forge it. There is precedent: the Callout worker
already reaches the control plane by service binding rather than public URL.

Built, with one addition the design did not originally call for: the router also
presents a **shared secret** (`x-substrat-router`), which the vertical verifies through
`readRoutedNode` in the kernel.

The no-public-route rule is the real boundary, but it is a *deployment fact*, and
`workers.dev` is on by default — so "only the router can reach this worker" is one
forgotten toggle away from false, and the consequence is total: a forged tenant header
reads another tenant's data. The secret makes the boundary hold in code even when the
configuration slips. Belt and braces, where the failure is silent and unbounded.

The router **strips every inbound `x-substrat-*` header** before setting its own —
by prefix, not by name, so a header added later is covered by default.

A vertical with no router in front (a single-tenant box, or `wrangler dev`) sets
`STANDALONE=true` and serves its own node. That is deliberately a *separate* flag from
`ALLOW_DEV_HEADER`: that one lets any caller be any principal, and wanting a standalone
deploy should not mean switching on impersonation.

#### Residency is configuration, not topology

A router per jurisdiction is the intuitive answer and the wrong one. Cloudflare
covers both halves without deploying anything per region:

| Half | Mechanism | Granularity |
|---|---|---|
| Processing, TLS termination | **Regional Services** ("Regional Hostnames") | per hostname |
| Storage, execution | **DO jurisdiction** (`eu` / `us` / `fedramp`) | fixed at id creation (K-7) |

Hostname is already the key the router indexes on, so `region` is one more column
rather than a second topology.

**Refined by K-30, after getting this wrong once.** The paragraph above is right that
residency is configuration rather than router topology. It was wrong about where the
configuration attaches. **TLS terminates before any of our code runs**, so nothing the
router knows can move it — the hostname is the only lever, and a region carried in the
map cannot influence termination that already happened.

Regional Hostnames accepts wildcards ("wildcards are supported for one level"), so:

| | Hostname | Regional config |
|---|---|---|
| Default | `<slug>.eu.substrat.run` | one wildcard `*.eu.substrat.run`, set once |
| Custom | `app.acme.com` | per hostname, inside the Cloudflare-for-SaaS onboarding |

Two configs cover every tenant instead of one API call each. That is not just less work:
a per-hostname call necessarily happens *after* the hostname resolves, leaving a window
where an EU tenant's TLS terminates outside the EU. A wildcard exists before any tenant
does, which removes the window rather than sequencing around it.

The cost is that a two-level hostname is beyond Universal SSL, so this **requires
Advanced Certificate Manager**.

**Verticals deploy per jurisdiction; the router does not.** Bindings are per-deployment,
so `substrat-fsm-eu` holds an EU D1 and opens EU-jurisdiction DOs — a worker that
*cannot* reach US storage beats one that chooses not to, the same reasoning as the
router having no `SCOPE` binding. The router stays single because it is stateless and
holds nothing regional; `verticalFor` keys on `(slug, region)`.

The router **rejects a request whose hostname region contradicts its scope's
jurisdiction**. That is an integrity check between the edge configuration and the
directory — two systems that can drift — not a second enforcement point re-deciding
something `getScope` owns.

Two things this forecloses:

- **Workers KV has no jurisdictional storage restriction**, so it is not available as
  the cache for the router's per-request directory read — caching a hostname's route
  there would place residency-bound directory data in a globally-cached store. The
  disqualifier is the store's missing residency guarantee, not a binding ban: a
  regionalized worker *can* bind KV, and Regional Services regionalizes execution and
  TLS termination without extending to a worker's outgoing subrequests. **(Corrected
  2026-07-31, K-36:** the original "KV cannot be used with Regional Services" over-read a
  "not supported" compatibility-matrix cell into a hard prohibition.**)** Open question 5
  inherited a stronger corollary — that the read therefore cannot be cached *at all* —
  which **K-36 retires**: D1 (`eu`/`fedramp`, 2025-11-05) and DO (`eu`/`us`) jurisdictions
  are residency-safe cache stores KV lacked, so a jurisdiction-pinned D1 replica of the
  hostname map or per-jurisdiction cache DOs is available for the hot path. What open
  question 5 still owns is *freshness*, not residency: any route cache must invalidate the
  instant a tenant is suspended (§7).
- **D1 carries residency through a `jurisdiction`, never a location hint.** A
  jurisdiction is a hard constraint and restricts read replicas to it; a hint is
  explicitly best-effort. This answers kernel-design open question 7.

Two costs, stated:

- **Regional Services is an Enterprise add-on.** The EU-residency claim carries a
  plan dependency, which belongs in D-32's cost model rather than in a procurement
  conversation.
- Cloudflare logs a `DurableObjectId` outside its jurisdiction for billing and
  debugging. The ID design already anticipated this — `contracts/src/ids.ts` requires
  ids to encode nothing precisely because of it.

The contract currently allows `jurisdiction: 'eu' | null`. Cloudflare offers `us` and
`fedramp` too; widening is additive when a customer needs it.

**Consequences for the code, not yet built** (K-30): `hostnameRegion` widens beyond
`'eu'`; `bindHostname` derives the region from the scope's jurisdiction rather than
accepting it as an independent input, so the two cannot disagree; `verticalFor` keys on
`(slug, region)`; and `demos/callout`'s single `AUTH_DB` becomes per-jurisdiction —
today one database holds Better Auth identities for every tenant regardless of their
scope's jurisdiction.

#### Two things this defers

**Hostname provisioning is scope lifecycle, not a string.** The custom-hostnames API,
DNS validation and certificate issuance are states a scope passes through (§4.2), not
a column someone sets — now built as `pending → verifying → active|failed` driven by the
`CustomHostnameProvisioner` seam and the reconcile pass (#305, §4.7 above).

**Cache invalidation gets open question 5's answer, not a second one.** Routing puts
the directory on the request hot path, so a cached route that keeps serving a
suspended tenant blunts what §7 calls "a live weapon". That is the same tension as
the entitlement check — hot path or cached with event invalidation — and it should be
settled once, for both.

### 4.8 Tenant delete lifecycle ([#36](https://github.com/substrat-run/substrat/issues/36))

The tenant analogue of the §4.4 scope reap. Before this, `deleting` was a dead status —
written once (a dashboard team-delete) and never consumed, so a tenant marked for deletion
kept every byte forever. The lifecycle closes that:

```
active ──delete──▶ deleting ──(grace window / staff "reap now")──▶ reaped   [terminal tombstone]
  ▲                   │
  └──── un-delete ────┘   (restore during the grace window)
```

- **`deleting` is a reversible grace state.** It is an ordinary `setTenantStatus` transition
  (not a distinct action — like suspend, its before/after status is the record), so it fails
  `getScope` closed for every scope, exactly like `suspended`. Entering it stamps `deletingAt`;
  leaving it (an un-delete → `active`) clears it. **No data is reclaimed here** — the scopes are
  merely inert, and the tenant restores whole. Deliberately *not* eager: the tenant gate already
  makes the scopes fail closed, so archiving them on entry would only make the reversal harder.
- **`reaped` is terminal.** Every scope is reaped (§4.4's storage wipe, per scope) and the
  tenant's PII/config directory rows — identities and identity pools, membership tuples, roles,
  entitlements, orgs — are cleared. The `tenants` row is **kept as a tombstone** (burned slug +
  audit history) and the admin log is **kept whole** (§4.4's retention decision). Irreversible:
  only a `deleting` tenant may be reaped, and `reaped` never returns to `active`. `reapTenant` is
  the tenant-level analogue of `reapScope` and is directory-side only — the per-scope byte-wipe
  runs above the kernel (a hosted scope's DO is CP-less), so the caller reaps every scope first,
  then clears the directory.

**Keep vs clear.** The line is the same one the §4.4 scope reap draws, lifted to the tenant:
destroy the data (scope storage) and the PII/config (identities, tuples, roles, entitlements,
orgs); keep the *witness and the burned name* (the `tenants` row + the admin log). A reaped
tenant reads like a missing one at the gate but is still visible as a tombstone in the console.

**Two ways to reap**, both staff-gated and both riding one seam:

1. **Reap now** — `POST /tenants/:t/reap`, refused unless the tenant is `deleting` (409). The
   console arms it with the same type-the-slug gate the scope reap uses. Skips the grace window.
2. **The grace-window sweep** — `runPlatformSweep`'s tenant-reap phase reaps any `deleting`
   tenant whose `deletingAt` is older than `TENANT_RETENTION_DAYS` (the tenant counterpart of
   `SCOPE_RETENTION_DAYS`). **Opt-in and unset by default** — the reap is irreversible, so a
   deployment must name a window before the sweep ever destroys a tenant; a null `deletingAt`
   (marked before the column shipped) is never auto-reaped. The default reaper composes the
   scope-reap seam (archive-if-needed → wipe each scope's DO in its vertical deployment →
   `reapScope`), so the control plane's orchestrated per-scope wipe applies here for free.

**Not tenant export.** GDPR Art. 20 portability (a full-tenant dump across scopes + directory
rows) is a separate piece; the per-scope `exportScope` seam it builds on already exists (§5.4's
admin-query RPC, `GET …/scopes/:s/export`).

### 4.9 Directory backup and restore ([#40](https://github.com/substrat-run/substrat/issues/40))

Everything above protects one tenant's world. This protects the map that makes every tenant
addressable — and §7 already named the stake without resolving it: *the directory becomes a
real database, with its own migrations and backup story… losing it is losing the platform, not
losing a cache.*

**Three jobs, and only one of them wants a scheduled backup.** The scope-level ones are
already answered, better, by mechanisms that are not this:

| Job | Instrument | Status |
|---|---|---|
| Operational rollback of one scope | DO SQLite PITR (~30 days, continuous) + `rewindScope` | Built. **Strictly better than a daily copy — scheduled per-scope backups are deliberately not built.** |
| Survive a reap | The copy the reap takes first (§4.4, [#493](https://github.com/substrat-run/substrat/issues/493)) | Built |
| Portability / escrow / DSAR | On-demand `exportScope`, a few times a year | Separate ([#36](https://github.com/substrat-run/substrat/issues/36)) |
| **Losing the directory itself** | **This** | **Built** |

PITR protects against corruption *inside* a database. It cannot answer for the directory,
because the directory is a single Durable Object: a control-plane bug that deletes it outright
leaves nothing to point PITR at, and no scope knows its own tenancy, hostname or bound version
well enough to rebuild the map from below.

**The mechanism.** `exportDirectory` is a logical row-dump of the whole directory — tenants,
scopes, hostnames, verticals, entitlements, identities, *and the audit spine* (a directory
restored without its history cannot say what the platform did before the restore). The
platform-sweep cron calls `backupDirectoryIfDue` last in each pass, after the phases that
mutate the directory, so a copy is of a settled directory rather than one mid-sweep.

- **Cadence: one copy a day.** Enforced by reading the newest stored copy, not by a second
  trigger — so the quarter-hourly cron takes one per day, a missed tick is caught up on the
  next pass (late, never never), and the schedule needs no durable state of its own.
- **Retention: 30 copies**, matching the DO PITR horizon so the two defences expire together
  instead of leaving a window covered by neither. Pruned only *after* a successful capture: a
  failed backup must never be the thing that deletes the last good copy.
- **RPO ≤ 24h, RTO ≤ 1h** for a directory loss. The RPO is the cadence. The RTO is the
  runbook below, which is minutes of work plus deploy time; it is stated as an hour because it
  includes noticing.

**What this does and does not cover.** The bucket lives in the platform's own Cloudflare
account, so it survives *losing the directory* — a bug, a bad migration, a deleted DO — but
**not losing the account** (billing suspension, account compromise). That is an honest limit,
not an oversight: the `DirectoryBackupStore` seam is provider-neutral precisely so an
off-account target is a drop-in when that risk is worth paying for.

**Restore is a REPLACE, not a merge.** The dump's contents become the directory, and anything
created since the copy was taken is gone — a merge would silently interleave two histories of
the same tenant. The dangerous case is therefore not a slip of the fingers but a *replayed*
restore against a control plane that already recovered, so `POST /directory/restore` refuses a
directory that still holds tenants unless the body says `overwrite: true`. An empty directory —
the actual disaster — needs no such ceremony.

**Runbook.** Rehearsed in the contract suite against both adapters (capture → diverge →
restore → keep serving), which is what turns this from a claim into a procedure:

1. `GET /api/directory/backups` — what is held, newest first. This is also the answer to *is
   the backup actually running?*, and the reason the routes 501 rather than answering an empty
   list when no store is bound: "nothing held" and "nobody is looking" must not read alike.
2. `GET /api/directory/backups/:capturedAt` — pull the dump to disk if you want it off-platform.
3. `POST /api/directory/restore` with `{ capturedAt, overwrite }`. The directory is replaced,
   the schema is re-asserted forward (a copy taken before a directory migration is carried to
   the running code's shape, never rolled back to the old one), and the restore is audited as
   `restoreDirectory` in the log it just replaced.
4. **Then re-check what the directory does not hold.** A restored directory brings back the map;
   it does not bring back what was never in it, and a recovery that stops at step 3 is only
   partly done:
   - **The staff roster is in D1** (`AUTH_DB`, `staff_actor` — §4.4/#42), deliberately outside
     the directory DO. A directory restore does not restore who may sign in; that database has
     its own backup story (Time Travel), and recovering into a *new* deployment means pointing
     at it or re-seeding it.
   - **Worker secrets are not data.** `PLATFORM_SECRET`, the OIDC client config, `CF_API_TOKEN`,
     `SESSION_SECRET` — none live in the directory, so a recovery into a fresh worker re-puts
     them (`scripts/secrets.mjs`). A restored directory in front of a worker missing
     `PLATFORM_SECRET` looks healthy and provisions nothing.
   - **Sealed rows need their key.** Anything a deployment stored through a `SecretBox` (the
     `_substrat_connection_secrets` shape) restores as ciphertext, readable only with the same
     key that sealed it — so key rotation and directory restore have to be reasoned about
     together, or you recover rows you cannot open.
   - **Scope data is untouched by all of this.** It lives in the verticals' own Durable Objects,
     which is exactly why restoring *the map* is a different and much smaller act than restoring
     the world.

## 5. Billing: meter, do not bill

**No billing system, no payment rail, no invoicing in v1.** Instead: make the meters that
are honestly computable *honest*, and display them.

- **Meter 1 (base fee: per tenant + per active scope)** is a `COUNT` over the directory once
  `status` actually transitions — which §4.2 delivers. Free. Ship it as a number.
- **Meter 2 (per-engine licensing)** becomes computable the moment §4.3's entitlement store
  exists: entitlement flags *are* the SKUs (§9). Also free.
- **Meter 3 (usage: Tier-2 events retained, storage GB, API calls)** is **not** computable.
  `_substrat_outbox` is per-scope-database, so any cross-tenant aggregate needs the Tier-2
  fan-in sink that does not exist yet; reads emit nothing, so API-call volume is unmeterable
  from the spine *by construction*; and `drained_at` is declared but written nowhere in the
  repo, so a metering consumer has no cursor to resume from.
- **Meter 4 (network transactions)** needs the cross-tenant order flow (§5.4, plan §8.4),
  which does not exist.

The rule: **a meter you cannot compute is not a pricing decision, it is a data-pipeline
project.** §9's four meters are a commercial design, correctly made in advance; three of
them sit downstream of infrastructure still on the roadmap. Build the two that fall out of
work you are doing anyway, show the numbers, and let the first invoice wait until someone is
actually paying — at which point the pricing conversation will have facts in it.

## 6. Auth: the sequencing

**Identity does not gate building this.** The data model — tenant record, lifecycle,
entitlement store, audit log — needs to know *that* there is an actor, not *how* it
authenticated. §4.4's `PlatformActor` is that seam: implement it now, run a dev stub behind
it locally, and the whole control plane is buildable and testable without touching identity.
D-16 already commits to identity being a swappable adapter; this is that being cashed in.

Two consequences:

1. **Real auth gates *exposing* the console, not *building* it.** Nothing with cross-tenant
   reach goes anywhere non-local on a stub. The demo's `x-principal` header
   (`demos/callout/src/server.ts`) is a dev affordance; a super-admin on top of it is a
   liability, not a milestone.
2. **Platform-staff auth is a different regime from tenant-user auth.** Staff: SSO, MFA, no
   self-service signup, short sessions, a small closed population, plausibly its own IdP
   tenant. Tenant users: the authhero path, self-service, org membership. Two jobs; only one
   is on this critical path.

Inverting the order means designing the admin's auth before knowing what the admin *does* —
and the actions decide the auth. Whether destructive actions (suspend, archive, entitlement
revocation) need four-eyes approval is a real question that changes the session and approval
design, and it is unanswerable until the action list is real. Build the actions; let them
specify the gate. (Kernel-design open question 14.)

## 7. Consequences and risks

- **Open question 9 is now the center, not a footnote.** The control plane orchestrates N
  per-vertical deployments: engine-version upgrades across verticals owned by different
  companies (§7.8, open question 12), migration sweeps, reconciliation, and the fleet view.
  This document builds the *directory-side* control plane. The *deployment-side* one — who
  runs an engine upgrade across verticals, and what revalidates vertical-declared substates
  and custom fields against a new engine version — is the next hard problem and is **not**
  answered here.
- **The directory becomes a real database**, with its own migrations and backup story. Today
  it is an incidental index; after this it holds the tenant registry, the entitlement store,
  the hostname map, and the admin audit log. Losing it is losing the platform, not losing a
  cache. §3.2's reconciliation (tenant-root authoritative, global index a projection) stops
  being a paragraph.
- **`boundary-lint` is unchanged.** The control plane is not module code — it never receives
  a `ctx`, never runs in a scope's serialization domain. It must not acquire a back door into
  scope DBs: the only sanctioned path is §5.4's audited admin-query RPC, and that should be
  lint-visible.
- **Suspension is a live weapon.** Tenant `status: suspended` failing `getScope` closed is
  correct, and is also a one-click outage for a paying customer. It needs the audit log and,
  plausibly, the four-eyes question above.
