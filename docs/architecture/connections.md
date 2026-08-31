---
status: built
layer: plan
description: The integrations hub: connections, connectors, executor runtime.
---

# The integrations hub — connections, connectors, and the executor runtime

Status: **built** — the hub and `connectors/scrive` are live

> **Relationship to canon.** Master plan §6 and the decision log rule; this document
> proposes, it doesn't decide. It exists to be reviewed against decisions 18 (the triage
> rule), 30/31 (the actor seam and what `PlatformActorId` costs), and 27 (extract at the
> second consumer) — and to sequence work that touches `packages/kernel`.

## 1. What this is, and why now

[master-plan.md §6](../master-plan.md) commits to the whole thing in one line:

> | Integrations framework | **Build** | Connection store + token refresh, connector interface,
> webhook ingress (signatures, replay protection), outbox with idempotent retries, per-tenant
> config + health. Steal Nango's interface design; own it for EU sovereignty. |

[kernel-design.md §1](kernel-design.md) then deferred it — *"the integrations hub beyond its
contract stub"* — and **even the stub was never written**. There is no `Connection` type, no
connector interface, and no credential storage anywhere in `packages/*/src`.

**The forcing function is now real.** `engine-protocol` milestone D shipped
`requestSignatures` → `recordSignature` ([engine-protocol.md §5.1](../engines/protocol.md)), which
emits a fat `protocol.signatures-requested` that nothing can act on. And it is not the only
one waiting: `invoicing.underlag-exported` has been emitted at `schemaVersion: 2` since the
invoicing engine shipped ([engines/invoicing/src/index.ts:55](../../engines/invoicing/src/index.ts)),
shaped deliberately for an accounting connector that was never written.

**Two consumers, on the table today.** That matters more than convenience: D-27 says engines
are extracted at the second consumer, never designed ahead. The same discipline applies to the
connector interface — designing it against Scrive alone would be guessing. Designing it against
Scrive *and* Fortnox is extraction.

### 1.1 Placement is already decided

Not a judgement call. [master-plan.md §5.7](../master-plan.md)'s triage rule (the
"generalized" paragraph), verbatim:

> Three buckets, decided per capability: (1) **kernel-owned** — anything that is enforcement
> input or a contract (tenancy tree, directory, permission model, event schema, entitlements,
> attachment contracts, module manifest, **the integrations hub itself**); (2) **adapter** —
> infrastructure the kernel consumes, swappable behind a pure interface; (3) **connector** —
> third-party capability *tenants* use, living in the integrations hub.

So: **the hub is kernel-owned; individual connectors are not.** `connectors/scrive` is bucket
3 and lives outside `packages/kernel`. The connection store, the connector interface, and the
executor runtime are bucket 1. The KMS that protects credentials at rest is bucket 2 (D-18
names it explicitly).

This is also what the vertical prohibition rests on ([master-plan.md §4](../master-plan.md),
"Why runtime enforcement is the moat"):

> call third-party APIs raw — credentials live in the integrations hub; verticals see only the
> connector interface

enforced mechanically today by boundary-lint R3
([packages/boundary-lint/src/index.ts:238](../../packages/boundary-lint/src/index.ts)).

---

## 2. The runtime defect that comes first

**Before a connection store is worth building, the executor path has to survive a failed HTTP
call.** It currently cannot, and an outbound call to Scrive is the most likely thing in the
system to fail transiently.

`ExecutorHandler` ([scope-host.ts:142](../../packages/kernel/src/scope-host.ts)) is the only
outbound seam. Its dispatch loop
([adapter-sqlite/src/index.ts:885-914](../../packages/adapter-sqlite/src/index.ts), mirrored at
[adapter-cloudflare/src/host.ts:350-366](../../packages/adapter-cloudflare/src/host.ts)) is
`try` / `finally` with **no `catch`**:

| Property | Today |
|---|---|
| Backoff | none |
| Dead letter | none |
| Retry driver | **the next operation on that scope** — no timer, queue, cron or alarm exists |
| A handler that throws | escapes `invoke()` **after `COMMIT`** (commit `:813`, dispatch `:822`) — the caller sees a failed operation that in fact succeeded |
| A poison event | wedges permanently: `ORDER BY o.id` re-selects it first every drain, and executor *N+1* never runs while *N* throws |
| Attempt count / last error | not recorded — `_substrat_deliveries` has `error`, and executors never write it |

The asymmetry is backwards. Module **consumers** already have a v0 dead-letter
([adapter-sqlite/src/index.ts:948-958](../../packages/adapter-sqlite/src/index.ts)) with its
own comment — *"so one poison event can't wedge the loop"* — while executors, the only path
doing network I/O, have none.

### 2.1 What changes

> **Landed.** Implemented in #100 — retry state on the delivery journal, exponential
> backoff with jitter, dead-letter at `maxAttempts`, per-event and per-executor
> isolation, and `drainDue`/`executorDeadLetters` on the host contract. Both adapters,
> enforced by the shared contract suite. The remaining open piece is *scheduling*
> `drainDue` (§2.1 item 4) in a deployment.

1. **Catch.** A failing handler must not escape `invoke()`. The operation committed; the
   delivery failed. Those are different facts and the caller is owed the first one.
2. **Record the attempt.** `attempts`, `next_attempt_at`, `last_error` on the delivery journal
   (executors only — consumer semantics are unchanged).
3. **Backoff**, exponential with jitter, and a dead-letter after *N*. A dead-lettered delivery
   is a health signal, not a silent drop.
4. **A driver.** There is no queue, cron trigger or `alarm()` in any wrangler config today, and
   `alarm()` on the ScopeDO is unused. That is the natural fit on Cloudflare; the SQLite
   adapter gets an explicit `drainDue()` the harness and dev server call.
5. **Isolation.** One executor's poison event must not block the others.

### 2.2 Open question — is a failed delivery visible to the caller?

**Proposed: no.** Dispatch is post-commit and at-least-once by construction; a user whose work
order was created should not see an error because Fortnox was down. It belongs in the admin
log and a per-connection health surface (§3.7), not in the operation's result.

The cost is honest and worth naming: "it worked" becomes "it was accepted", and the user learns
about failure through a health view rather than a thrown error. That is the correct trade for
an outbox, and it is the trade the outbox was already making silently — just without anywhere
to look.

---

## 3. Connections — the store

### 3.1 What a connection is

One tenant's authorization to act against one external provider.

```
connection        id, tenant_id, VERTICAL, provider ('scrive'|'fortnox'|…), label,
                  status, external_account_ref, scopes, created_by, created_at,
                  expires_at, last_ok_at, last_error, last_error_at, revoked_at
                  UNIQUE (tenant_id, vertical, provider) WHERE revoked_at IS NULL
connection_secret connection_id, key_id, ciphertext — never in the same read path
```

Split deliberately: **metadata is readable, secret material is not.** Listing connections for
a console, checking health, and resolving "does this tenant have Scrive?" must not touch
ciphertext.

### 3.1.1 Keyed on (tenant, vertical, provider) — not on tenant alone

An earlier draft keyed on `tenant_id` alone, which would have made one connection visible to
**every vertical deployment serving that tenant**. That is wrong on three counts:

- **D-30 makes a vertical a blast-radius boundary.** One deployment per vertical exists so a
  problem in one does not reach another; a shared credential punches straight through it.
- **D-33 makes vertical builders third parties.** Verticals are built and hosted by different
  companies. Tenant-wide credentials would let vendor A's host code act against a provider
  that vendor B connected. Module code still cannot read a credential — but the connector is
  host code in that vertical's own deployment, so the boundary would be doing no work.
- **It is not how the provider issues credentials anyway.** Scrive is OAuth2 with registered
  clients: two vendors acting for one tenant each register their own client and hold their own
  tokens. A single shared row is a shape we would be inventing, not one that exists.

`vertical` is already first-class — `scopes.vertical` is a real column, `RouteTarget` carries
`verticalSlug`, and the admin log has a `vertical` target — so a connector resolves it from the
scope the event came from. No new plumbing.

**Cross-vertical sharing is therefore an explicit grant, if a real case ever appears.**
Additive, auditable, revocable, and fails closed meanwhile. Building the sharing machinery now
would be designing ahead of the second consumer, which is exactly what D-27 forbids.

The honest cost: a tenant running two Substrat verticals connects Scrive twice. Given they
would hold two OAuth clients regardless, that is the true shape rather than a tax.

#### 3.1.1.1 …and the account is a fourth leg of the key

Live-uniqueness is per **(tenant, vertical, provider, account)**, where the account leg is
`COALESCE(external_account_ref, '')`. A provider that never sets an account ref keeps the
original singleton semantics — all its NULLs collide — but a multi-namespace provider holds
one live connection *per external account*. The motivating case is GitHub for git-import
(the shape Vercel calls "Git namespaces"): one team connects two GitHub orgs, each App
installation is its own connection, and the dashboard selects among them by account login.
`openConnection` grew an optional `externalAccountRef` selector to match; omitted with
several accounts live, it **throws** rather than picking one arbitrarily — acting against
the wrong tenant account is worse than failing.

### 3.2 It lives in the directory, not the scope

Three reasons, in order of force:

- A connection is **tenant-wide**, and a scope database is not. One Scrive account serves every
  scope a tenant has.
- **Module code must never read it.** K-8 and boundary-lint R3 exist precisely so a vertical
  cannot reach credentials; putting them in `ctx.sql`'s reach would undo that with a
  `SELECT`.
- The executor already holds `HostAdmin`, which is directory-side
  ([scope-host.ts:138](../../packages/kernel/src/scope-host.ts): *"It receives `HostAdmin`, not
  `ctx`: it acts with platform authority, which is precisely what module code must never
  hold"*).

### 3.3 Secrets — a new adapter surface

**There is no encryption primitive in this codebase.** Every `crypto.subtle` call today is a
one-way digest. Every secret is a plaintext Worker binding compared in constant time
([platform-call.ts:24](../../packages/kernel/src/platform-call.ts)). Nothing is per-tenant,
rotatable, or encrypted at rest.

D-18 classifies the KMS as an **adapter**, so:

```ts
/** Bucket 2. Seals per-tenant credentials; the kernel never sees plaintext at rest. */
export interface SecretBox {
  /** Returns the sealed blob plus the key id that sealed it (rotation). */
  seal(plaintext: string): Promise<{ keyId: string; sealed: string }>;
  open(input: { keyId: string; sealed: string }): Promise<string>;
}
```

- **dev / self-host** — AES-GCM via Web Crypto, key from env. Fail closed if unset. The rule is
  already written down at [platform-call.ts:40](../../packages/kernel/src/platform-call.ts):
  *"An unset secret is a failure, not a bypass."* Note the router secret currently does the
  opposite ([routed-node.ts:65](../../packages/kernel/src/routed-node.ts), `expectedSecret &&`)
  and Better Auth ships a hardcoded fallback
  ([staff-auth.ts:32](../../apps/control-plane/src/staff-auth.ts)); neither is a precedent to
  copy here.
- **hosted** — Cloudflare Secrets Store binding, or an external KMS behind the same interface.

Plaintext credentials must never be written to the directory, and **never** returned by any
`HostAdmin` read. Only the connector runtime gets an opened handle, for the duration of one
call.

### 3.4 The audit log will leak credentials unless we stop it

Two concrete hazards, both load-bearing:

1. **`_substrat_admin_log.before`/`after` are arbitrary JSON**
   ([control-plane-do.ts:309](../../packages/adapter-cloudflare/src/control-plane-do.ts)) and
   `recordAdmin` writes the admin payload
   ([host.ts:1242](../../packages/adapter-cloudflare/src/host.ts)). A naive
   `createConnection(actor, {…, refreshToken})` puts an OAuth refresh token into an
   **append-only** log in cleartext. Connection mutations must log metadata only — provider,
   label, scopes, actor — and never the secret, by construction rather than by care.
2. **`adminAction` is a closed enum**
   ([contracts/control-plane.ts:19-48](../../packages/contracts/src/control-plane.ts)) and
   `auditLog` parses **every row** through it
   ([host.ts:1212](../../packages/adapter-cloudflare/src/host.ts)). An unrecognised action does
   not degrade — it fails the read of the whole log. New members are mandatory, not optional.

### 3.5 The actor problem — the real fork

Every `HostAdmin` method takes a `PlatformActorId`. For connections that is wrong in exactly
the way D-31 already diagnosed for membership:

> a tenant admin is a `PrincipalId` and cannot act as itself, so routing those methods would
> launder every self-serve membership change through a platform actor

Connecting a Scrive account is a **tenant admin's** act, not platform staff's. Three options:

| | Shape | Cost |
|---|---|---|
| **A** | `HostAdmin` only, `PlatformActorId` | ships fastest; inherits the known defect; no self-service, ever, without redoing it |
| **B** | In-scope capability, like D-31 proposes for membership — module asks, executor effects | consistent with where membership is going; needs the same kernel seam membership needs |
| **C** | A third actor brand (`TenantAdminActorId`) | solves it narrowly; adds a third actor concept before anyone asked for one |

**Settled (2026-07-23): B.** The authority to connect a provider **originates in-scope**, from a
tenant admin's permission-checked act — never a `PlatformActorId` conjured in a request handler.
The earlier "A now" deferral is retired: the console flow that A warned would "freeze the wrong
answer" is exactly the flow we are about to build (GitHub connect), so the question had to be
answered before it, not after.

B is far cheaper than the fork implied, because **the executor seam it needs already exists**:
`ScopeHost.registerExecutor(id, eventType, handler)` (scope-host.ts) — out-of-band host code that
effects, with `HostAdmin` authority, what a module asked for inside a scope; delivered
at-least-once from the outbox and stamped `causedBy` the causing event, so the authorizing
principal and the privileged write join in the trail. It is implemented in both adapters,
covered by the contract suite, and used in anger by `demos/rally` (`rally-member-adder` reacting
to `member.add-requested`). Membership's own dashboard path still launders through `STAFF` inline
instead of using this seam — that is the **parallel cleanup** this decision commits to, so the two
converge as §3.5 always intended.

#### 3.5.1 The secret wrinkle — why connections use a signed-state callback, not the outbox executor

Membership carries no secret; an OAuth connection does, and **the credential must never traverse
the outbox** — the same law as §3.4 (the audit log) and the invites engine hashing identifiers so
"no outbox executor could recover an address." A raw token in an event payload written to the
append-only spine is precisely what the platform forbids. So the plain rally shape (event carries
everything → executor effects) does not transfer. Two independent facts steer the effect mechanism:
the secret cannot ride the outbox, and an OAuth connect is a **synchronous one-shot**, not a
durably-retried post-commit effect (its "retry" is the user clicking Connect again). The outbox
executor exists for the opposite case; forcing it here would add a staging store and a retry loop
a synchronous flow does not want.

The shape, therefore — same **essence** as membership (authority in-scope, effect with platform
authority, attribution preserved), different **mechanism**:

- **Authorization is in-scope.** A tenant admin invokes an in-scope op `beginConnection(provider,
  vertical)` whose first line is `assertAllowed(await ctx.check(<manage-integrations>))`. It mints a
  **signed state token** binding `{ tenant, vertical, provider, principal, nonce, exp }`. *This* is
  the attributed, permission-checked act.
- **The effect is host-side, gated on that proof.** The provider redirects to the worker's OAuth
  callback with the state; the callback verifies the signature (proving the act was authorized
  in-scope by that principal), exchanges the code for a token, seals it via `SecretBox`, and effects
  `createConnection` **stamped with the principal from the state** — not with whatever actor the
  handler happens to hold.

`createConnection`'s signature is left as-is for now (it takes a `PlatformActorId`, which the
callback legitimately holds); B is satisfied by *where the authority comes from and how it is
attributed*, not by retyping the store. A later `TenantAdminActorId` (option C) can still slot in
without touching the store, the sealing, or the audit shape — the one thing §3.5 always promised
would stay stable.

#### 3.5.2 The connection relay — pasted credentials from the vertical's own UI

The signed-state callback (§3.5.1) covers OAuth authorization-code providers, where the
credential is minted host-side. It does not cover the other common case: the tenant admin
**holds** the credential — a Scrive OAuth1 four-part, a Fortnox API key — and the natural
place to paste it is the vertical's own Administration screen, not a console staff can see and
the tenant cannot. For a hosted CP-less vertical (verticals are sandbox-clean; only the
dashboard is privileged) that screen has no path to the connection store at all.

The mechanism is `POST /internal/connections/upsert` on the control plane, mirroring the email
relay (#303) — same secret, same trust derivation, same one uniform posture:

- **Authorization is in-scope**, exactly as B demands: the vertical's operation opens with
  `assertAllowed(await ctx.check(<manage-integrations>))`, emits a textless fat event, and
  returns the credential as a harness-side *effect* (stripped from the response) — the same
  shape `user/set-password` and the support-mail effect established. No scope row, event, or
  intent payload ever holds the plaintext.
- **The effect is host-side, gated on the platform secret.** The harness POSTs
  `{tenantId, scopeId, provider, label?, externalAccountRef?, scopes?, expiresAt?, secret,
  grants?, createdBy}` with the injected `PLATFORM_SECRET`. That shared secret only proves "a
  platform script is calling" — the relay re-derives WHICH vertical from its own scope record
  for `(tenantId, scopeId)`, so a caller can never plant a credential on a foreign vertical.
- **Upsert keyed (tenant, vertical, provider, externalAccountRef).** No live connection →
  `createConnection` under a fresh id; one live → `updateConnectionSecret` in place —
  rotation preserves the connection id, and with it every `grantToConnection` tuple. The
  relay is how the tenant rotates a credential without a support ticket.
- **Attribution is the tenant principal's** (§3.5.1's law, both sides): `createdBy` lands on
  the connection row at create, and in the audit metadata as `rotatedBy` at rotate
  (`updateConnectionSecret` grew an additive `opts.rotatedBy`). The relay effects under a
  dedicated `CONNECTION_RELAY_ACTOR`, so the admin log distinguishes a relayed tenant act
  from staff.
- **Grants ride along**: `grants: PermissionKey[]` is applied via `grantToConnection` on the
  calling scope on every upsert (tuples are idempotent), so a re-connect heals a missing
  grant. The store's own guards pin every grant inside the connection's (tenant, vertical) —
  the relay adds no authority a vertical did not already have over its own scopes.

Why a relay and not a platform-request intent: an intent's payload is a row in the scope's
`_substrat_platform_requests` spine — a plaintext credential in every export, backup, and PITR
window, precisely what §3.4 forbids the audit log for. The relay keeps the plaintext alive for
the length of one harness call, then it exists only sealed.

Deliberately **not** gated on a staff-set capability (unlike the email relay's `emailSender`):
the email relay spends the *platform's* credential on the caller's behalf; this relay stores
the *tenant's own* credential for the caller's own vertical, and its blast radius is already
pinned by the scope-record derivation and the store's grant guards. If provider/grant
allowlists ever prove necessary, the `package.json substrat` declaration + staff capability
shape is the known pattern to add.

### 3.5.2 What a connection may do, and why there is no button for it (#726)

A connection's grants were, for a long time, the one authority in this model that could
only be *written* from where a vertical sits. The permission surface is diffed at promote,
role tuples are readable from the scope, entitlements and identity links are projected and
read back locally — and the grants behind the one actor that is not a person were readable
only with staff access to the control plane. That blind spot cost a live tenant months of
silently failing sealed-copy landings, found by a human reading a diff on an unrelated PR
(#716). Three things closed it, and one deliberate absence keeps it closed.

**The read.** `connectionGrantsInScope` (and `conn.grants()` inside a dispatch) answers
from the scope's own delivered tuples — the rows the checker itself walks, both stores,
because a scope check consults both. The directory's view is a different fact and stays on
`HostAdmin`; a caller asking "will this be refused *here*" wants the enforced one. A
read-back that could disagree with enforcement would be worse than none, since it is the
read an operator would believe.

**The per-dispatch capability.** The check site is entity-aware and the grant site is not
— `connectionGrant.node` has no entity leg — so a connector's inherently per-dispatch read
could only be modelled as a standing scope-wide grant. It no longer is: a connector
dispatch may open the attachments of the entity the delivered event names, and no others.
The entity is derived from the deployment's own kernel-stamped spine row, so what crosses
the `/internal` seam is the *name* of a delivery rather than a claim about what the
platform may reach. There is no fallback to a grant on mismatch, and none on an
unresolvable delivery: "we could not resolve it, so check the grant instead" is how a
narrowing becomes a no-op.

**The declaration.** A connector exports the standing grants its RETURN path needs — the
path that runs top-level, with no delivered event behind it, and therefore genuinely
requires standing authority. `pnpm lint:connector-grants` fails when the dashboard's
provider catalog cannot carry one, so a requirement no door can grant is a red in CI
rather than a dispatch that dead-letters months later.

**The repair, and the button that is deliberately not it.** Every reconcile now heals a
connection toward its connector's declaration before gathering
(`reconcileConnectionGrants`): a declared key the connection does not hold is granted
tenant-wide, so the operator's existing lever — the idempotent re-provision — repairs a
missing capability, and a connector that declares a new one delivers it on the next
reconcile. No credential is anywhere in that path.

That is not the same thing as a grant-only write route, and the difference is the whole
reason this one is legitimate. A button would let a person add an arbitrary permission to a
connection from a console: an authority decision, taken by someone, with no tenant
principal behind it — precisely the laundering §3.5.1 forbids. This decides nothing. It
materializes a requirement the connector declared in code, exactly as a module's declared
schedules are projected as `system:<moduleId>` grants at provisioning. No one chose it, so
there is no act to attribute and `grantedBy` being the platform actor is honest rather than
a stand-in for a person. What a connection may do still follows from a declaration that
lands in a diff; it simply no longer needs a credential to deliver.

**A floor, never a ceiling.** Declared keys are granted; nothing is ever revoked. A
connection may legitimately hold more than its connector declares — a second connector on
the same provider, a key granted for a path not modelled here — and a reconcile that pruned
to the declaration would revoke authority nobody asked it to touch, on every tenant at once
the day a declaration shrinks. `lint:connector-grants` checks the same floor against the
dashboard's catalog, so the two cannot drift apart in the direction that matters.

The consequence worth stating: a key that stops being declared is not cleaned up. Removing
one is still a deliberate revoke, and `protocol:read` — no longer needed by anything after
the per-dispatch capability — stays on connections that were granted it. Harmless, and
visible in the read-back, which is the trade this makes on purpose.

### 3.6 Token refresh

Scrive is OAuth2: 1-hour access token, 30-day refresh. So refresh is not optional and it is not
request-time-only — a connection that idles past 30 days is dead and the tenant must be told
before a signature request fails.

Refresh needs the **same driver** §2.1 introduces. That is an argument for building the driver
once, properly, rather than a Scrive-specific timer.

### 3.7 Health

`last_ok_at` / `last_error` / `last_error_at` on the connection, written by the runtime. This
is where a dead-lettered delivery (§2.2) surfaces. Master plan §6 lists "per-tenant config +
health" as part of the framework; this is the minimum that makes §2.2's trade honest.

### 3.8 Inspection: verify, and what it did (#605)

Health is the minimum, and the minimum turned out to be too little. It is one line,
last-write-wins, and it is written by whatever call happened last — so a **freshly connected
credential carries no health at all** until the first real dispatch, which for Scrive means a
legal document going to real signatories. A tenant admin pasting four OAuth1 fields had no way to
learn they had pasted one wrong.

Two reads, both provider-agnostic, both on the control plane (the only place that holds the
directory, the secret box, and sanctioned egress):

| Route | Answers |
|---|---|
| `POST /tenants/:t/connections/:id/verify` | Does the provider accept this credential, and whose account is it? |
| `GET /tenants/:t/connections/:id/activity[?live=1]` | What has this connection sent? |
| `GET …/activity?source=provider` | What does the provider's own archive hold? |
| `GET /tenants/:t/connections/:id/credential` | Which credential is loaded here? |

Four properties make them safe to have:

1. **A refusal is a result, not an error.** `200 { ok: false, error }` carries the provider's own
   message. "This feature is disabled" and "No valid access credentials were provided" send an
   operator to different places, and collapsing both into a 502 destroys the only useful signal.
2. **Verify is a POST.** It spends an authenticated call at the provider and writes health — not
   the safe, cacheable read a GET promises. It is not audited, for §3.4's reason: it is a
   connection USE, and the audit log records control-plane mutations, not outbound calls.
3. **Activity is a projection, never a raw ledger row.** The source is the connector's own
   `listConnectorState` bookkeeping, which may hold secrets — Scrive's rows carry the callback
   capability token (§4.4). The connector maps its rows into a declared shape
   (`connectionActivityEntry`), which makes redaction structural rather than something each route
   has to remember.
4. **The ledger's view and the provider's view are different facts.** `?live=1` joins current
   provider state onto our rows; the response says which it got (`live`), and a provider failure
   degrades to the ledger rather than failing the read. `?source=provider` asks the *other*
   question — list the provider's own archive, including records nobody here created — and it
   deliberately does NOT degrade: an empty list would read as "the account is empty", which is a
   lie an operator would act on. Neither view is a superset, so `source` travels in the answer.

Wiring is `connectionInspectors`, host-injected and keyed by provider — the same idiom as the
sweep's `sweepers` — so `control-plane-api` still imports no connector. An unregistered provider
**501s**: "this platform cannot verify a Fortnox key yet" is true, and an empty `200` would read
as "your Fortnox key is fine".

On the control plane those keyed maps are no longer written by hand ([#990](https://github.com/substrat-run/substrat/issues/990)).
`apps/control-plane/src/connectors.ts` holds one `ConnectorRegistration` per connector — inspector,
dispatch handler, sweeper, declared grants, callback route — and `worker.ts` derives every map from
that array. The reason is the failure mode of the old shape: of the six sites a connector had to be
added to, five are a silent no-op when missed. An unwired sweeper simply never polls, an unwired
inspector 501s as though the provider were unsupported, an undeclared grant heals nothing — so a
half-added connector looked exactly like a connector that was not there yet. Present or absent is
now a property of one array entry. The dashboard's `PROVIDERS` catalog stays separate on purpose:
it is a different worker answering a different question (the credential FORM a human fills in), and
`pnpm lint:connector-grants` is what holds the two declarations to each other.

The same change made a connector's provider base **required** rather than defaulted. The connector
used to fall back to Scrive's testbed, which is right for a developer and wrong for a deployment: a
production credential sent to the testbed comes back 401, indistinguishable from a mistyped key, and
that is exactly how production called the testbed for weeks ([#610](https://github.com/substrat-run/substrat/issues/610)).
Unset now throws, naming the variable, inside the call rather than at wiring time — so one
connector's missing config fails that connector's dispatch and not the whole drain pass.

#### 3.8.1 Who refused, recorded rather than assumed (#841)

A dispatch crosses two authorities. On the way to the bytes the connector calls back into the
**vertical** — opening the bound attachment, invoking the return-path operation — and that call is
checked against the connection's grants. Only once those pass does anything reach the provider.

Both ends refuse by throwing, and for a long time both landed in the same `lastError` string with
nothing recording which was which. The drain asked `isTerminalProviderError`, which reads a bare
numeric `status` — and every `SubstratError` carries one from the problem catalog. So a
`permission denied: protocol:read` raised *inside the vertical* answered yes, and the delivery was
journaled as **"a client error the provider will refuse identically on retry"** for a request the
provider never received. The integration drawer then captioned it *"what Scrive said, in full"*.
An operator read that, went to audit their Scrive account, pressed **Test connection** — which
passed, because the credential was fine — and concluded the platform was broken.

Three rules now hold, and they are the general form of that bug rather than a patch for it:

1. **Terminality and attribution are different questions.** `isTerminalDispatchFailure` decides
   whether to retry and is deliberately blind to who refused: our own `validation_failed` is as
   final as the provider's 409. `isTerminalProviderError` answers only "may this be quoted as the
   provider's words", and one of ours never may. No delivery changed its retry behaviour when
   these were split — only what is said about it.
2. **The attribution is a value, not a sentence.** `PlatformRequestFailure` (`origin`, `code`,
   `permission`) is journaled beside `lastError` in the scope's own spine, so a reader never
   parses prose to learn who refused. `origin: 'unknown'` is a real answer — a socket that never
   opened is not the provider's refusal either — and a NULL is a *different* fact again: nobody
   classified this row, rather than somebody classifying it as unattributable.
3. **A `ControlPlaneError` is always ours.** It is constructed in exactly one place — a call *we*
   made to the vertical's `/internal` surface came back non-2xx — so whatever status it carries is
   the vertical's answer to the platform, never the provider's to us. That is what lets the fix
   land in the control plane alone: a 403 raised by a deployment that predates the change is still
   attributed correctly, with no vertical redeploy in the path.

The drawer joins it to the grants it already renders: when a failed delivery names a permission
absent from the connection's live grants, it says so where the failure is, instead of leaving both
halves of the diagnosis on screen inches apart and unconnected. When the key *is* held the sentence
is deliberately not written — that is a different bug, and guessing at it would rebuild the wall
this removes.

The repair itself is §3.5.2's reconcile, not a button.

#### Connecting means verified, not stored

The upsert (§3.5.2) used to mean *store it*: the row landed, the console said **Connected**,
and the first evidence the provider disagreed arrived on the next dispatch — after a
signature request had already failed. "Connected" was a claim about our own database.

So the relay now **pre-flights the candidate credential** through the provider's
`probeCandidate`, ahead of every write:

- **Refused** (the provider answers 401/403) ⇒ `422`, and **nothing is written**. Order
  matters most on a rotation: writing first would replace a working credential with a
  broken one. The response carries the provider's own message, so the console corrects a
  field instead of reporting "couldn't save".
- **Unreachable** (timeout, 5xx, DNS) ⇒ stored, and reported as unverified. Refusing here
  would make a provider outage look like every tenant's keys going bad at once, and would
  block the rotation someone is attempting *because* things are broken. `refused` on the
  probe is what keeps the two apart.
- **Accepted** ⇒ stored, and `recordConnectionUse(ok)` is written: a real successful call
  happened with that exact credential moments before the row existed, so a just-verified
  connection reads "last used just now" rather than "connected, not used yet" — which was
  the same "a row exists" claim in different words.

A provider with no `probeCandidate` registered behaves exactly as before: stored,
unverified, no gate. The check is available, never assumed.

#### A deployment that cannot store at all

One refusal is neither the caller's nor the provider's: a plane deployed **without a seal
key**. `SecretBox` fails closed (§3.3) — correctly, since storing unsealed is not an option —
but the throw was a plain `Error`, so it landed in the generic `500`. The operator read a
server fault in the relay or the credential; only a worker tail named the real cause, a fact
the process knew at boot.

So the relay asks `host.admin.canStoreSecrets` **first**, ahead of the probe, and refuses with
a `503` naming the missing key. Ahead of the probe deliberately: a host that can never keep the
answer has no business spending an outbound call to learn it — or handing the plaintext to the
provider on the way. The store still refuses on its own (`SecretBoxUnconfiguredError`, thrown
by the box); asking first is what turns the refusal into a status a console can read, and the
typed error is what keeps every *other* consumer of the box — subject keys, a dump seal — out
of the same unexplained `500`.

`503`, not `4xx`: the request was well-formed and nothing about it needs correcting. It is the
deployment that is incapable, until an operator sets `SECRET_BOX_KEY`.

#### The credential view — a bounded exception to write-only

The store's rule is that a credential goes in and never comes out: `Connection` cannot carry a
secret (contract-tested), and no route returns `connectionSecret`. That rule stands, but taken
alone it produced a screen where **"connected" and "connected with a mistyped token" looked
identical**, and the only repair offered was to paste every field again blind.

So `GET …/credential` answers a *reduced* view, under two rules:

1. **Only the connector may produce it.** It is the one party that knows which of its fields are
   identifiers and which are secrets — Scrive's own UI calls two of its four "credentials
   identifier". The platform cannot guess, and must not.
2. **A secret is never returned whole.** The shipped rule is a bullet run plus the last four
   characters; anything shorter than eight characters is masked entirely rather than mostly
   revealed. Enough to tell two credentials apart by eye, never enough to sign a request.

The plaintext is unsealed control-plane-side for the length of the call, like `openConnection`,
and is not audited for the same reason. Replacing a credential is still rotation — there is no
edit-in-place and no reveal.

**Still open.** A bounded outcome history (a ~20-row ring buffer next to `recordConnectionUse`)
would turn "last error" into "the last twenty calls"; the activity view covers dispatches, not
every call. That is a kernel + adapter change, deliberately deferred.

---

## 4. Connectors — the interface

### 4.1 What an executor is missing

The one real executor in the repo
([demos/rally/src/seed.ts:277](../../demos/rally/src/seed.ts)) needs only `admin`. A connector
needs two things the signature does not carry:

```ts
export type ExecutorHandler = (admin: HostAdmin, event: DomainEvent) => void | Promise<void>;
```

— no per-tenant connection, and no sanctioned egress. Proposed:

```ts
export interface ConnectorContext {
  readonly admin: HostAdmin;
  /** The tenant's live connection for this provider, refreshed; throws if absent/expired. */
  connection(provider: string): Promise<OpenConnection>;
  /** Sanctioned egress: policy, timeout, and per-connection health recording. */
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}
export type ConnectorHandler = (ctx: ConnectorContext, event: DomainEvent) => Promise<void>;
```

`registerExecutor` stays for directory-effecting handlers (membership); `registerConnector`
takes the above. Both ride the same hardened dispatch.

Giving the connector its `fetch` rather than letting it import one is what makes egress policy,
timeouts and health recording enforceable instead of advisory — the same move `ctx.sql` makes
for module code.

### 4.2 Where it runs

Coordinator/host code, not the ScopeDO — already the stated intent
([scope-do.ts:391](../../packages/adapter-cloudflare/src/scope-do.ts): *"Executors run on the
COORDINATOR, not here"*). Module code remains unable to `fetch` at all.

> **Landed (#574 phase 3).** For a hosted CP-less vertical "the coordinator" is the
> PLATFORM's coordinator: the vertical's host cannot build a `ConnectorContext` (no
> directory, no secrets, no sanctioned egress), so it routes each connector delivery as
> a `connector:<provider>` platform intent — enqueued and journaled atomically in the
> scope's own DO — and the control plane's drain executes the same handler via
> `host.dispatchConnector`, writing back over the §"write-back" seam. Self-host keeps
> the in-process path; the registration is identical in both.

---

## 5. Ingress — the return path

Tracked as [#96](https://github.com/substrat-run/substrat/issues/96) (transport) and
[#97](https://github.com/substrat-run/substrat/issues/97) (authority). Two findings from the
Scrive API that shape both:

**Scrive callbacks are unauthenticated.** The documented callback POSTs `document_id`,
`document_json` and `document_signed_and_sealed` to whatever `api_callback_url` you set, with
**no signature to verify** (retry: 5-minute delay, 10 attempts). So #96 cannot be built around
HMAC verification. The available design is:

- a **capability URL** — an unguessable secret in the callback path, since we choose the URL —
  and
- **never trust the body**: treat the callback as a hint, re-fetch document state from Scrive,
  and only then write.

That second rule is worth generalising: a webhook is a *cache invalidation*, not a fact.

**There is a polling endpoint** — `GET /api/v2/documents/{document_id}/get` returns the full
document with its status. So **#96 is optional for v1**: poll on the §2.1 driver, add webhooks
when latency justifies them. That removes the piece with the most security surface from the
critical path.

`surfaceName` is an open string ([contracts/routing.ts:24](../../packages/contracts/src/routing.ts)),
so a callback surface needs no contract change. The auth pattern to copy is
`/internal/provision`'s platform-secret gate
([demos/callout/src/worker.ts:224](../../demos/callout/src/worker.ts)) — deliberately *not*
under `/api/*`, which is the tenant-facing surface.

> **Landed (#96).** Push exists beside poll, exactly as scheduler.md §2 shaped it. The
> dispatch mints a 256-bit capability token, stores it on the ledger row
> (`ScriveDispatchState.webhookToken`), and registers
> `${base}/hooks/scrive/{connectionId}/{instanceId}/{token}` as the document's callback URL.
> `handleScriveCallback` (connector) is the ingress: constant-time token check against the
> ledger, one uniform rejection for every failure mode (no oracle, and **zero provider
> egress** without a verified token), then the SAME `reconcileScriveDispatch` the sweep
> runs. No body is ever read, so replay protection needs no seen-set — a replayed callback
> can assert nothing; it only triggers an idempotent re-read of `documents/{id}/get`. The
> deployment mounts `SCRIVE_CALLBACK_ROUTE` and sets a public base
> (`demos/meridian/src/server.ts`, `SCRIVE_CALLBACK_BASE`; mock mode delivers callbacks
> against the server itself, so the loop runs offline). Poll remains the floor.

---

## 6. The Scrive connector, concretely

```
vertical                     hub (kernel)                  Scrive
────────                     ────────────                  ──────
requestSignatures(…)
  freezes content
  ctx.emit('protocol.
    signatures-requested') ──▶ connector, on the outbox
                               connection('scrive')
                               POST /api/v2/documents/new ──▶
                               POST …/{id}/setfile        ──▶
                               POST …/{id}/start          ──▶
                                                              (days)
                               poll …/{id}/get            ◀──  status: closed
                               invoke recordSignature(…)
                                 ← blocked on #97
```

Mapping: one `protocol_signature_requests` row per Scrive **party**;
`authentication_method_to_sign: "se_bankid"`; the Scrive document id lands in the request's
`external_ref`; the sealed PDF and history become `evidence_ref`.

**The dependency this exposes: Scrive signs a PDF, and we have none.** There is no PDF
capability anywhere in the repo, [master-plan.md §6](../master-plan.md) puts generation on the
build list against a documents engine that does not exist, and
[engine-protocol.md §7](../engines/protocol.md) lists PDF rendering as an explicit non-goal.

### 6.1 The PDF question, answered

Investigated. Three findings:

1. **Scrive has no HTML/text → PDF endpoint.** It takes an uploaded file, or a template that
   already exists in Scrive.
2. **The template path is real**: `POST /api/v2/documents/newfromtemplate/{template_id}`
   uploads nothing. But per-document values must be threaded as **signatory fields**, so an
   avtal's salary and start date get modelled as attributes of a person rather than of the
   document — and the template itself then lives in Scrive's UI, outside version control and
   outside the protocol engine's immutable-template guarantee.
3. **Generating it ourselves is far smaller than "the documents engine".** PDF is a text
   format; a single page of text needs no library and no font embedding, because Helvetica is
   one of the base-14 fonts every reader ships. A working prototype — valid PDF 1.4, correct
   Swedish text — is **34 lines and 1.1 KB of output**, using only Web-standard APIs, so it
   runs unchanged in Workers.

**Recommendation: generate it, in the connector, for v0.** The decisive argument is not size,
it is consistency: the bytes we send to Scrive are derived from the same rows the content hash
covers, so the artifact and the attestation cannot drift. With a Scrive-side template they are
two independent renderings of the same intent, and nothing checks that they agree.

Keep the documents engine (master plan §6) for when a customer wants branded, laid-out output.
A Scrive-side template remains available per-customer without any code change.

::: danger The sharp edge, found by rendering rather than parsing
The first prototype produced a PDF that `file(1)` accepted, that parsed cleanly, and whose
em-dash rendered as **`€24`** and ellipsis as **`€46`**. Anything outside the character map
fell through and was silently mangled.

PDF text encoding is WinAnsi (CP1252), which differs from Latin-1 exactly in `0x80`–`0x9F`,
which is exactly where typographic punctuation lives. So the failure mode is silent
substitution in a legal document — and it is invisible to every check short of looking at the
rendered page.

The mitigation is to **throw on any character that cannot be encoded**, never approximate. A
contract that fails to render is recoverable; one that renders wrongly and gets signed is not.
:::

---

## 6.2 The inbound seam, specified against a real caller (#97)

`connectors/scrive` is built and its outbound half works end to end. Building it turned "we
need an authority seam" into four concrete requirements, which is the point of having built it
first.

### 6.2.1 What the connector actually needs

| # | Need | Why it is not optional |
|---|---|---|
| 1 | Write `external_ref` onto a signature request | Delivery is at-least-once. Without it a retry creates a **second Scrive document** — duplicate legal paperwork to real signatories |
| 2 | Write a signature (`recordSignature`) | The whole point of the flow |
| 3 | Read pending requests for a scope | Polling needs to know what to poll for |
| 4 | Somewhere for connector state | Even "this event → that document id" has no home outside the scope |

(1) is the sharp one and it was a surprise: the correctness problem is not the *missing*
signature, it is the *duplicated dispatch*. Any design that solves (2) and not (1) leaves the
system sending contracts twice.

### 6.2.2 Why the existing actors do not fit

- `PrincipalId` — a provider callback is not a person, and minting one per connection would
  make a connector indistinguishable from a user in every audit view. That is exactly the
  confusion `PlatformActorId`'s separate brand was introduced to prevent.
- `PlatformActorId` — staff. A tenant's Scrive callback is not Substrat staff acting, and
  routing it that way would put provider traffic in the control-plane audit log.
- The **system actor** (`{ system: ModuleId }`) exists only in the event envelope, and the
  adapters back it with a synthetic principal minted per host instance — a random,
  non-reproducible id. Anything durable recorded against it is unattributable after a restart.

### 6.2.3 The shape proposed

A connector already has an identity the directory knows: **the connection**. So rather than
invent an actor, let the connection *be* one.

```ts
/** A scope stub whose authority is a connection, not a person. */
getConnectorScope(connectionId: ConnectionId, scopeId: ScopeId): Promise<ScopeStub>;
```

- **Authority is narrow by construction.** A connection is already keyed
  (tenant, vertical, provider), so the stub can only reach scopes of that tenant running that
  vertical. The isolation §3.1.1 argues for is inherited rather than re-implemented.
- **`ctx.principal` stays a `PrincipalId`.** Widening it would touch every operation and every
  permission check. Instead the *actor* on emitted events becomes
  `{ connection: ConnectionId }` — a third member of the `actor` union that already holds
  `{ system: ModuleId }`, so the spine can say "this was a connector" without lying about a
  person.
- **What it may invoke is declared, not implicit.** A connection carries a small set of
  operation names it may call. `protocol/record-signature` is on Scrive's; nothing else is. So
  the blast radius of a compromised provider token is one operation on one vertical's scopes,
  and it is readable in the permission diff rather than inferred from code.

Requirement (4) then falls out: connector state is a table in the directory keyed by
connection, written through `HostAdmin`, never touching a scope.

### 6.2.4 Open questions this raises

1. Does a connection-scoped stub bypass `ctx.check`, or does it resolve tuples like any other
   caller? Bypassing is simpler and makes the declared operation list the only gate;
   resolving keeps one enforcement path but needs a principal-shaped subject to resolve
   against.
2. Is the declared operation list on the connection (runtime, console-managed) or on the
   connector's registration (code, review-gated)? The permission-diff discipline argues for
   code; per-tenant reality argues for runtime. Probably both, intersected.
   *The runtime half landed with [#592](https://github.com/substrat-run/substrat/issues/592):
   `grantToConnection` records each grant directory-side (`listConnectionGrants`, tombstoned by
   the revoke cascade), so "what may this connection invoke" is readable without walking scope
   DOs — and provision/reconcile gather from those rows and deliver per scope, the same
   authoritative channel as entitlements (#310) and identity links (#406), so a scope
   provisioned after the grant holds the same tuples as one provisioned before it.*
3. Does `protocol:record-signature` stay a permission key at all, or become "an operation only
   a connection may call"? Two mechanisms for one gate is worse than either.

---

## 7. Non-goals (v0)

~~Webhook ingress (poll first, §5)~~ — landed, see §5. A general connector marketplace or per-tenant connector
enablement UI. OAuth **authorization-code** flows in the console — v0 accepts credentials
administratively, which since §3.5.2 includes the tenant admin pasting them into the
vertical's own UI (the connection relay). Rate-limit orchestration across tenants. Replacing
the module consumer path, which is unchanged throughout.

---

## 8. Tracking

- [#100](https://github.com/substrat-run/substrat/issues/100) — executor runtime (§2), the prerequisite
- [#101](https://github.com/substrat-run/substrat/issues/101) — connection store (§3)
- [#96](https://github.com/substrat-run/substrat/issues/96) — webhook ingress (§5) — landed as the push layer beside the poll floor
- [#97](https://github.com/substrat-run/substrat/issues/97) — inbound authority seam (§5)

---

## 9. Review questions for the human

1. **§2.2** — is a failed executor delivery genuinely invisible to the caller? It is the right
   answer for an outbox and it does mean an operation can report success while its external
   effect has not happened.
2. **§3.5** — accept option A (platform actor now, structured so B is cheap), or settle the
   actor question here together with membership's rather than deferring it twice?
3. **§2.1** — is a ScopeDO `alarm()` the right driver, given nothing uses alarms yet and it
   would become the first scheduled work in the system?
4. **§4.1** — `registerConnector` as a second registration alongside `registerExecutor`, or
   widen `ExecutorHandler` in place? The latter is fewer concepts and a breaking change to a
   surface with exactly one caller.
5. **§6** — how much PDF is acceptable in v0: a minimal generated avtal, a Scrive-side template,
   or is this the trigger for the documents engine master plan §6 describes?
6. Sequencing sanity check: **§2 before §3** — the runtime before the store — because a
   connection store whose consumer cannot retry is a store nobody can use safely.
