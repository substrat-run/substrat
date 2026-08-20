---
status: built
layer: plan
description: The untrusted trust model and the sandbox contract.
---

# Self-serve vertical deploy — the untrusted trust model

**Status:** foundation **built** (§7.1 / §8) — `substrat push` + the deploy endpoint land a
pending version that admission gates; the `substrat` CLI (`packages/cli`) ships it and Callout
deploys through it. The untrusted-builder models B/A (§3) remain design. Extends
[orchestration](orchestration.md), whose
Phases 1–3 are the **platform-owned** (trusted-author) deploy: *we* build and upload *our*
verticals. This doc is the piece orchestration.md §9 and
[generated-verticals](../strategy/generated-verticals.md) §1 deferred: letting a **builder** (D-33's
paying customer) deploy *their own* vertical through the dashboard (`apps/dashboard`) with a
`substrat push` CLI — which means running code we did not write.

The governing constraint is unchanged and non-negotiable
([generated-verticals](../strategy/generated-verticals.md) §1):

> It never gains a path into a production isolate that CI has not admitted.

A push is therefore allowed; a push that *serves* without admission is not. This doc is
about what "admitted" can even mean when the author is untrusted.

---

## 1. The flow, and the one thing that makes it hard

```
substrat push ─▶ deploy endpoint ─▶ WfP namespace ─▶ pending version ─▶ admission ─▶ serve
  (builder)       (platform-held      (isolated       (deploymentRef    (the gate)    (bound
                   CF credential)      execution)       set, not live)                 scope)
```

Every box except one is mechanical and already designed (orchestration.md): the push lands a
**pending** version, `bindScopeVersion`/`promoteVersion` refuse anything not admitted, WfP
isolates the running script. **The hard box is `admission`.** For our own verticals, admission
is real: our CI ran `boundary-lint`, and the `permission`/`migration` digests are computed
from source we control, so the digest-diff checkpoint means something. For an untrusted
builder, the artifact is an **opaque, minified bundle** — you cannot boundary-lint it, and you
cannot recover its permission or migration surface from it. Admission degrades from *verified*
to *guessed*.

> **Revised (builder-plane.md §4-revised):** a *guessed* admission gates nothing, so its
> scope shrank to where a human read can matter. A **private** vertical (tenant-owned, not
> listed) **self-admits on push** — its blast radius is its own tenant, and the sandbox
> contract is the actual protection; the owner self-serves prod, and prod promotion re-points
> the owner's live scopes (with channel history + fork-before-promote as the rollback story).
> Human admission remains mandatory exactly where the audience widens: publishing to the
> marketplace requires a staff-vouched (manually admitted) prod version, and a **listed**
> vertical's pushes land pending with prod staff-gated. The rest of this doc's admission
> analysis applies to that listed tier.

So the fork is: **do we ever accept an opaque bundle, or must untrusted code arrive as source
we build ourselves?**

## 2. Built bundle, never source-compiled-in-the-Worker

Independent of trust: the deploy endpoint runs in a Worker (or calls the CF API), and **workerd
cannot bundle** — no esbuild in the isolate. So the endpoint always receives a *built* worker
bundle and forwards it to Cloudflare's WfP upload API. The question in §1 is not "bundle vs
source at the endpoint" — it is **where the trusted build happens**, if anywhere.

## 3. The trust models

**A — Controlled build (source in, we build it).** The builder pushes *source*; a
platform-controlled **build sandbox** (not the Worker, not production — an isolated builder)
runs `boundary-lint`, computes the real digests, and emits the bundle. Only then: pending →
admission → serve. This is the generated-verticals surviving shape ("debugs hosted, ships
through CI"), and it is the only model where the digest checkpoint is *verified* rather than
trusted. **Cost:** a build service that runs untrusted `npm install` + build — a real
supply-chain and resource surface, just moved out of production into a disposable sandbox.

**B — Opaque bundle + WfP sandbox + mandatory human admission.** The builder pushes a *built*
bundle; we do not inspect it. Safety rests on two things instead of static analysis: WfP's
runtime isolation (per-script, CPU/subrequest limits, no ambient authority), and **every
version requiring an explicit human admission** — a person decides to trust this builder's
upload. Lighter to build; admission is a trust decision, not a verification. Digests are
whatever the pusher claims, so the permission/migration checkpoint is advisory here.

**C — Phased (recommended).** The deploy endpoint + `substrat push` + pending/admission is one
shared foundation regardless. Open it first under **B, for vetted builders** (a closed set,
mandatory human admission, strict sandbox contract §4) — enough to onboard the first paying
customers safely — and build **A** (the inspecting build pipeline) before self-serve is open
to anyone. A → verified digests → the checkpoint becomes mechanical → the human admission can
relax to policy. Never open **B to the anonymous public**: without §4's sandbox contract and a
named, accountable builder, WfP isolation alone is not a trust model.

## 4. The sandbox contract (the load-bearing invariant)

Whatever the model, a customer's uploaded worker must be structurally incapable of reaching
platform infrastructure. This is what WfP dispatch buys and what the upload metadata must
enforce:

- **Its own resources only.** A customer vertical defines and binds its *own* DO classes
  (`defineScopeDO` — the vertical IS a DO) and its own data stores. It gets **no `CONTROL_PLANE`
  binding, no platform secrets, no `AUTH_DB` it did not create.** The platform's control-plane
  DO and secrets are never in a customer script's binding set — the uploader rejects an upload
  that declares them.
- **No ambient authority.** `PLATFORM_SECRET`/`ROUTER_SECRET` are the platform's; a customer
  worker verifies the *router's* secret (K-27) to trust an inbound node, but never holds the
  platform's. It cannot call the control plane as the platform.
- **Provisioning stays pull (K-31).** The customer worker cannot create tenants/entitlements;
  the platform calls *it* to provision, exactly as today.
- **Outbound + resource limits.** WfP per-script CPU/subrequest caps; outbound egress is the
  vertical's **declared outbound surface**, enforced at the dispatch egress worker (§4.2,
  D-46) — least-privilege by declaration, not by an undecided default.

### 4.1 The binding allowlist (positive, not by omission)

Admission is a **positive allowlist**, not a denylist: a binding type the check never
anticipated is refused *by omission*, never allowed by it. The permitted set is one list
(`ADMISSIBLE_BINDING_TYPES` in `packages/contracts/src/deploy.ts`), shared by the CLI (so a
builder can predict admission) and enforced by the control plane (`assertSandboxContract`).
Every refusal names the offending binding and its type and points here.

| Binding type | Verdict | Why |
|---|---|---|
| `durable_object_namespace` | **Permitted** — own class only | The vertical's own `ScopeDO`/state classes. Refused if it carries a `script_name` (cross-script) or a `class_name` the bundle didn't declare in `doClasses`. |
| `d1` | **Permitted** — own store | An own relational store (e.g. a Better-Auth `AUTH_DB`). See the ownership caveat below. |
| `kv_namespace` | **Permitted** — own store | An own KV namespace. |
| `queue` | **Permitted** — own store | An own queue (producer binding). |
| `r2_bucket` | **Permitted** — own store | An own R2 bucket. |
| `analytics_engine` | **Permitted** — own dataset | An own Analytics Engine dataset. |
| `secret_text` / `plain_text` | **Permitted** — inert config | Own secrets (survive deploys via `keep_bindings`, #286) and inline config values; no reach into platform infrastructure. |
| `service` | **Rejected** | A hosted vertical is **one serving script** (the DO *is* the app) — there is no own sibling worker to bind, and platform reach is the router (K-27), never a binding. Reconsider only if multi-script verticals are ever introduced. |
| `dispatch_namespace` | **Rejected** | The platform's Workers-for-Platforms fabric — never a vertical's to bind. |
| `ai`, `browser`, `vectorize`, `hyperdrive`, `send_email`, `mtls_certificate`, … | **Rejected** | Managed/egress-shaped capabilities: the outside world is a connector concern, and a vertical's own direct egress is the declared `outbound` host list (§4.2, D-46) — never a binding-shaped capability. |
| any other / unrecognized type | **Rejected** | Not on the allowlist ⇒ refused, by construction. |
| `CONTROL_PLANE` (by **name**, any type) | **Rejected** | The platform's directory binding, refused by name whatever type it claims — masquerading as a permitted type must not slip it through. |

**D1 ownership caveat (model B).** A static shared `d1` binding names a `database_id`, and the
check does **not** prove the vertical *owns* that id rather than pointing at another tenant's DB.
Under model B that gap is closed by **human admission** — a named, accountable builder's declared
bindings are trusted before a version can serve — not by this structural check.

**Per-tenant relational stores (#301) close the gap by construction, not by trust.** A vertical
whose model is one SQL database *per tenant* (a latency-sensitive multi-tenant auth/OIDC provider
is the motivating case) declares a **`tenantStoreNeed`** in `runtimeNeeds.tenantStores` — not a
`d1` binding. Because the platform mints one database **per tenant** in the tenant lifecycle and
injects it, the builder supplies **no `database_id`**: there is nothing to declare and nothing to
trust. A per-tenant store therefore never rides this binding allowlist at all — it is a *need* the
platform provisions, not a *binding* the bundle carries. This is distinct from a single shared D1
(one database for every tenant) and from an own DO (one per scope). The seam is
`provisionTenantStore` (platform mints + records + hands over a handle) and `openTenantStore` (the
vertical opens what it was handed and runs its own migrations, inside the K-31 fail-closed
ready-gate). The store handle's `ref` is opaque — a D1 `database_id` on Cloudflare, a per-tenant
`.sqlite` file on the pure adapter (dev/CI/self-host), so one vertical runs unchanged on both.

**The live Cloudflare path (#301 PR-2).** At provision, the control plane mints a real D1 per
declared need (`createD1TenantStores`, on the platform's CF credential — the token also needs
account-level D1 write) and records it in the directory's `tenant_stores` ledger, keyed
(tenant, vertical, binding); the ledger — not the deterministic database *name* — is the source
of truth, and is what makes a retried provision re-resolve the same database instead of minting
an orphan. **Request-time reach is a real `d1` binding, not HTTP**: the store is attached to the
vertical's serving script under the name `tenantStoreBindingName(binding, tenantId)`
(= `<BINDING>__<TENANTID>`, from `@substrat-run/contracts`) via the WfP script-settings PATCH —
no redeploy — and **every in-place serving upload re-derives the full set from the ledger** and
sends it with the bundle's own bindings, so a re-deploy is structurally unable to drop a
tenant's store binding (the same class of bug as the re-put-secrets ritual, closed by
construction). In the worker the vertical opens `env[tenantStoreBindingName(handle.binding,
tenantId)]` (wrap it with `d1TenantRelationalStore` for the substrate store shape; `native` is
the raw `D1Database` for e.g. Better Auth). The control plane's own `openTenantStore` is the
out-of-band reach — the D1 HTTP query API — for driving a store's migrations externally, ops
reads and tests. A vertical declaring `tenantStores` should be served **in place** (#286, the
default on promote): per-version scripts get a best-effort attach at provision, but only the
serving script's bindings are re-derived on every upload. Store deletion at tenant reap is a
tracked follow-up — the ledger row is the teardown list.

**Per-tenant blob stores (#473) — the same shape, for attachment bytes.** A vertical that needs
to store file bytes (a signed contract PDF, field photos as work evidence) declares a
**`blobStoreNeed`** in `runtimeNeeds.blobStores` — the fourth store shape, and the exact
`tenantStoreNeed` story with R2 in place of D1: the platform mints one bucket **per tenant** in
the tenant lifecycle, the builder supplies **no bucket id**, so it is a *need* the platform
provisions, never a `r2_bucket` *binding* the bundle carries. (A hand-authored static `r2_bucket`
binding remains admissible as an own store — this exists so **attachment** bytes don't have to
ride one: per-tenant minting closes the shared-bucket ownership gap, and per-**scope** isolation
inside the store is platform-derived key prefixes (`attachmentBlobKey` → `scope/<scopeId>/att/…`)
constructed only in kernel/adapter code, never in module or route code.) The seams are
`provisionBlobStore` (platform mints + ledgers the bucket) and the kernel's **`attachments()`**
surface — the runtime consumer of every engine's `attachmentTargets`, at last. `attachments()`
gates every read by the declared target's `readPermission` and every mutation by its
`writePermission` (proof path included, per-entity), writes the metadata fact into the scope's
own `_substrat_attachments` table (so `scope pull` / restore / PITR carry it like any scope fact,
with an `attachment.added`/`attachment.removed` spine event in the same transaction), and sends
the bytes straight to the per-tenant bucket — never through the scope's structured-clone invoke
pipe. The live Cloudflare path mirrors #301 PR-2 exactly: `createR2BlobStores` mints on the
platform credential, the `blob_stores` ledger is the idempotency + reap source of truth, the
`r2_bucket` binding rides the WfP script-settings PATCH under `blobStoreBindingName(binding,
tenantId)` and is re-derived from the ledger on every serving upload. **Attachment-byte integrity
across the row/object split:** bytes are hashed (SHA-256) at upload and written once under a fresh
ULID key, so a metadata row can never point at bytes other than the ones it was born with — after
a PITR rewind the worst case is an orphaned object (harmless, GC-able via the store's `list`),
never a row silently re-pointed at different content. Bucket deletion at tenant reap is the same
tracked follow-up as tenant stores — the ledger row is the teardown list.

**Adoption by an already-provisioned tenant (#636, closed by #825):** minting is per tenant,
and for a long time it happened *only* in the tenant-provisioning lifecycle — first install,
sibling provision, manager-driven `provision-tenant`. A serving upload re-derives the
`r2_bucket` bindings from the `blob_stores` **ledger** (so a re-deploy cannot drop an existing
tenant's bucket), but a ledger with no row for a tenant yields no binding. Every tenant that
already existed had therefore passed the only gate that mints, weeks before the declaration was
written, and would never pass it again: declaring a store in version N+1 gave it to **nobody**,
and adoption was an ops step — "promote, then re-provision each pre-existing tenant once" — that
someone had to remember, per tenant, for a need the code had already started depending on. They
don't remember. The vertical then fails at first use, in production, arbitrarily long after the
deploy that introduced it (the Egeryds attachment outage: contract signing renders the PDF and
uploads it *before* the operation that freezes it, so a refusing `attachments()` meant no
contract could be sent for signature at all).

**Promote reconciles the fleet's stores to the version it makes serving.** After the in-place
serve — and only after, because until then `verticalServing` still names the *old* version and
the declaration read would be the previous one — the promote diffs each declared need against
the `tenant_stores` / `blob_stores` ledgers for every tenant in the directory holding a
servable install (`provisioning`/`active`/`suspended`; archived and reaped scopes are skipped),
mints what is missing, and attaches the bindings in **one** ledger-derived PATCH rather than one
per tenant. Both ledgers are read once and diffed in memory, so the overwhelming common case —
nothing newly declared — costs two reads and mints nothing, and re-promoting the same version is
silent. Declaring a store is therefore push-and-it-works, like every other part of a deploy.

It is deliberately **not** part of the serve's success: a minting failure (the platform's
Cloudflare credential, the store API refusing) must not make a promote report failure when the
new code is already live and serving. It lands an ops-failure row, rides back in the promote
response so `substrat promote` prints it at the terminal, and leaves the two per-scope paths as
the retry — `POST /verticals/:slug/instances` (re-running the install mints as a side effect) and
`POST /tenants/:t/scopes/:s/provision` (`substrat scope provision`, which mints the declared needs
before reconciling and carries a freshly minted `tenantStores` handle into the reconcile so the
vertical migrates it inside the usual ready-gate). Both are idempotent; so is the promote sweep.

**And the gap is visible while it lasts.** The real defect was never the missing mint — it was
that nothing said so. `/scopes/:id/health` reported green on a scope whose next upload was
guaranteed to throw. It now compares DECLARED (the serving version's manifest) against MINTED
(the ledger) and returns `missingStores`, which the console's scope detail and `substrat scope
status` render with the lever that fixes it. Until it closes, attachment routes on that tenant
fail loudly ("no blob store provisioned") — the fail-closed posture, not a bug.

**Static assets (#340) are admitted, and they are not a binding.** A vertical's built SPA is
declared as `runtimeNeeds.assets` — a *directory*, plus how the runtime should route paths
against it — and the platform uploads those bytes to the runtime's own asset store
(Cloudflare's `assets-upload-session`, a top-level upload path, not an entry in the script's
binding set). The allowlist above therefore cannot express a verdict on them either way, so
the decision is written down here instead:

> **Decision (D-44): static assets are an additive allow, because they carry no reach — but
> their content-address is verified, because it is shared.**
>
> The bytes are inert and public: no code runs from them, they hold no credential, they name
> no other tenant's resource, and they are served by the runtime's edge without invoking the
> worker at all. There is nothing in a `.js` file the browser downloads that the vertical
> could not equally have inlined into its own bundle — which is exactly what every demo did
> while this path did not exist, at ~+33 % bundle size against the script-size limit.
>
> What is *not* inert is the **hash**. The asset store is content-addressed and deduped
> across the whole dispatch namespace, so a push that stored bytes under a content-address
> they do not have could decide what a *different* vertical's identical-hash asset serves.
> The control plane therefore re-derives every hash from the received bytes (`assetHash` in
> `@substrat-run/contracts` — Cloudflare's own recipe, `sha256(base64(content) + extension)`)
> and refuses a mismatch, along with a declared size the bytes do not have, an asset named in
> the manifest but not uploaded, and an uploaded part named in no manifest. **What is trusted
> is the bytes; what is verified is the key.**
>
> Two things stay refused. An `assets.binding` (programmatic `env.ASSETS.fetch(…)` from
> worker code) is a real binding, is not on the allowlist, and is rejected at push time rather
> than silently dropped — a worker shipped with an undefined `env.ASSETS` looks deployed and
> 500s on first request. And assets are **versioned with the code**: an upload carrying an
> asset set replaces the script's atomically, and a version shipping none serves none. Keeping
> the outgoing version's files beside incoming code is precisely the skew that made the R2
> side-channel alternative unacceptable.

Assets travel in the same multipart body as the modules under an `asset:<served path>` part
namespace, so an asset called `worker.js` can never enter the module pipeline. The manifest
(path → hash, size, content type) is retained with the rest of the deploy manifest, which is
what lets a **promote** (#286) re-attach a version's files onto the stable serving script from
content addresses alone — the archive script gives back the modules, the asset store gives back
the assets. If the runtime has dropped bytes a re-serve cannot supply, the serve refuses and
says to push again, rather than quietly serving a half-broken page.

If an uploaded bundle's declared bindings exceed this contract, the deploy endpoint refuses it
before it ever reaches the namespace. That refusal — not code inspection — is the primary
structural defense in model B.

### 4.2 The outbound contract (#303, D-46) — a declared allowlist, enforced at the egress seam

The §6.3 open question ("allowlist, none, or metered") is answered **allowlist *and*
metered**, and the allowlist is the vertical's own declaration, not a staff grant:

> **Decision (D-46): a hosted vertical declares the third-party hosts its worker fetches;
> the dispatch egress worker enforces the declaration per subrequest and meters every
> verdict. Anything not declared is refused; anything platform-bound keeps riding the
> router.**

**The declaration.** `package.json` `substrat.outbound` — a list of lowercase hostnames
(`api.scrive.com`) and `*.`-prefixed wildcards (`*.googleapis.com`, any subdomain depth,
never the apex). The CLI carries it into the deploy manifest (`outbound` in
`@substrat-run/contracts` — schema `outboundHost`, matcher `matchesOutboundHost`, one
implementation for every seam that asks). It is **versioned with the code**: each version's
manifest holds its own list, the registry lifts it onto the version record, and the console
renders it beside the Admit button — so widening egress is visible at the admit checkpoint
exactly like the permission surface, and a policy change ships only by shipping a version.
A new-CLI push **always** sends the field — `[]` when nothing is declared, because *no
direct third-party egress* is the correct default: connectors run platform-side
(`ConnectorContext.fetch`, its own policy), transactional mail rides the control-plane
relay (`emailSender` grant), and cross-vertical calls ride the router. Most verticals need
to declare nothing.

**The enforcement path.** The router's directory read (`readHostname`) joins the declared
list of **the version whose code the dispatch runs** — the registry's serving version when
the stable serving script wins, the scope's bound version on the per-version fallback (the
two can skew mid-promote; the policy follows the bundle). It rides `RouteTarget.outboundHosts`
to the dispatch call, which passes `{ slug, tenant, hosts }` as the `OUTBOUND_POLICY`
outbound parameter (`dispatch_namespaces[].outbound.parameters`); the egress worker
(`apps/vertical-egress`) enforces: platform hosts loop back through the router (#442, K-27 —
the destination vertical's own auth is the gate), declared hosts pass untouched, anything
else is a **403** whose body names the host and says what to declare. The router never
inspects the list; the control plane never sees the traffic.

**Legacy is unenforced, never broken — and never invisible.** A version pushed by a
pre-#303 CLI has no `outbound` field, resolves `hosts: null`, and passes through
unenforced; the next push always carries the field, so the fleet converges to enforced as
it re-deploys. Every verdict — `platform` / `allowed` / `unenforced` / `refused` — writes
one Analytics Engine datapoint (`substrat_egress`: index = slug, blobs = [hostname,
verdict, tenant]; D-30 *meter, don't bill*), so the unenforced tail is a chart, not a
guess, and a refusal spike or an exfiltration attempt shows up attributed to a vertical.

**Honest limits, published beside the mechanism (the D-45 rule):**

- **Durable Object subrequests are not intercepted** — Cloudflare outbound workers see
  worker-context `fetch()` only, and Substrat verticals are DO-centric, so a fetch made
  from inside a vertical's own DO classes bypasses enforcement today. The declared surface
  is still the *reviewed contract* for all egress, and the worker-context seam still
  polices the paths that exist (OIDC/JWKS flows run in the top-level worker); but under
  model B this is defense-in-depth plus an audit artifact, not an airtight sandbox. If
  Cloudflare extends interception to DO subrequests, enforcement becomes complete with no
  contract change.
- Attaching an outbound worker **disables raw TCP `connect()`** for every dispatched
  script — sockets are closed entirely, by construction.
- **The control plane's own dispatch binding** carries no outbound worker (internal
  provisioning, not cross-vertical HTTP; wiring it would create a deploy-order cycle) —
  that path is trusted platform code.
- The declaration is **self-serve authority for a private vertical** (it self-admits,
  D-36): declaring a host *allows* it, with the blast radius being the builder's own
  tenant plus the platform's egress reputation — which is why every subrequest is metered
  and attributed. For a **listed** vertical the list sits in front of the human admitter,
  like the permission surface.

## 5. `substrat push` and the endpoint

- **`substrat push` (CLI).** Builds the vertical locally (or in the builder's CI), then POSTs
  the bundle + a declared manifest (DO classes, bindings, `version`) to the deploy endpoint,
  authenticated as the builder (a dashboard session or a scoped push token — *not* a Cloudflare
  token; the builder never holds one, D-34). In model A it pushes source instead and the build
  sandbox produces the bundle.
- **The declared surface is authored in substrate vocabulary** (D-38): `substrat.runtimeNeeds`
  in the vertical's package.json — entry module, `needsNodeCompat`, an optional pre-bundle
  `build` command, and the vertical's own `stores` (binding → durable state class). The CLI
  derives the wrangler config from it at push time (compatibility baseline pinned by the
  platform, `RUNTIME_BASELINE`) and assembles the manifest from the same derived object, so
  declaration and bundle cannot drift. §4 is why the vocabulary is complete at four fields:
  the sandbox contract refuses everything except own stores anyway. A hand-authored
  `wrangler.jsonc` remains the expert/legacy path. Note the honest limit: this neutralizes
  the declaration, not the toolchain — wrangler still bundles in the builder's CI.
  **`RUNTIME_BASELINE` is maintained, not set-and-forget (#636):** while it sits still,
  hand-authored wrangler-path dates advance past it, and the D-38 migration itself becomes
  a silent compatibility *downgrade*. Two mechanical guards: a staleness test goes red once
  the baseline falls ~6 months behind, and `substrat push` **refuses** a `runtimeNeeds`
  push whose (otherwise ignored) `wrangler.jsonc` pins a date newer than the baseline —
  the remedy is advancing the baseline, or deleting `wrangler.jsonc` to state that the
  platform picks the runtime baseline. A wrangler-path config that states *no* date also
  gets the baseline, never a second hard-coded default.
- **The deploy endpoint** (dashboard or control-plane worker, platform-controlled, holds the
  WfP-scoped CF credential): authenticates the builder → validates the declared bindings
  against §4 → uploads to the `substrat-verticals` namespace under `deploymentRef =
  <builder>-<slug>@<version>` → records a **pending** `verticalVersion`. It never promotes or
  binds — admission does, separately. A version **label is consumed only on a successful
  upload**: the endpoint records the pending version *after* the upload returns, so a push
  that fails at the upload step (a bad-bundle rejection, e.g. a module-top-level throw) never
  registers the label and the same `--version` is reusable on retry. The failure is answered
  honestly — a runtime 4xx as a `422 deploy rejected` (the builder's script), a 5xx as a
  `502` — with the upstream error body carried through intact (clipped only with an explicit
  `… [truncated, N chars omitted]` marker, never mid-token). CI schemes that bump on every
  run (e.g. `github.run_number`) still spend the number on their own side regardless.
- **deploymentRef namespacing** gains a builder prefix, because slugs are now customer-chosen
  and must not collide across builders.

## 6. Open questions

1. **Build sandbox (model A):** where untrusted `npm install` + build runs (a disposable
   Worker/container build service), and its supply-chain posture.
2. **Digest trust in model B:** the checkpoint is advisory when digests are self-declared —
   is human admission enough for vetted builders, and what does the admitter actually see?
3. ~~**Outbound policy** for customer workers — allowlist, none, or metered.~~ **Answered
   (§4.2, D-46, #303):** a declared allowlist per version, enforced at the egress worker,
   with every verdict metered.
4. **Metering/abuse:** a customer worker consumes WfP resources under our account; billing and
   abuse limits (D-30 "meter, don't bill" gives the meter, not the cap).
5. **Builder identity & accountability:** a push must be attributable to a named, agreed
   builder — the anonymous case is out of scope until A exists.

## 7. Recommendation & phasing

1. **Foundation (trust-agnostic, buildable now):** `substrat push` + the deploy endpoint +
   the §4 binding-contract check, landing a pending version. Verify end-to-end with **our own**
   fsm vertical (trusted) — this is also orchestration.md Phase 2's uploader, reached from a CLI
   instead of a curl.
2. **Vetted self-serve (model B):** open the endpoint to a closed set of named builders with
   mandatory human admission and the sandbox contract enforced. First paying customers.
3. **Open self-serve (model A):** the inspecting build pipeline — verified digests, relaxed
   admission. Gated on §6.1 and §6.4.

## 8. Definition of done (foundation)

`substrat push` from a vertical's repo uploads its bundle to `substrat-verticals` as a
**pending** version whose declared bindings satisfy §4; the console shows it pending; admitting
+ promoting + binding a scope makes it serve through the router — with the builder never
holding a Cloudflare credential and the platform never running the builder's build in
production. When that passes for fsm, the foundation is real and models B/A are scoped work.
