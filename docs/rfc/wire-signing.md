---
status: proposed
layer: kernel
description: One-way trust between the platform and a deployed vertical. The router and the control plane sign what they send a vertical with Ed25519, a vertical holds public keys only, and a vertical's calls up to the control plane give way to its outbox. Envelope, verifier states, key management, the readiness gate and a rollout that breaks no live app. Primitives only so far.
---

# RFC: wire signing

**Status:** proposed; its ten design questions are decided (§12) · **Decision:**
[K-58](../decisions/K-058-a-call-from-the-platform-to-a-vertical-carries-an-ed25519-envelope-and-a-deployed-vertical-holds-public-keys-only.md),
proposed · **Primitives:**
`packages/contracts/src/wire-signing.ts`, with shared vectors in
`packages/contracts/test/vectors/wire-envelope.json` · **Precedent:**
[K-52](../decisions/K-052-the-scope-store-envelope-is-ed25519-per-audience-and-an-object-is-bound-to-its-name-by-its-id.md),
the scope-store envelope, whose scheme this reuses.

## Summary

**The problem.** Calls between the platform and a deployed vertical are authenticated with
shared secrets. A shared secret cannot tell callers apart, and rotating one is a change to every
holder at once.

**The target is one-way trust.**

1. **Down: the platform signs, the vertical verifies.** The router and the control plane put an
   Ed25519 envelope on every call they make to a vertical. A vertical holds public keys only. It
   can check a signature and cannot make one. The envelope names the deployment it is for, the
   request it rides on and, on a routed request, the tenant, scope and surface the router
   resolved.
2. **Up: the vertical asks by writing, and the platform pulls.** What a vertical needs from the
   control plane goes to its own outbox, the way provisioning and platform requests already flow
   (K-31). The few direct calls a vertical makes up to the control plane are replaced one by one.
3. **Then nothing a deployment holds is accepted by any platform worker,** save Q10's bounded
   exception while a never-rebuilt version is live, and the shared secrets are retired. The down-channel can be signed-only before that, but the shared
   credential stays injected until the up-channel is gone, so the up-channel work is on the
   critical path (§9).

**The envelope** is fifteen lines of UTF-8, signed with Ed25519 (§3): a protocol tag, the
issuer (`router` or `platform`), the kind (`route` or `call`), the key id, the target deployment,
the tenant and scope, the surface and vertical, the method, a digest of the path and query, a
digest of a call's body, the issue and expiry times, and a nonce. Key ids, key lists, the key
format and the key tooling are K-52's.

**The rollout breaks nothing that is live** (§9). Verifiers learn to accept a signature before
anything relies on one (`dual`). The signers then add signatures beside the legacy headers,
which stay. The control plane records which deployed versions can verify, and an environment's
down-channel becomes `signed-only` only when every live version can, the counters show no legacy
acceptance, mismatch, fault or refusal beyond expected client noise, and a human flips it. The shared credential is withdrawn only after the up-channel
is gone. Every step reverts on its own.

**This pull request** adds this RFC, the K-58 draft and the primitives, with tests and vectors.
It wires nothing and changes no behaviour.

**Decided questions** (§12): new key pairs, one per issuer, not the store keys; the verifier runs
in the platform's entry module; a deployment learns its state from an explicit per-environment
setting applied at upload; nonces live in the scope object's own storage; large bodies are
buffered, with no streaming endpoint in version 1; the lifetimes are 60 s by default, 120 s at
most, 30 s of skew; a route binds no body; the capability is the uploader's record; a dual-mode
disagreement is accepted and counted, and a non-zero count blocks the flip; a build that is never
rebuilt gets a per-deployment value for each of its legacy checks, as a bounded exception to G1.

---

## 1. The problem

Calls between the platform and a deployed vertical are authenticated today by comparing a
presented value with a copy (K-27, K-31). That model has two properties that do not change
however carefully it is operated:

- **It cannot tell callers apart.** A shared value proves possession, not identity, so a verifier
  cannot apply different rules to different callers.
- **It verifies with the same value it signs with,** so the power to verify cannot be handed out
  without the power to sign, and rotating it is a change to the whole fleet at once.

The cure is the one K-52 applied to scope stores: separate the power to sign from the power to
verify. A deployment that verifies with a public key holds nothing that signs.

## 2. Goals and non-goals

**Goals.**

- **G1.** A deployed vertical holds no credential that any platform worker accepts. It holds
  public keys. The one bounded exception is Q10's per-deployment value for a version never
  rebuilt, accepted only for that deployment's own up-calls, and only while that version is live.
- **G2.** A verifier knows who signed (the router or the control plane), and refuses an envelope
  meant for another deployment, for another request, or outside its time.
- **G3.** No live app breaks at any step. Every step can be reverted, and each environment moves
  on its own.
- **G4.** The cutover is decided on evidence: counters show that legacy acceptance has reached
  zero before anything refuses it.
- **G5.** One scheme. The key format, the key id, the key lists, the key tool and the rotation
  runbook are K-52's, not a second set.

**Non-goals.**

- Authenticating end users. Sign-in, sessions and bearer tokens are unchanged.
- Authorization inside a vertical. Permission checks are unchanged.
- Confidentiality. The envelope gives integrity and origin; transport is unchanged.
- Changing which network paths reach a deployment.
- Signing by anything but the platform's own router and control plane. No vertical signs.
- The scope-store envelope (K-52), which is unchanged.

## 3. The envelope

### 3.1 Fields

| # | Field | Meaning | `route` | `call` |
|---|---|---|---|---|
| 1 | tag | `substrat-wire/1`, the protocol and its version | always | always |
| 2 | `iss` | who signed: `router` or `platform`, so which key list verifies | `router` | `router` or `platform` |
| 3 | `kind` | `route`: an end user's request the router resolved. `call`: a call to an internal endpoint | | |
| 4 | `kid` | the signing key's id, as K-52 defines it | always | always |
| 5 | `aud` | the target deployment: the name the request is dispatched to, compared as an opaque string | always | always |
| 6 | tenant | a ULID | required | with the scope, or neither |
| 7 | scope | a ULID | required | with the tenant, or neither |
| 8 | surface | the surface the router resolved | required | never |
| 9 | vertical | the vertical slug | optional | optional from the router, never from the platform |
| 10 | method | upper case | always | always |
| 11 | target digest | SHA-256 hex of the request's pathname and search | always | always |
| 12 | body digest | SHA-256 hex of the exact body bytes | never | always (an empty body has a digest too) |
| 13 | `iat` | issue time, Unix seconds | always | always |
| 14 | `exp` | expiry, Unix seconds | always | always |
| 15 | nonce | 16 random bytes | always | always |

The (`iss`, `kind`) pairs are a closed table: (`router`, `route`), (`router`, `call`) and
(`platform`, `call`). The control plane never asserts a routed request, and a route never claims
to bind a body it does not carry. The router signs a `call` for the internal calls it makes
itself, such as a peer invocation, so those leave the shared secret too.

The store envelope names its signer's role `aud`. Here `aud` is the target, as in a JWT, and the
signer's role is `iss`.

### 3.2 Canonical bytes

The signed message is exactly these bytes. A verifier in another language rebuilds them from the
fields and checks the signature. The vectors cover a route, a scoped call, an unscoped call with
an empty body, and a call the router makes. Negative vectors beside them name the reason each must
be refused for (a tampered line, S + L, another audience, an expired or not-yet-valid envelope, a
key of the other issuer, an over-long lifetime, an aliased kid or nonce, a byte-order mark, CRLF,
a trailing line feed, a lone surrogate, a store envelope, an inadmissible pair), and key lists a
loader must refuse (a small-order point, an alias, a key listed for both issuers, a duplicate).

- UTF-8, no byte-order mark. Fifteen lines joined by a line feed (0x0A), with no trailing line
  feed. Nothing else separates fields, and no field contains a line feed.
- An absent field is an empty line. A present field is never empty. The closed table decides
  which fields are present, so there is one encoding of any envelope.
- `aud`, surface and vertical are opaque text: 1 to 255 UTF-16 code units, no C0 control
  character and no DEL, well-formed Unicode. They are compared as exact strings, with no
  normalization.
- Tenant and scope are 26-character Crockford ULIDs in upper case, the grammar the router asserts
  today.
- The method is an HTTP method token (RFC 9110 `tchar`, so `M-SEARCH` too) of 1 to 32
  characters (the longest registered method, `UPDATEREDIRECTREF`, has 17; the bound only keeps an
  unregistered token from making the line unbounded), with its letters upper-cased. Both ends are to read the method and target
  through the same helper, `wireRequestBinding`, which upper-cases what the request says. The
  primitives take both as strings, so the wiring is what holds each end to the helper.
- The target is the request URL's `pathname` followed by its `search`, as the WHATWG URL API
  serializes them. The fragment never travels, and an empty `?` reads as no query on both ends.
  The envelope carries its digest, not the text, so the header stays a fixed size whatever the
  URL.
- Digests are lowercase hex SHA-256 over the exact bytes. For a string that is its UTF-8, the
  same digest K-52 takes of a store call's body.
- Times are decimal Unix seconds: no sign, no leading zero, at most 15 digits.
- The key id is K-52's: base64url of the first 8 bytes of SHA-256 over the raw 32-byte public
  key, 11 characters. The nonce is 16 bytes, 22 characters. Both are canonical base64url: no
  padding, and unused trailing bits zero, so no second spelling exists.
- The signature is pure Ed25519 (RFC 8032) over those bytes, base64url, 64 bytes.

The tag is domain separation. A store envelope starts with `1` and has nine lines, so no message
signed under one protocol parses as the other, whatever key signed it. Any later protocol signed
with an Ed25519 key of the platform starts with a tag of its own.

### 3.3 Where it travels

Two request headers, beside whatever the request already carries:

- `x-substrat-wire-envelope`: base64url of the canonical bytes.
- `x-substrat-wire-signature`: the signature.

Together, names included, they are 430 to 520 bytes in the vectors. Both sit under the prefix the router already strips from
every inbound request, so a client cannot supply one that reaches a vertical, and one it supplied
would not verify anyway. **The legacy headers stay beside them for the whole migration.** Only
the last step (§9, step 7) stops sending them.

### 3.4 The checks, in order, and the one refusal

`verifyWireEnvelope` makes every check in one fixed order. Before any of them it requires a key
set that `wireVerificationKeys` built, which refuses a key listed for both issuers, and a call
expectation that states its replay policy (§4). Anything else is the deployment's fault, not the
caller's, so it throws, and no refusal counter hears it. The key set is marked by the module
instance, so it must be built by the same copy of the package that verifies: the entry (Q2) holds
both.

1. both headers present;
2. the header decodes as base64url to UTF-8, decoded strictly (a byte-order mark is kept, so it
   fails the tag), and the text parses as exactly what the encoder emits. A header spelled with
   its unused trailing bits set decodes to the same bytes, and the signature covers the bytes, not
   the spelling;
3. the issuer, then the kind, are the ones this endpoint accepts;
4. the key id is in the issuer's list;
5. the signature verifies;
6. then, all over signed bytes: the audience is this deployment; the lifetime is positive and at
   most the maximum; the clock is inside `[iat - skew, exp + skew]`; the method and target are
   this request's; a call's body is this body; a tenant or scope the endpoint pins is the one
   named;
7. last, and only on a call whose replay policy is a nonce cache, the nonce is unspent: the claim
   must answer exactly `true` (§4).

**Every failure the caller caused returns the same value**, `WIRE_REFUSED`, and an endpoint
answers every refusal with the same status and body. The reason goes to an `onRefusal` callback
for counters only (a throw or a rejection from it is ignored), and never into a response or a log
line a caller can read. Nothing secret is compared in the verifier, so the time a refusal takes
reveals nothing secret. The single answer stops a caller from learning which check failed.

**A throw is answered as the platform's own failure, never through the legacy path.** The entry
answers a verifier throw (a misbuilt key set, a missing replay policy, a cache that fails or does
not answer in time) with a 5xx whose body is fixed and identical for every throw: it never
carries the error's text, a cache error's included. The error's detail goes only to the platform's
own telemetry, never into the response, and the throw is counted as its own outcome (§8). It
never falls back to the legacy path, in
`dual` or otherwise, so a missing cache is an error the counters show, not a hole the flip later
turns into an outage.

### 3.5 Time

An envelope lives 60 seconds by default and at most 120 (`exp - iat`). A verifier allows 30
seconds of clock skew on either side. `now` is when the request arrived, not when its body
finished reading. A clock that is not a number fails both comparisons rather than passing them.

### 3.6 Bodies

A `call` binds its exact body, so the verifier reads the whole body before it acts on any of it.
Web Crypto has no streaming digest, so this means buffering. Every internal endpoint today reads
a whole JSON body anyway, and a scope too large for one call already moves in pages (#2450). An
empty body is the empty string or zero bytes. A body that is absent or `null` (a body read that
failed) is refused, never digested as empty. A `route` binds no body: the router does not buffer
an end user's upload, and a route's authority is the identity the router resolved, not the
payload (Q7).

## 4. Replay

- **Routes keep no nonce memory.** A route envelope is bound to one deployment, one method and
  one target. With the 120-second maximum lifetime and 30 seconds of skew on each side, a verifier
  accepts one for up to 180 seconds, and that window is the replay risk accepted. Replaying one
  repeats the same request to the same deployment inside it, which HTTP retries already do, and
  the router's own bounded retry (K-29) does deliberately.
- **Every call states its replay policy, and none is defaulted.** A call's expectation carries
  `replay`: `'none'` (no nonce memory, for a read or an idempotent call) or a `WireNonceCache`
  (for a call that changes state). An expectation without one is the deployment's fault: the
  verifier throws before it reads anything, so a wiring that forgets the cache fails closed
  instead of accepting replays.
- **With a cache**, the verifier claims the nonce only after every other check has passed, so an
  envelope refused for anything else never spends an entry. `claim(nonce, until)` must answer
  exactly `true` for a nonce it had not seen; any other answer refuses. It may forget the nonce
  after `until`, which is `exp + skew`, and a claim made after `until` by its own clock answers
  `false`. The verifier also reads the deployment's clock again (`clockSeconds`, the same clock
  `nowSeconds` came from, required with a cache and checked up front) just before it claims, after
  the body is read, and refuses a claim that would come after `until` without asking: otherwise a
  replay that arrived inside the window with a slow body could be claimed after the cache had
  rightly forgotten the first use. That refusal is counted as `claim-after-until`, not `replay`,
  so a slow body is not read as an attack. A cache that cannot answer throws, and the call fails as the platform's
  own fault, never as acceptance. The entry bounds each claim in time (a second is proposed) and
  treats a timeout as that throw, so a claim that never settles cannot hang the request.
- **A call that keeps nonces pins its scope.** A cache lives in one scope's object, so the
  endpoint pins the `scopeId` it claims through, and the verifier throws on a cache with no pinned
  scope, absent or `null` alike. That also refuses the unscoped call with a cache that the last
  bullet rules out.
- **Where the cache lives.** In the scope's own Durable Object (Q4): the object is the one place
  that serializes the scope's writes, so a claim there is atomic with no further machinery. The
  entry module (Q2) verifies everything else in the worker, then makes the claim through the same
  scope stub the request is about to use, as one call on the object before the operation runs.
  The cache interface is the seam, so the verifier never holds a binding.
- **A signer mints a fresh envelope for every attempt.** A retry that resends the same headers
  carries a spent nonce and is refused as `replay`, which would read as noise in `dual` and fail
  outright in `signed-only`. So the router's bounded retry and every platform retry re-sign.
- **A call that names no scope** has no scope object to hold a cache. Such a call must be a read
  or idempotent (`replay: 'none'`). Any that is not is named in the PR that wires it.

The primitives define the cache interface only. Its storage is a follow-on.

## 5. Verifier states

Each environment has one setting with three values. It governs the **down-channel**: what a
deployment accepts on a call from the router or the control plane. Every deployment in the
environment applies it, and each environment moves on its own.

| State | On a call down, a deployment accepts | It is given at upload | The signers send |
|---|---|---|---|
| `legacy-only` | the legacy secret, as today | the legacy secret | legacy headers, and signatures once signing is on |
| `dual` | a valid signature **or** the legacy secret | the public key lists, its own name, the legacy secret | both |
| `signed-only` | a valid signature only | the public key lists, its own name, the state, and **still** the legacy secret, for the up-channel | both, until step 7 |

**The shared credential is not withdrawn by `signed-only`.** It stays injected until the
up-channel is gone, because the up-channel still uses it. That is why step 6 is on the critical
path and must not be deprioritised: `signed-only` closes the down-channel, and only step 7, after
step 6, withdraws the credential.

- **`dual` accepts everything `legacy-only` accepts.** A call is accepted when **either** the
  envelope **or** the legacy credential is valid. A signature that fails, beside a legacy
  credential that matches, is accepted through the legacy path and counted as
  `refused:<reason>, legacy-accepted`, the signal the cutover waits on. When both are valid but
  disagree (the router's legacy headers name a different tenant, scope or surface from the
  envelope), the request is **not** refused: it is answered through the legacy headers, as today,
  counted as `dual-mismatch` and surfaced (Q9). A non-zero count is a router defect, and it blocks
  the move to `signed-only` (§7). Only in `signed-only`, where the envelope alone decides admission,
  can a disagreement refuse anything.
- **One identity per request, the same at the entry and in the vertical.** The entry passes
  exactly one routed identity (tenant, scope, surface) downstream, and a version built with the
  verifier reads that one (Q2), never a second source:
  - in `legacy-only` and `dual`, the legacy headers' identity whenever the legacy credential is
    valid, a `dual-mismatch` included, so a request is served exactly as today until the flip;
  - in `dual`, the envelope's identity only when the envelope alone admitted the request (its
    legacy credential missing or invalid, which with both still sent is itself a defect the
    counters show);
  - from `signed-only` on, the verified envelope's identity, and the legacy headers are not read
    for it.

  A version built against an older vertical-host still reads the router's legacy headers for that
  identity at steps 5 and 6, which is safe only because the router still sends both and
  `dual-mismatch` was zero at the flip; after step 7 such a version needs Q10's values or blocks
  the withdrawal.
- **The state is injected at upload, with two derived safeties.** A deployment with no key lists is
  `legacy-only` whatever the setting says, so a new verifier under an old control plane, which
  injects no keys, behaves exactly as today. A deployment with key lists and a missing or unknown
  state reads it as `dual`. A wrong value fails toward today's behaviour: a deployment told `dual`
  when it should be `signed-only` accepts either a valid signature or a valid legacy credential on
  the down-channel, as every deployment does now.
- **The signers have two flags per environment:** `sign` (add envelopes) and `legacy` (keep
  sending the legacy headers). Both are the signers' own configuration, so changing either is a
  deploy of that signer. Signing, once on, stays on: the signers' release gate (§7) refuses `sign`
  off, and a signer build that would not sign, while any environment is `signed-only`. Legacy
  goes off only at step 7.
- **Reverts unwind in reverse order, and each state has its own.**
  - From `dual`, or before any flip: turn `sign` off, or revert the verifier package. Nothing
    relies on a signature yet.
  - From `signed-only` (steps 5 and 6): set the environment back to `dual` and walk the fleet, or
    re-upload one deployment. The signers kept sending the legacy headers, and the deployment
    still holds the credential, so a reverted deployment accepts the legacy path again at once.
    A signer that cannot sign in a `signed-only` environment is an outage that pages, and is fixed
    at the signer (its standby key, §6), not by flipping the fleet.
  - After step 7: there is no legacy path left. The revert of step 7 is injecting the credential
    again and turning `legacy` back on, a walk of its own. A signer fault is met by the standby
    key (§6), which every deployment already lists.

## 6. Key management

- **Two key pairs per environment**: the router's (`iss` `router`) and the control plane's
  (`iss` `platform`). Each private key lives only on the worker that signs with it, as a secret.
  The form is K-52's 48-byte PKCS8 v1 Ed25519, judged by the same function
  (`scopeStoreSignerPublicKey`), so the key tool and both signers accept and refuse the same
  values.
- **Public key lists**, one per issuer, comma-separated raw keys in canonical base64url (K-52's
  form, parsed by the same `parseScopeStorePublicKeys`). The uploader injects them into every
  vertical script as plain configuration (they are not secret), with the script's own dispatch
  name for the audience check. Plain configuration is rewritten on every upload rather than kept
  from the previous one, which is what lets a re-upload carry a new list.
- **A key listed for both issuers is refused** when the lists are loaded, so the router's key can
  never sign as the platform. `wireVerificationKeys` is the only way to build a key set the
  verifier accepts.
- **The tool is K-52's.** `pnpm store-keys` (`tools/store-keys.mts`) gains the two issuers, or a
  sibling command over the same functions does: `generate` writes a private key only outside any
  work tree, `doctor` checks a configured set, and `rotate` prints the steps. Secrets are pushed
  with `scripts/secrets.mjs`, as today.
- **Rotation** is the store runbook's (`secrets/store-keys.md`): list the new public key, wait
  until every live deployment carries it (the readiness report, §7), switch the signer, drop the
  old key, and wait again.
- **A standby key per issuer is listed ahead of need.** Each issuer's list carries, beside the
  key in use, a standby public key whose private half is held offline. It is in every deployment's
  list before the environment may go `signed-only` (§7), so switching to it refuses nothing.
- **A compromised key, or a signer that cannot sign, takes the break-glass path.** Switch the
  signer to the standby key, which every deployment already lists, then walk the fleet to drop the
  compromised key and list a new standby. Dropping the compromised key does not wait for §7's
  gate, which the break-glass path overrides. Only platform staff on call may take it, as a
  person's action recorded in the admin log with the reason, never automation's. No refusals
  follow and no legacy path is needed, so the path works after step 7 as well as before. A
  deployment the walk has not reached yet keeps accepting the compromised key until it is
  reached; the walk runs at once, as the store runbook's does.
- **The audience needs the deployment's own name.** The uploader already knows it, since it
  uploads to it, and injects it beside the lists. A deployment with no name configured refuses
  every envelope on the audience check, so a missing value fails closed.

## 7. The capability and the gate

- **Each version records `wireAuth` at upload**: the envelope version its verifier understands
  and the key lists it was given. The uploader writes it from what it built and injected. The
  vertical never declares it, because a claim the vertical makes about itself proves nothing.
- **A readiness report per environment** lists every live version: the serving version of every
  install, every preview, and every version a scope is bound to. For each it shows whether it
  verifies, which key lists it carries (the standby keys included), which state it is in, and
  which up-calls its bundle can make. A version the uploader sent without the platform's entry
  module (the entry's own skip rules leave some older bundles unwrapped) cannot verify, and the
  report counts it as not ready, by name.
- **The gates.**
  - The control plane refuses to set an environment to `signed-only` unless the report is clean,
    the standby keys are listed everywhere, and the cutover criterion holds (§8: no legacy
    acceptance, no `dual-mismatch`, no `fault`, and no `refused:*` outside expected noise from
    clients that send nothing).
  - It refuses to drop a public key unless every live version carries its replacement, except on
    the break-glass path (§6).
  - It refuses to stop injecting the shared credentials unless every live version is ready for
    their withdrawal, by two tests, both of which must hold:
    - **its up-calls:** step 6 is complete for it, so it no longer makes an up-call with the
      platform credential;
    - **its legacy down-checks:** it runs no legacy check of its own on the down-channel, or every
      one it runs is satisfied by the entry with a value unique to that deployment (Q10). A
      version built against a vertical-host older than the verifier still checks a routed request
      and a platform call the old way, and with the credentials withdrawn, and the router no
      longer sending the legacy headers, those checks would refuse everything it serves. It passes
      only if the entry synthesises a per-deployment value for **both** checks, or it blocks the
      withdrawal by name.
  - Each flip is a person's action, recorded in the admin log, and never automation's.
- **The signers' release gate.** The control plane does not deploy the router or itself, so it
  cannot refuse a signer deploy. The gate lives in each signer's own deploy workflow, owned by
  whoever deploys it: before it deploys, it reads every environment's state and refuses `sign`
  off, or a build that would not sign, while any of them is `signed-only`. A rollback made outside
  that workflow is not gated: it is §8's page, and is fixed by rolling forward.
- **Versions that block a gate are named, with a notice and a date,** and each kind has its own
  outcome there. Their authors get the notice and the date by which to push again.
  - A version uploaded **without the entry** cannot verify and cannot take a per-deployment value,
    since both need the entry. It blocks `signed-only` until it is reached by the verifier-only
    wrapper Q2 leaves to follow-on 1, or it is retired at its date.
  - A version **never rebuilt** blocks the withdrawal of the credentials (step 7) until it is
    moved to a per-deployment value for both legacy checks and its up-calls (Q10), or it is
    retired at its date.
  - Until its outcome is decided, such a version is a named exception to G3, not a silent break.

## 8. Observability

- **Every verification is counted** by environment, issuer, kind and outcome: `signed-accepted`,
  `legacy-accepted`, `refused:<reason>` (one per reason in `WIRE_REFUSAL_REASONS`),
  `dual-mismatch`, and `fault` (a verifier throw, §3.4). The count rides the invocation line the
  platform's entry already writes for every request (#1893), so it can be read per deployment and
  per tenant as well as in total.
- **The signers count** envelopes signed and signing failures. A signer whose key will not import
  keeps sending the legacy headers and raises an alarm. Where every environment it signs for is
  still `dual`, that is degraded but serving. In a `signed-only` environment it is an outage that
  pages, and the fix is at the signer: its standby key (§6).
- **The cutover criterion** for an environment: a clean readiness report, and over a window with
  traffic on every live version (a week is proposed) zero `legacy-accepted`, zero `dual-mismatch`,
  zero `fault`, and zero `refused:*` outside expected noise from clients that send nothing. §7's
  gate on `signed-only` reads exactly this. Reasons appear in counters only, never in an answer.

## 9. Rollout that breaks no live app

**Mixed fleets are the normal case**, and every combination works:

| | Router and control plane before signing | Router and control plane signing, legacy kept |
|---|---|---|
| **Vertical before the verifier** | today | the new headers are ignored, and the legacy secret is accepted as today |
| **Vertical with the verifier** | no key lists injected, so `legacy-only`: as today | `dual`: the signature is accepted, with the legacy path as fallback |

**The steps.** Each is its own pull request, and each says what to check and how to revert.

| Step | Changes | Revert | A human checks before the next step |
|---|---|---|---|
| 0 | This PR: RFC, K-58 draft, primitives. Nothing wired. | delete the files | the envelope format and the plan |
| 1 | The verifier, `dual`-capable, inert without key lists, in the platform's entry module (Q2) | revert the package | a pushed demo with no keys behaves exactly as before |
| 2 | Keys generated per environment, the standby keys with them. The uploader injects the lists, the deployment's name and the capability record. The signers' `sign` flag on, `legacy` still on. Test environment first. | `sign` off (refused by §7 once any environment is `signed-only`) | in test, a re-pushed demo counts `signed-accepted`, an untouched vertical counts `legacy-accepted`, and nothing is refused |
| 3 | The fleet re-uploaded so every live version the entry wraps carries the verifier and the lists. Readiness report and tooling. A version uploaded without the entry is not reached by any re-upload, and is named in the report until its author pushes again (§7). | none needed: `dual` accepts legacy | the report is clean, or lists only named exceptions, counters steady |
| 4 | Watch. Fix every `refused:*` and `dual-mismatch`. | none | the cutover criterion (§8) holds for the environment |
| 5 | A person flips one environment's down-channel to `signed-only` (test, then production), and the fleet is walked again. **The shared credential stays injected**, because the up-channel still uses it. | the setting back to `dual` and walk, or re-upload one deployment | full demo walk in test, zero `legacy-accepted` on the down-channel, every live app answering, its up-channel features included |
| 6 | **On the critical path:** the up-channel goes, one PR each (below). It can run in parallel with steps 1 to 5, and nothing after it starts until it is done. | revert that PR | the feature works end to end on a test deployment, and the readiness report shows no live version still making that up-call |
| 7 | The uploader stops injecting the shared credential, the signers stop sending legacy headers, and the shared secrets are retired from every vertical path and rotated out. Gated by §7's two tests for every live version: its up-calls (step 6 complete for it) and its legacy down-checks (none, or each satisfied by the entry with a per-deployment value, Q10). A version never rebuilt fails both until Q10's values reach it. | inject it again and turn `legacy` back on | every environment `signed-only`, both of §7's tests hold for every live version, the report clean |

**Step 6, the up-channel.** Each item moves one of a vertical's calls up to the control plane onto
its outbox, so it no longer needs the shared credential: outbound email (as the existing email
intent), connection consent (minted by the dashboard and recorded as an intent), and the prompt
to drain a scope sooner (dropped, or reduced to a coalesced wake that carries no identifier).
Most of these calls are made by package code bundled into the vertical when it was built, so a
step-6 PR changes what a version does only once that version is rebuilt and pushed. A version
never rebuilt keeps the up-calls it was built with.

## 10. The follow-on pull requests

1. **The verifier** with `dual` acceptance, the counters and the agreement check, behind the
   absence of key lists (inert until step 2). Not ready to merge without a test on workerd.
2. **The signers**: the router signs routes and its own calls, and the control plane signs its
   calls. Legacy headers unchanged, `sign` flag per environment, default off.
3. **The uploader** injects the key lists (standby keys included), the deployment's name, the
   state and the capability record, and
   the key tool gains the two issuers.
4. **The fleet walk and readiness report**, with the gates on `signed-only` (standby keys listed,
   the cutover criterion, versions without the entry named), on dropping a key (and its
   break-glass path), and on withdrawing the shared credentials (both of §7's tests). The signers'
   release gate on `sign` off and on non-signing builds goes into each signer's deploy workflow.
5. **The nonce store** in the scope object, for calls that change state.
6. **The up-channel removals**, one PR each (§9, step 6). On the critical path: they can start
   now, in parallel with 1 to 5, and the credential cannot be withdrawn until all are merged and
   live.
7. **The flip**: the per-environment down-channel setting, triggered by a person, test first.
8. **Withdrawing and retiring the shared secrets** from every vertical path, after 6.

## 11. Not in scope

- **Anything wired.** This PR changes no verifier (`assertPlatformCall` and `readRoutedNode` are
  untouched), no signer, the router, the control plane and the uploader not at all, and no
  deployed behaviour. The new module is on its own subpath (`@substrat-run/contracts/wire-signing`)
  and imports only its sibling `scope-store-envelope`, which this PR does not change. So nothing
  bundled today grows, and no store script's build changes.
- The nonce store, the counters, the readiness report and the key tool's new issuers: specified
  here, built later.
- The scope-store envelope, end-user authentication, permissions, and network reachability.
- Retiring or renaming any secret.

## 12. Decided questions

Each of these was argued as an open question and is now decided. The reasoning is kept beside
each decision.

**Q1. New key pairs, or the store keys?** **Decided:** new pairs, one per issuer, with the same
format, tool and runbook as the store keys. The router and the control plane already hold one
Ed25519 key each for scope stores, and the tag makes sharing them safe as cryptography: neither
protocol's message parses as the other's. But a leaked key would then open both channels, and
neither could rotate without the other.

**Q2. Where does the verifier run?** **Decided:** in the platform's entry module (#1893), which
hands the verified node to vertical-host. In vertical-host it would reach a deployment only when
that vertical is rebuilt and pushed again. In the entry, which the control plane uploads in front
of a bundle, it reaches that deployment at its next upload, including versions whose authors never
push again. K-52 already put the store's checks in the platform's entry and never in the code
behind it.

Two kinds of deployment are not reached that way, and the plan says so rather than assuming
them away:

- **A version the uploader sends without the entry.** The entry's own skip rules leave some
  older bundles unwrapped (one that already writes its invocation line itself, for instance).
  Such a version never verifies, so its environment cannot go `signed-only` while it is live.
  It blocks the flip, by name, until its author pushes again (§7). A wrapper for the verifier
  alone, which would not follow the entry's skip rules, could reach it. That is follow-on 1's
  choice, recorded there.
- **A version never rebuilt.** It keeps the up-call code it was built with (§9, step 6), so step 6
  is never complete for it. It also keeps its own legacy checks on the down-channel, on a routed
  request and on a platform call, which refuse everything once the credentials are withdrawn. So
  the credentials cannot be withdrawn while it is live unless the entry satisfies both of those
  checks with a value unique to the deployment and the control plane accepts the platform one for
  that deployment's own up-calls only. Q10 is that path; until a version's values reach it, the
  version blocks step 7 by name.

The entry variant still gets its own review in follow-on 1.

**Q3. How does a deployment learn its state?** **Decided:** an explicit per-environment setting,
injected by the uploader, with the safety of §5: no key lists means `legacy-only`, a missing or
unknown state reads as `dual`, and a wrong value fails toward today's behaviour. The legacy secret
stays injected through `signed-only` for the up-channel, and is withdrawn only at step 7.

**Q4. Where do nonces live?** **Decided:** in the scope object's own key-value storage, keyed by
nonce, with expiry at `exp + skew` and pruning on write. A spine table would need a migration on
both adapters, a migration-diff checkpoint and a spine-ddl change. Calls that change state are
few, so the store stays small.

**Q5. Large bodies.** **Decided:** buffer them. Version 1 has no streaming endpoint. If one is
ever needed, it gets a new field in a new version rather than a special case in this one.

**Q6. The lifetimes.** **Decided:** 60 seconds by default, 120 at most, 30 of skew, revisited from
the `refused:expired` and `refused:not-yet-valid` counts.

**Q7. Should a route bind its body?** **Decided:** no (§3.6).

**Q8. What proves the capability?** **Decided:** the uploader's record on the version, written
from what it built, never a declaration by the vertical (§7).

**Q9. A dual-mode disagreement** between the envelope and the legacy headers, both valid.
**Decided:** accept the call, answered through the legacy headers as today, since `dual` accepts
whatever either credential proves and refusing would break a live request for nothing. Count it as
`dual-mismatch` and surface it. A non-zero count is a router defect, and it blocks the
environment's move to `signed-only` (§7) until it is fixed.

**Q10. The shared credentials in a version that is never rebuilt.** Such a version, built
against a vertical-host older than the verifier, runs two legacy checks of its own on the
down-channel: one on a routed request and one on a platform call, each against the credential it
was given for that caller. It also presents the platform's credential on its up-calls, read from
the same place its platform-call check reads. Withdrawing the credentials at step 7 would make
both checks refuse everything (the router no longer sends the legacy headers either), and
replacing the platform's value with a unique one would break the up-calls, unless the control
plane accepts that unique value for that deployment and nothing else.

**Decided:** a per-deployment value for each legacy check, as a stepping stone. At upload
the platform mints, for each such version, one value per check and records which deployment they
belong to. The entry, having verified the envelope, satisfies both of the version's own checks
with them: it presents the routed identity the envelope proved, with the routed-request value,
and the platform-call value on a verified platform call. The control plane accepts the
platform-call value only on that deployment's up-calls, and an up-call made with it may name
only the tenants and scopes that deployment serves; anything else it names is refused. Neither
value acts as the platform or as another deployment, so the shared credentials can be withdrawn
from such a version at step 7.

**This is a bounded exception to G1.** For as long as such a version is live, its deployment
holds a value that one platform worker, the control plane, accepts, but only for that deployment's
own up-calls and its own tenants and scopes. The exception ends when the version is rebuilt (its
up-calls go with step 6) or retired. Until its values reach it, such a version stays on the shared
credentials, named, with a notice and a date (§7), and step 7 waits for it. Versions uploaded
without the entry cannot take these values at all, since the entry is what presents them; their
path is Q2's wrapper or retirement (§7).

## Evidence and limits

- **Shown.** The primitives' tests (`packages/contracts/test/wire-signing.test.ts`): a round trip;
  every refusal reason reached and every refusal the same frozen value; each line changed under
  the original signature refused as the signature; validly signed envelopes for another audience,
  method, target, body or scope refused for that; the clock edges and the lifetime bounds; issuer
  and kind separation, so the router's key cannot sign as the platform; key rotation with two
  ids; malformed inputs and the negative vectors; a call with no replay policy failing closed;
  only a claim of exactly `true` accepted; and the nonce cache consulted last. Each guard was removed in turn and a
  test failed every time. The vectors use the RFC 8032 test keys, and the test checks them with
  node's own Ed25519 and SHA-256 as well as with the module.
- **Not shown.** The verifier running on workerd. Follow-on 1 carries that test, the way K-52's
  entry was shown on workerd before it was relied on.
