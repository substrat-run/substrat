# Self-serve vertical deploy — the untrusted trust model

**Status:** foundation **built** (§7.1 / §8) — `substrat push` + the deploy endpoint land a
pending version that admission gates; the `substrat` CLI (`packages/cli`) ships it and Callout
deploys through it. The untrusted-builder models B/A (§3) remain design. Extends
[orchestration](orchestration.md), whose
Phases 1–3 are the **platform-owned** (trusted-author) deploy: *we* build and upload *our*
verticals. This doc is the piece orchestration.md §9 and
[generated-verticals](generated-verticals.md) §1 deferred: letting a **builder** (D-33's
paying customer) deploy *their own* vertical through the dashboard (`apps/dashboard`) with a
`substrat push` CLI — which means running code we did not write.

The governing constraint is unchanged and non-negotiable
([generated-verticals](generated-verticals.md) §1):

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

- **Its own `ScopeDO` only.** A customer vertical defines and binds its *own* DO classes
  (`defineScopeDO` — the vertical IS a DO). It gets **no `CONTROL_PLANE` binding, no platform
  secrets, no `AUTH_DB` it did not create.** The platform's control-plane DO and secrets are
  never in a customer script's binding set — the uploader rejects an upload that declares them.
- **No ambient authority.** `PLATFORM_SECRET`/`ROUTER_SECRET` are the platform's; a customer
  worker verifies the *router's* secret (K-27) to trust an inbound node, but never holds the
  platform's. It cannot call the control plane as the platform.
- **Provisioning stays pull (K-31).** The customer worker cannot create tenants/entitlements;
  the platform calls *it* to provision, exactly as today.
- **Outbound + resource limits.** WfP per-script CPU/subrequest caps; an outbound policy is an
  open question (§6) but the default is least-privilege.

If an uploaded bundle's declared bindings exceed this contract, the deploy endpoint refuses it
before it ever reaches the namespace. That refusal — not code inspection — is the primary
structural defense in model B.

## 5. `substrat push` and the endpoint

- **`substrat push` (CLI).** Builds the vertical locally (or in the builder's CI), then POSTs
  the bundle + a declared manifest (DO classes, bindings, `version`) to the deploy endpoint,
  authenticated as the builder (a dashboard session or a scoped push token — *not* a Cloudflare
  token; the builder never holds one, D-34). In model A it pushes source instead and the build
  sandbox produces the bundle.
- **The deploy endpoint** (dashboard or control-plane worker, platform-controlled, holds the
  WfP-scoped CF credential): authenticates the builder → validates the declared bindings
  against §4 → uploads to the `substrat-verticals` namespace under `deploymentRef =
  <builder>-<slug>@<version>` → records a **pending** `verticalVersion`. It never promotes or
  binds — admission does, separately.
- **deploymentRef namespacing** gains a builder prefix, because slugs are now customer-chosen
  and must not collide across builders.

## 6. Open questions

1. **Build sandbox (model A):** where untrusted `npm install` + build runs (a disposable
   Worker/container build service), and its supply-chain posture.
2. **Digest trust in model B:** the checkpoint is advisory when digests are self-declared —
   is human admission enough for vetted builders, and what does the admitter actually see?
3. **Outbound policy** for customer workers — allowlist, none, or metered.
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
