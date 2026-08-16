# Signature party contact — reaching a signatory without putting them in the spine

Status: draft v0.1 · Last updated: 2026-08-16

> Answers ask 1 of issue [#620](https://github.com/substrat-run/substrat/issues/620):
> a signature request must be able to carry **how a party is reached** — an email or
> mobile for delivery, and a personal number when the provider authenticates with a
> national eID. Ask 2 (`authLevel`) shipped in `engine-protocol@0.6.0` /
> `connector-scrive@0.7.0` and is not revisited here.
>
> Companion to [kernel-design.md §13.1](kernel-design.md) (what subject erasure
> reaches, and its five stated limits), [connections.md](connections.md) (the
> connection grant model), and [engine-protocol.md](engine-protocol.md).
>
> **The issue proposes a mechanism this document rejects**, and the reason is worth
> stating up front because the reporter reasoned carefully from the shipped packages
> and still could not have seen it: sealing PII under the per-subject keys is not
> available to a hosted vertical at any price, because those keys live on the far side
> of a boundary it may not cross. §2 derives that.
>
> What replaces it is **Option E** (§3.1): encrypt the contact in-scope to the
> *connection's* public key and let the ciphertext ride the event. §2 step 4 forbids
> projecting a secret key into a scope; it says nothing about a public one, and that gap
> is the whole design. Cheaper than the sealed carrier would have been, and it needs no
> read-back from the connector — which matters, because the obvious alternative (resolve
> at egress, D-2) deadlocks against the scope actor.

## 0. Decisions

**D-1** (no plaintext PII in the spine) and **D-3** (engine-owned contact row, cleared at
resolution) hold under every carrier considered.

**The carrier is Option E** (§3.1): the contact is encrypted in-scope to the connection's
public key and the ciphertext rides the event. D-2 — resolve at egress, nothing on the
event — is the rejected alternative, kept in §3.1 because its failure mode (the dispatch
deadlock) is the thing that would otherwise be rediscovered.

**D-4 records what that costs**: key rotation is deferred, the rotation-ready *envelope*
is not.

### D-1: no plaintext contact in the event, the outbox, or the intent

`protocol.signatures-requested` keeps `piiClass: 'none'`
([`engines/protocol/src/index.ts:1212`](../../engines/protocol/src/index.ts#L1212)) and
its party entries keep carrying only `requestId`, `label`, `kind`, `ref`,
`signatureKind`, `authLevel`. No contact field is added to the event payload.

This is not caution, it is the only shape the constraint chain in §2 leaves standing.
It also makes the `piiClass: 'none'` comment on that line true rather than
aspirational, which it would stop being the moment a contact rode along.

### D-2 (rejected, kept for its failure mode): resolve at egress through the connection door

This was the first answer, and it does not work. It is kept because it looks obviously
right — the door it uses is real and already in production — and the reason it fails is
not visible until you try it.

The idea: the contact reaches the connector by invoking an operation in the vertical's own
deployment **as the connection**, gated by an ordinary `connection:<id>` permission
grant: `ScopeHost.getConnectorScope(connectionId, scopeId)` → `stub.invoke(...)`.
That door is built, hardened, and already used by this very connector — the return
path records signatures with `scope.invoke('protocol/record-signature', …)`
([`connectors/scrive/src/index.ts:546`](../../connectors/scrive/src/index.ts#L546)).

**The placement is the hard part, and it is not symmetric with the return path.**
`getConnectorScope` lives on `ScopeHost`, not on `HostAdmin`
([`scope-host.ts:2244`](../../packages/kernel/src/scope-host.ts#L2244)), and
`ConnectorContext` exposes only `admin: HostAdmin`
([`scope-host.ts:405-421`](../../packages/kernel/src/scope-host.ts#L405-L421)) — so a
dispatch handler cannot reach it. That omission is deliberate, and the connector's own
source says why:

> *"The connector cannot record 'done' in the scope, because it runs INSIDE the scope's
> dispatch and re-entering the scope actor deadlocks (verified). So the dispatch ledger
> lives in the directory, which `ctx.admin` reaches without touching the scope."*
> — [`connectors/scrive/src/index.ts:286-289`](../../connectors/scrive/src/index.ts#L286-L289),
> in the create handler itself; the return path repeats it at
> [`:459-462`](../../connectors/scrive/src/index.ts#L459-L462)

The return path is safe because it is a top-level driver. The **create** path, where
contacts are needed, is the dispatch handler — and the deadlock there is not theoretical,
it is marked *verified* in the source. So the resolution must happen *before* the handler
runs, not inside it — which means resolving in the drain and passing the result in, with
the self-hosted path needing its own equivalent. That asymmetry, on a connector whose
whole contract is *"does not fork for hosting; only the host running it changes"*, is what
finally sank D-2.

Note the shape of the workaround already in place two lines below that comment: the
connector's own idempotency ledger lives in the **directory**, reached via `ctx.admin`,
precisely because the scope is unreachable from dispatch. A contact carrier could in
principle ride the same store — except module code cannot write the directory (§2 step 3).

Option E (§3.1) avoids the problem rather than solving it: nothing re-enters the scope,
because the connector never needs to ask the scope anything.

### D-3: `engine-protocol` owns the contact row, and clears it when the request resolves

Storage is a new column set on `protocol_signature_requests` (migration `0004`), not a
vertical side table: the engine already owns both other legs of the connector contract
(it emits the event the connector consumes, and it receives `protocol/record-signature`),
so the resolution leg belongs beside them. A vertical-owned table would force the
connector to know a vertical-specific operation name, which breaks connector
genericity — the same argument that kept `se_bankid` out of the engine in ask 2.

The row is cleared when the request leaves `pending` (signed, declined, expired,
cancelled). A signatory's personal number exists to start one signing flow; keeping it
after the flow ends is retention nobody asked for, and clearing it bounds the exposure
in §6 to the life of a pending request rather than the life of the scope.

Under Option E this may tighten further: the engine could store only the ciphertext it
emitted and hold no plaintext past the end of the operation, which would make the clear
unnecessary rather than merely prompt. See §8 Q6.

### D-4: rotation is deferred; the envelope that permits it is not

Rotation mechanics — a rotate command, a schedule, a re-seal sweep, a console surface —
are **not** built now. The ciphertext must nonetheless be born rotatable, because two of
the three prerequisites are free today and expensive later.

1. **Reuse `SealedSecret` as the envelope**, rather than inventing a `{ciphertext}` cell.
   It already carries `keyId`, and its own doc states the reason
   ([`secret-box.ts:17-27`](../../packages/kernel/src/secret-box.ts#L17-L27)):
   > *"`keyId` is what makes rotation possible: a new key seals new writes while old blobs
   > stay openable, so re-sealing is a background sweep rather than a flag-day. A
   > `SecretBox` that cannot name its key can only ever have one."*

   A cell that does not name its key cannot be rotated **retroactively** — every
   pre-existing ciphertext becomes ambiguous the day a second key exists. This is the
   retrofit trap, and it costs one field to avoid.

2. **Store the connection's private half as a `keyId`-indexed set from day one**, even
   when the set has exactly one member. Widening a single-key column into a set later is
   a migration against live connections; starting with a map is free.

3. **No re-encryption is ever owed** — see D-5, which is what makes (1) and (2) sufficient
   and the rest genuinely deferrable.

### D-5: the ciphertext is read exactly once, and that is the whole safety argument

A contact ciphertext is written at `emit` and read once, at first dispatch. Nothing reads
it again:

- Redelivery is a no-op. The connector checks its directory-held dispatch ledger and
  returns before touching the payload
  ([`index.ts:290-294`](../../connectors/scrive/src/index.ts#L290-L294)).
- The return path never needs contacts. `reconcile` works from `state.parties` in the
  ledger — `requestId`, `label`, `kind`, `ref` — which carries no contact by design.

Two consequences, and the second is the point.

**It bounds the exposure.** The window in which a stolen private key yields plaintext is
the gap between emit and dispatch, normally seconds — not the lifetime of the spine. The
"long-lived key over permanent ciphertext" objection in §3.1 is real for data *at rest*,
but it is not an operational dependency: no future correctness depends on old ciphertext
staying openable.

**It turns rotation into erasure.** Because nothing needs to read old ciphertext, rotation
can *destroy* the retired private key instead of retaining it for re-sealing. Every spine
ciphertext older than the rotation period then becomes permanently unreadable by anyone,
including us. That is time-keyed crypto-shredding, arriving as a side effect — and it is
why rotation is the thing that eventually makes Option E **safer** than D-2 rather than
riskier. Deferring it is deferring an improvement, not accruing a debt, provided D-4's
envelope is in place.

One edge case to keep visible: a scope restored from backup could resurrect a `pending`
intent whose key has since been destroyed. It fails closed — the decrypt errors and the
delivery dead-letters — which is the correct behaviour, but it should be a recognisable
error rather than a mystery.

## 1. What fails today

`connector-scrive` maps every party to Scrive with a role label and nothing else
([`connectors/scrive/src/index.ts:349-367`](../../connectors/scrive/src/index.ts#L349-L367)).
Two consequences, both in #620's evidence:

- With `authLevel: 'strong'`, Scrive refuses before the document can start — BankID
  needs a personal number field on the signatory. The connector now refuses this
  itself, before egress, with a readable sentence
  ([`index.ts:251-272`](../../connectors/scrive/src/index.ts#L251-L272)).
- With `basic`, the document starts and then has nobody to deliver to. `name: p.label`
  is a role name — "Beställare" — not a person, and no address is sent.

The provider-side slots are **already plumbed**: `ScriveParty` declares `email` and
`personalNumber`, and both are wired into Scrive's `fields` array
([`connectors/scrive/src/api.ts:133-157`](../../connectors/scrive/src/api.ts#L133-L157),
[`:329-350`](../../connectors/scrive/src/api.ts#L329-L350)). They are egress slots with
no producer. Everything this document designs is the producer.

## 2. The constraint chain — why the sealed carrier cannot be built

#620's comment proposes: seal the contact under the party's subject key at emit, so
the spine rows hold ciphertext, and have the connector open it at egress. Each step
below is verified in the tree; together they close that option completely.

1. **A personnummer must not be plaintext in a spine row.** The vertical's B6 and the
   engine's own `signatory` doc both say so, and rule 3 means the vertical can neither
   write nor erase those rows. Redaction after an erasure request does not help: the
   plaintext was there for the whole retention window before it.

2. **Sealing requires the per-subject keys, which live in the directory.** `SubjectKeys`
   is minted from the host's `SecretBox` over directory-held rows
   ([`packages/kernel/src/subject-keys.ts`](../../packages/kernel/src/subject-keys.ts),
   [`adapter-cloudflare/src/host.ts:3958`](../../packages/adapter-cloudflare/src/host.ts#L3958)).
   K-37 calls that placement "the guarantee, not an implementation detail."

3. **Module code in a hosted vertical cannot reach the directory.** A sandbox-clean
   vertical runs `permission_source = 'local'` and reads from projected scope-local
   storage ([`scope-do.ts:1931-1950`](../../packages/adapter-cloudflare/src/scope-do.ts#L1931-L1950)).
   The `CONTROL_PLANE` binding is not merely absent, it is **forbidden** (#302) — stated
   in the platform's own words at
   [`vertical-client.ts:78-86`](../../packages/control-plane-api/src/vertical-client.ts#L78-L86):
   *"it may not read the shared control plane (the `CONTROL_PLANE` binding is forbidden,
   #302)"*. This is why entitlements are projected down instead of read up.

4. **The keys can never be projected down.** Projecting a subject key into the scope DB
   is precisely the failure §13.1 names: *"a key restored by the same dump that restores
   its ciphertext would silently reverse every erasure the restore rolled past."* The
   separation is the mechanism.

5. **`OperationContext` therefore has no seal surface, and cannot get one**
   ([`scope-host.ts:109-166`](../../packages/kernel/src/scope-host.ts#L109-L166)).

Note what is *not* the blocker. K-37's stated reason — *"`ctx.emit` is synchronous and
Web Crypto is not"* — rules out sealing **at** emit, but an operation is `async` and
could have awaited a seal *before* emitting, leaving `emit`'s signature untouched and
D-28 intact. That door is closed by (3) and (4), not by (5): the problem is not
synchrony, it is that a hosted vertical is architecturally on the far side of the key
store. Anyone re-reading K-37 and reaching for "seal before emit instead" will find
this the same way the reporter did, so it is recorded here.

∴ **The sealed carrier as #620 proposes it cannot be built**: it depends on the
per-subject keys, and those are on the far side of a boundary a hosted vertical may not
cross. Anything a hosted vertical emits *in plaintext* stays plaintext in the spine.

Note the exact width of that conclusion, because §3.1 turns on it. It forbids **plaintext
PII on the event** — which is D-1, and D-1 is forced. It does **not** forbid encryption
in-scope as such: step 4 rules out projecting a *secret* key, and says nothing about a
*public* one. That gap is Option E.

### 2.1 The multi-subject problem this dissolves

Had the contact ridden the event, it would have hit §13.1's **limit 1: one subject per
event**. `_substrat_outbox` has a single `subject_id` column
([`scope-do.ts:124`](../../packages/adapter-cloudflare/src/scope-do.ts#L124)), and a
two-party avtal with a personal number for each has two subjects and one slot: erasing
party A would have to null a payload still carrying party B's contact.

Per-party sealing would have sidestepped it neatly — each blob keyed to its own
subject, so destroying A's key blinds A and leaves B readable, and the row's own
`subject_id` becomes irrelevant. That is the one genuinely elegant property the sealed
carrier had, and §2 is why we cannot have it. D-1 dissolves the problem instead: with
no PII on the event, there is no subject to key and nothing to split.

Worth recording for whoever revisits this: **the first engine to put direct PII on a
multi-party event will hit limit 1 for real.** Nothing in the repo emits
`piiClass: 'direct'` today — only the enum, a negative contract test, and one test
fixture — so that limit has never been load-bearing. It will be.

Caveat added after review: this dissolution is complete only under **D-2**. Option E
(§3.1) puts ciphertext on the event, which is still personal data and so still wants a
classification and a subject — so limit 1 returns there, blunted but not gone.

### 2.2 Does Swedish law reopen the spine option?

Raised during review, and worth answering in the document rather than in a thread: a
personnummer is **not** an Article 9 special category, Sweden's national rule
(3 kap. 10 § dataskyddslagen 2018:218) permits processing where *"klart motiverat med
hänsyn till ändamålet [och] vikten av säker identifiering"* — which BankID signing is
close to the textbook case of — and an erasure request against a freshly signed contract
will normally be **lawfully refused** anyway: Article 17(3) exempts processing needed to
establish or defend legal claims, bokföringslagen 7 kap. 2 § mandates seven years where
the contract is räkenskapsinformation, and preskriptionslagen runs ten.

If erasure is refusable for a decade, does D-1's "the spine cannot erase it" still bite?

**It does, for three reasons, and the third is the decisive one.**

1. **Lawful to retain ≠ appropriate to replicate.** The retention that law compels
   attaches to the *signed artifact* — the sealed PDF and its signaturbevis, where the
   personnummer is structurally inseparable (masking it breaks the integrity check and
   destroys the document's evidential value: it is genuinely all-or-nothing). It does not
   attach to `protocol.signatures-requested`, which is an operational dispatch record.
   Its purpose is exhausted the moment the document is created at the provider.

2. **Storage limitation survives an unerasable record.** Article 5.1(e) still requires
   that data not be kept beyond its purpose, and a documented gallringsrutin is required
   to exist — its absence being, per the same analysis, among the most common findings
   regulators make. An append-only spine with no deletion path for that field is precisely
   a missing gallringsrutin, whatever the answer to an individual Article 17 request.

3. **The analysis's own closing advice is an argument against the spine, not for it:**
   *"Kopiera inte in personnumret i din egen databas bara för att det stod i avtalet. Det
   är den kopian som blir svår att försvara, inte signaturen."* The spine copy **is** that
   copy. Substrat is the processor; the controller is the customer. Putting Swedish
   personal numbers into the platform's own event log, backups and dumps moves them from
   a defensible artifact into an indefensible duplicate, and does it for every tenant at
   once — against the ISO 27001 / SOC 2 posture D-32 commits to.

**What it does change — two things, both adopted.**

- **D-3's clear-at-resolution now has a legal rationale, not just hygiene.** The contact
  row is the short-lived working copy that makes the signature possible; the durable,
  lawful record is the sealed PDF. Clearing the working copy and keeping the artifact is
  exactly the line the analysis draws between the defensible and the indefensible copy.
- **§5 limit 1 is lighter than first written.** The vertical's erasure story for a
  signatory's personal number is mostly *refusal with documented grounds* — Article 17(3)
  plus the accounting and prescription periods — not a shredder it must build. Combined
  with clear-at-resolution, the vertical's remaining obligation is a written interest
  assessment under 3 kap. 10 § and a documented retention rule, which is materially less
  than #620's reporter was bracing for.

Not legal advice, and Substrat is not the controller: what belongs here is the
*architectural* consequence, which is that the spine stays out of it.

## 3. Options considered

| | Option | Verdict |
|---|---|---|
| A | Plaintext contact on the event, classed `direct` | **Rejected.** Violates (1); hits limit 1 at two parties |
| B | Seal under the **per-subject directory keys** before/at emit | **Impossible.** §2 steps 2–4. This is #620's proposal |
| C | Contact in the engine row, resolved at egress via the connection | **Rejected** (D-2) — deadlocks against the scope actor from dispatch |
| D | Vertical builds its own Scrive egress on the harness effect seam | The fallback #620 threatens; puts a signing credential inside a vertical |
| E | Encrypt to the **connection's public key** in-scope; ciphertext rides the event | **Adopted** — see §3.1 |

Option D is what happens if we ship nothing. It is worth being explicit that it is not
absurd — it works — but it duplicates a connector we already operate and moves a
provider credential into vertical code, which is the boundary connectors exist to hold.

### 3.1 Option E — envelope encryption to the connector, and the crack it found in §2

Raised during review: *"could we have a temporary encryption key — pass the encrypted
value on the spine and the key on the side?"*

The naive form does not work, and the reason is worth stating because it is the trap:
a **symmetric** key minted in-scope has to reach the connector somehow, and every channel
from a scope to a connector is a spine row. Encrypting the value just relocates the
problem from the value to the key. Crypto does not create a channel.

**But the asymmetric form does work, and §2 does not close it.** §2 step 4 says the keys
"can never be projected down" — that is true of *secret* keys and is the whole of #37's
guarantee. It is not true of a **public** key. So:

1. Each connection holds a keypair. The private half lives where connection credentials
   already live — sealed under the host `SecretBox` in the directory
   ([`host.ts:3664`](../../packages/adapter-cloudflare/src/host.ts#L3664)).
2. The **public** half is projected into the scope, on the established channel that
   already carries entitlements and identity links into a CP-less vertical
   ([`vertical-client.ts:78-90`](../../packages/control-plane-api/src/vertical-client.ts#L78-L90)).
   Projecting a public key leaks nothing.
3. `requestSignatures` encrypts each party's contact to that public key with Web Crypto —
   `globalThis.crypto`, which module code is explicitly allowed to use — and `await`s it
   *before* calling `ctx.emit`. `emit` stays synchronous; D-28 is untouched.
4. The ciphertext rides the event and the intent. The spine holds no plaintext.
5. The connector decrypts at egress with the private half, wherever it runs.

**Why this may be the better answer.** It is deadlock-free by construction — nothing
re-enters the scope actor — so D-2's placement problem disappears along with the
hosted/self-hosted asymmetry that made it dangerous. And it keeps the platform's own rule
that D-2 quietly
breaks: *"every mutation emits a fat event (consumer must never need a cross-module
read)."* D-2 makes the connector read back to dispatch; the deadlock is the mechanical
symptom of that violation. Option E restores the fat event, with one field opaque.

**The two real costs, stated plainly.**

- **A long-lived key guarding a permanent record.** Every ciphertext ever emitted stays
  in `_substrat_outbox` and `_substrat_platform_requests` forever (§6), and its
  confidentiality rests on one connection keypair. A future compromise of that key is
  retroactive across all history. D-2 leaves nothing to compromise. This is the honest
  trade: E is cleaner dataflow, D-2 is less standing risk. Per-request ephemeral keys
  wrapped to the connection key do not fix it — the wrapped key rides the spine too.
- **Opaque cells in the spine.** The event log is the platform's audit and timeline
  substrate; a field only one connector can read is unreadable to the console, the
  timeline projections, and every future consumer. K-37 declined to seal live spine
  payloads partly for this reason. One field is a smaller version of that cost, not a
  different one.

**Classification.** Ciphertext of personal data is still personal data to whoever holds
the key (recital 26), so the event would move off `piiClass: 'none'` — most likely
`'pseudonymous'`. That reopens §2.1's one-subject-per-event question, though less
sharply, since redaction is no longer the mechanism protecting the field.

**Decided: Option E.** The deadlock-free dataflow and the preserved fat-event rule are
worth more than the key-management story costs, and D-4/D-5 defuse most of that cost —
the ciphertext is read once, so the long-lived-key objection is about data at rest rather
than an operational dependency, and rotation later converts it into time-keyed erasure.

D-2's failure mode is recorded above rather than deleted: anyone reaching for
"just read it back at egress" will find the deadlock the same way this document did.

## 4. Surface sketch

The **engine input** below is the chosen shape. The **delivery half** was drafted against
D-2 and is kept as the rejected alternative — under Option E the resolve operation and its
connection grant are replaced by an encrypt-before-emit step and a decrypt at egress, and
neither the new permission key nor the read-back exists. Read it for the deadlock
argument, not as the plan.

**Engine input** — additive, optional, behaviour-preserving:

```ts
export const partyContact = z.object({
  email: z.string().email().optional(),
  mobile: z.string().min(1).optional(),
  /** Only for authLevel 'strong'. Never emitted, never logged, cleared at resolution. */
  personalNumber: z.string().min(1).optional(),
});

// on signatureRequestParty:
contact: partyContact.optional(),
```

`requestSignatures` writes it to the row and **does not** put it on the event. A party
declaring `authLevel: 'strong'` without `contact.personalNumber` is refused in the
engine, at the call site, with the reason — the same refuse-before-egress shape #620
praised in ask 2, moved one layer earlier where the caller can actually fix it.

**Engine read operation** — new permission key, new operation:

```
protocol/resolve-party-contacts   perm: protocol:resolve-party-contact
  in:  { instanceId }
  out: { parties: [{ requestId, contact }] }   // pending requests only
```

**Where the resolution runs** — outside the dispatch handler, per D-2. The invoke
itself is one line:

```ts
const scope = await host.getConnectorScope(connectionId, scopeId);
const { parties } = await scope.invoke('protocol/resolve-party-contacts', {
  instanceId: payload.instanceId,
});
// → ScriveParty.email / .personalNumber, already wired to the provider's fields array
```

but the caller differs by path, and that asymmetry is the open decision:

- **Platform-run (hosted, Egeryds).** The drain calls `host.dispatchConnector` from the
  control plane ([`platform-drain.ts:582-618`](../../packages/control-plane-api/src/platform-drain.ts#L582-L618)),
  outside any scope actor. Resolving here and handing the result to the handler is
  deadlock-free, and the CP already holds an authenticated channel into the vertical.
- **Self-hosted / in-process.** The connector is dispatched inline after commit, inside
  the scope's dispatch — the deadlock case. Resolution has to happen before that, or the
  create leg has to move top-level the way `reconcile` did.

Whatever we pick must keep the property `platform-drain.ts` states plainly: *"The
connector does not fork for hosting; only the host running it changes."* A design that
resolves contacts on the hosted path and silently sends contactless parties on the
self-hosted one would reintroduce #620's original failure — a document that starts and
reaches nobody — on the path we test least.

And `scriveAuthMethod`'s `'strong'` refusal is replaced by: `strong` requires a
resolved `personalNumber`, refused before egress if absent.

**Both human checkpoints fire, which is the point.** The new column is migration
`0004` on `protocol_signature_requests` (migration diff), and
`protocol:resolve-party-contact` plus the connection grant that holds it appear in
`PERMISSIONS.md` (permission diff). A connection that can read signatory personal
numbers should be legible in a PR, and this makes it so.

## 5. What this does not solve — stated, not discovered

1. **The contact is vertical-owned data, and platform erasure does not reach it.**
   This is §13.1 **limit 2** applied honestly, not a defect introduced here: engine and
   vertical tables are outside `shredSubject`. The engine's own clear-at-resolution
   (D-3) bounds it; the rest is the vertical's, which #620's reporter already accepts
   (*"with its own purpose and legal basis — our work, and small"*). Per §2.2 that
   remainder is smaller than it sounds: for a signed contract the answer to an erasure
   request is normally documented refusal under Article 17(3), not a shredder.

2. **A scope backup taken while a request is pending contains the contact in
   plaintext.** `sealDump` covers `_substrat_outbox` only, and deliberately
   ([`seal.ts:18-22`](../../packages/control-plane-api/src/seal.ts#L18-L22),
   [`:52`](../../packages/control-plane-api/src/seal.ts#L52)). Clearing at resolution
   is what keeps this window short. Extending sealing to declared vertical columns is a
   real follow-up and is out of scope here.

3. **The personal number still reaches the provider**, which is the entire purpose. It
   is passed through and not persisted by us — `ScriveParty`'s doc already commits to
   that.

4. **No audit entry is added for the contact read.** It is an ordinary operation invoke
   by a connection, checked and attributable like any other; it does not land in the
   staff access log because no staff member is involved. If we want connection reads of
   direct PII specifically journaled, that is a separate decision and should be taken
   deliberately rather than inherited.

## 6. A separate defect this work surfaced

Independent of #620, and worth its own issue: **`_substrat_platform_requests` is
invisible to the entire #37 erasure mechanism.**

- The table has no `pii_class` and no `subject_id` columns on either adapter
  ([`scope-do.ts:134-145`](../../packages/adapter-cloudflare/src/scope-do.ts#L134-L145),
  `adapter-sqlite/src/index.ts:275-286`), so redaction cannot key on it.
- `redactSubject` updates `_substrat_outbox` only
  ([`scope-do.ts:1634-1648`](../../packages/adapter-cloudflare/src/scope-do.ts#L1634-L1648)).
- `sealDump` is hardcoded to `_substrat_outbox`.
- `settlePlatformRequest` never clears `payload`
  ([`scope-do.ts:1305-1322`](../../packages/adapter-cloudflare/src/scope-do.ts#L1305-L1322)),
  and the intent embeds the **whole** domain event
  ([`platform-request.ts:187-191`](../../packages/contracts/src/platform-request.ts#L187-L191)).

So any classified event routed to a connector leaves a second, permanent, unerasable
copy of its payload. Nothing triggers this today because nothing emits
`piiClass: 'direct'` and no classified event is routed — but the hole is real, it
predates #620, and D-1 avoids it rather than fixing it. #620's reporter identified this
exactly, from the outside, before we had.

## 7. Compatibility and rollout

**The schema changes are additive.** Each piece clears the additive-only rule on its own
terms:

- `contact` is a new **optional** input field with a behaviour-preserving default
  (absent = today's behaviour exactly).
- The contact columns are a new **append-only** migration (`0004`); no shipped version is
  edited.
- The ciphertext is a **new field on an existing payload**. The frozen-payload rule bars
  rename/remove/retype without a `schemaVersion` bump; adding is not one of those, so
  `schemaVersion: 1` stands. Consumers parse with their own `z.object()`, which strips
  unknown keys, so an older connector ignores the field rather than failing.
- **Exactly one consumer exists** — `connector-scrive`. Nothing else in the repo reads
  `protocol.signatures-requested`, so the blast radius is one package.

**Version skew is benign in both directions.** Old connector + new engine: the ciphertext
is stripped on parse and the connector behaves as it does today. New connector + old
engine: no contact field arrives, so the connector must treat it as optional — refusing
`strong` with the existing message and proceeding on `basic`. Neither combination is worse
than the status quo, which is that nothing works.

**But "additive" is not "no risk", and four things are worth naming.**

1. **A live migration on production data.** Egeryds is running real contracts. `0004` is a
   schema change against that, and it is a human checkpoint for a reason.

2. **A deploy-order dependency.** The connection's public key must be projected into the
   scope *before* the engine tries to encrypt to it. Control plane first, vertical second.
   The engine must fail closed and legibly when no key is present — never silently emit a
   contactless request, which is exactly today's invisible failure wearing a new hat.

3. **`piiClass` becomes data-dependent.** A contact-bearing event moves off `'none'` and
   gains a `subjectId`, which means `shredSubject` starts nulling those payloads where it
   previously skipped them. That is the intended behaviour, but it is a change in the
   erasure path's reach and should be verified, not assumed.

4. **The real risk: success is the new behaviour.** Every signature request this vertical
   has ever sent has failed. Shipping this does not modify a working path — it switches on
   one that has never once completed. The first green run puts real Swedish contracts in
   front of real signatories, and the connector's own source names the failure mode that
   matters: a redelivery creating a second document is *"duplicate legal paperwork sent to
   real signatories."* The directory-held dispatch ledger guards against it and has never
   been exercised on a path that gets far enough to need it.

**Rollout, therefore:** control plane and key projection first; engine and connector
landed together with the connector tolerant of an absent contact; the whole flow exercised
end-to-end against the Scrive **testbed** before any production tenant; then one known
contract with a known signatory, watched, before it is left to run.

## 8. Open questions

1. **Which channel projects the connection's public key into the scope?** The established
   carriers are `ProvisionInstanceInput` (arrives with provisioning, atomically) and
   `configureInstance` (upserted later). A connection can be created long after the
   instance exists, so provisioning alone is insufficient — but reusing `configureInstance`
   puts a key in the same bag as config strings, which may not be where it belongs. This
   is the first concrete implementation decision.

2. **What is the asymmetric primitive?** `SecretBox` is AES-GCM symmetric and does not
   cover this; Option E needs RSA-OAEP or ECDH-derived AES-GCM in `crypto.subtle`. Whether
   that lands as a sibling of `SecretBox` in the kernel (the `createSubjectKeys` precedent:
   crypto in the kernel, storage in the adapter) or inside the connection store is open.
   The kernel side is the better default on that precedent.

3. **Does anything else want this carrier?** If a second connector needs to receive PII at
   egress, the mechanism should be a connection-level facility rather than something
   `engine-protocol` owns. Worth one look before building, since the shape is cheap to
   generalise now and awkward later.

4. **Does `partyContact` belong on the engine at all, or should the engine store an
   opaque blob it never interprets?** A `personalNumber` column in `engine-protocol`
   changes the engine's posture — it has held only opaque refs until now, deliberately.
   An opaque `contact_blob` the connector parses keeps the engine ignorant but moves the
   schema contract into an untyped string. Recommendation: typed, because a
   provider-agnostic engine choosing what "how to reach a party" means is exactly the
   `authLevel` argument from ask 2, one level down.

5. **Does clear-at-resolution (D-3) fight `recordSignature`'s ordering?** The clear must
   land after the connector no longer needs the plaintext row. D-5 says nothing re-reads
   it, so this should be safe — but if a flow ever grows a re-send or reminder, clearing
   becomes wrong and the ciphertext on the event becomes the only copy.

6. **What does the engine store once the contact is encrypted — plaintext, ciphertext, or
   both?** D-3 assumed a plaintext row read at egress, which was D-2's shape. Under E the
   engine could keep only the ciphertext it emitted, and hold no plaintext at all after
   the operation returns. That is strictly better for §5's limit 1 and probably the right
   answer; it needs one pass to confirm nothing in the vertical's own screens needs to
   redisplay a contact.
