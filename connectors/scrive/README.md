# @substrat-run/connector-scrive

Scrive eSign (Swedish **BankID**) for Substrat: turns a vertical's signature request into a real
Scrive signing flow, and records the completed signatures back into the scope. A **connector** is
host code — you register it on a scope host; it is never module code.

**Full documentation: https://substrat.net/connectors/scrive**

## What it does

Two halves, both built and tested against the real testbed API.

**Outbound.** `engine-protocol` emits `protocol.signatures-requested` when a vertical freezes a
document and sends it for signature. The connector (only for `method: 'scrive'`) turns that into a
Scrive document: **create → set file → set parties → start**. Each party's authentication method
comes from the request's provider-agnostic `authLevel` (`basic` → `standard`, the default;
`strong` → `se_bankid`), falling back to the connection's `defaultAuthMethod`. A `se_bankid` party
is sent an **empty** `personal_number` field, which is all Scrive's auth-to-sign check wants — the
signatory fills it in during the ceremony, and no personnummer ever enters this platform.
It records each dispatch in a directory-side ledger (`putConnectorState`, keyed by the connection)
so an at-least-once redelivery skips instead of creating a *second* document — duplicate legal
paperwork to real signatories. Directory-side because a connector runs *inside* the scope's
dispatch and re-entering the scope actor deadlocks.

**Inbound.** Once parties sign at Scrive, `reconcileScriveDispatch(host, connectionId, instanceId,
{ fetch })` reads `documents/{id}/get`, maps each signed party back to its request, and records
the signature onto the protocol instance by invoking `protocol/record-signature` through
`getConnectorScope` — the connection acting as itself ([#97](https://github.com/substrat-run/substrat/issues/97)),
a top-level operation (not the dispatch handler, where re-entering the scope deadlocks). It
re-checks the provider-reported content hash against the frozen one and **fails closed** on a
mismatch, and it is idempotent across polls. `sweepScriveReconciliations(host, connectionId,
{ fetch })` is the poll driver over it: it enumerates the dispatch ledger
(`listConnectorState(id, 'scrive:dispatch:')`) and reconciles every outstanding instance, skipping
those already complete and stepping past a provider error on any one.

## Using it

```ts
import {
  declareScriveConnector,
  registerScriveConnector,
  sweepScriveReconciliations,
  SCRIVE_TESTBED,
  SCRIVE_PRODUCTION,
} from '@substrat-run/connector-scrive';

// 0. ONE provider base for this deployment. Everything below takes it — registration,
//    the sweep, the callback ingress — so a deployment cannot dispatch to production
//    and poll the testbed.
const baseUrl = SCRIVE_TESTBED; // or SCRIVE_PRODUCTION

// 1. Register the connector on the scope host (host code, like an engine module).
//    `baseUrl` is REQUIRED — there is no default, deliberately: the old fallback was the
//    testbed, and a production credential sent there comes back 401, indistinguishable
//    from a mistyped key. A CP-less vertical, which registers only so its host knows
//    which events are connector deliveries, uses `declareScriveConnector(host)` instead —
//    it never calls the provider, so it names no base.
registerScriveConnector(host, { baseUrl });

// 2. Open a connection with the OAuth1 credential, and grant it the one permission
//    that lets it write a signature back — held by NO human role.
await host.admin.createConnection(actor, {
  id, tenantId, vertical, provider: 'scrive', label,
  secret: { clientId, clientSecret, tokenId, tokenSecret },   // sealed by the host's SecretBox
});
await host.admin.grantToConnection(actor, {
  connectionId: id, permission: 'protocol:record-signature', node, grantedBy: actor,
});

// 3. Schedule the poll — YOUR deployment calls the sweep on a timer. Both triggers ship:
//    The sweeper is bound to the SAME `baseUrl` step 1 registered with:
const sweeper = (h, id, o) => sweepScriveReconciliations(h, id, { ...o, baseUrl });
//    Node:        startPlatformSweeper(host, { sweepers: { scrive: sweeper }, intervalMs })
//    Cloudflare:  definePlatformSweeperDO (@substrat-run/adapter-cloudflare) — a self-re-arming
//                 Durable Object alarm whose pass calls runPlatformSweep(host, { sweepers: { scrive: … } }).
//                 An alarm rather than a cron because a vertical pushed into a Workers-for-Platforms
//                 dispatch namespace gets no `triggers.crons`; where a cron IS available, point
//                 scheduled() at the DO's ensureArmed() as a safety net.
```

The credential is Scrive's OAuth1 "personal access credentials" — four parts that combine into a
PLAINTEXT signature (`{ clientId, clientSecret, tokenId, tokenSecret }`), **not** OAuth2 bearer. A
signatory's personnummer is passed through to Scrive on the signing request and **never stored**:
it is `direct` PII, and `engine-protocol` records an opaque `DataSubjectId` as the signatory
instead. The host needs a `SecretBox` configured to seal the credential at rest.

## Caveats worth knowing

1. **Your deployment must schedule the poll** (step 3). The connector provides the driver; it
   cannot hold a timer — that is a deployment concern. Both triggers now exist off the shelf:
   `startPlatformSweeper` (node, a self-rescheduling interval) and `definePlatformSweeperDO`
   (`@substrat-run/adapter-cloudflare`, a self-re-arming Durable Object alarm — works in a
   Workers-for-Platforms dispatch namespace, where crons do not). Without one wired, dispatch
   works but signatures are never recorded back. Note the sweep enumerates connections through
   `host.admin.listConnections`, so the deployment that runs it must hold the connection
   directory — a control-plane-less vertical worker (scope-local-permissions.md Phase 3) cannot
   sweep until its connections are reachable from its runtime.

2. **No party carries an address, so no counterparty can be invited.** Probed against the
   testbed ([#687](https://github.com/substrat-run/substrat/issues/687)): a party with only a
   name draws `409 invalid_invitation_delivery_info` — *"Invitation delivery for participant #2
   requires valid email field"* — at `basic` as much as at `strong`.
   `protocol.signatures-requested` carries no contact, and `ScriveParty.email` is therefore never
   populated. This is the live blocker, and it is one carrier away
   (`docs/architecture/signature-contact-carrier.md`); every other caveat here is downstream of it.

   **CLOSED by #852.** The author is now a party of its own that does not sign, so no party the
   vertical names is ever the author, and every one of them is invited normally. The dispatch
   refuses before egress when any party carries neither email nor mobile, naming the party —
   which is the companion invariant this caveat asked for. Both are asserted in
   `test/dispatch.test.ts`.

### The author is the account, and the API does not say so

Worth stating plainly, because it is not in Scrive's documentation and it decides who signs:

**Scrive binds the author party to the API account holder and silently overwrites the `name` and
`email` you send on it.** Measured against `api-testbed.scrive.com`, not inferred — a party sent
as `Not The Account Holder <someone.else@example.com>` with `is_author: true` comes back carrying
the account's own name and address, with no error and no warning. Sending *no* author party does
not avoid it: Scrive claims party #1 and overwrites that instead.

Two consequences, both of which reached production before this was understood:

- While the issuing party was the author, **the Scrive account owner signed for the sender's
  organisation** — whoever the vertical actually named. Egeryds sent an avtal naming one person
  and a different person was invited to sign it.
- The **return path could never record that signature.** `reconcileScriveSignatures` refuses to
  attribute when the provider's party name disagrees with the dispatched label — a fail-closed
  guard doing exactly its job — and the substituted name never agrees.

So the connector sends the account as a **non-signing author** (`is_author: true`,
`is_signatory: false` → `signatory_role: "viewer"`), and every party the vertical names is an
ordinary signatory that keeps its own identity. A named signatory whose address happens to equal
the account holder's stays a separate signing party rather than folding into the author — also
verified live.

`ScriveDispatchState.senderParty` records that the sender was sent, because the reconcile matches
the Nth signatory to provider party N+1. State written before #852 has no `senderParty`, reads an
offset of 0, and reconciles exactly as it did before.

3. **The live BankID signing round-trip is unverified.** The outbound lifecycle is checked
   against `api-testbed.scrive.com`, but `se_bankid`-to-sign is **disabled on the testbed
   account** (`start` → 409 `authentication_to_sign_method_disabled`), so the actual signature —
   and Scrive's real signed-`get` party shape and order — have only been exercised against
   `ScriveMock`. Because the reconcile fails closed on a party-shape mismatch, a wrong assumption
   *skips* (visibly, in the sweep result), never mis-records. It stays a `0.x` release for this
   reason.

   What is **no longer** true: that `authLevel: 'strong'` cannot be satisfied. `0.7.0` refused it
   before egress, reasoning that Scrive's BankID auth-to-sign needs a `personal_number` on the
   party and Substrat may carry no personnummer (design rule B6 — it reaches neither the kernel,
   the events, nor the audit trail). The requirement is real; the inference was wrong. Scrive
   validates that the field is **present**, not that it holds a value: an empty
   `personal_number` draws exactly the same `start` errors as a filled one, and the signatory
   completes it during the BankID ceremony. `update` sends that empty field for every
   `se_bankid` party, `strong` maps straight through, and no PII carrier is needed for the auth
   level. (BankID agrees on direction: since API v6 it does not accept a `personalNumber` from
   the relying party at all.) `test/live.test.ts` asserts this against the testbed, including the
   control case that shows the error returning when the field is absent.

4. **It sends the vertical's document when one is bound, and its own attestation sheet when
   none is** ([#711](https://github.com/substrat-run/substrat/issues/711)). Rendering the real
   document belongs to the **vertical** — a connector cannot read another module's tables — so
   the vertical uploads its rendered file onto the protocol instance and names it when binding:

   ```ts
   const doc = await attachments.upload({ entity: { entityType: 'protocol', entityId }, … });
   await scope.invoke('protocol/bind-document', { instanceId, contentRef, contentHash,
                                                  documentAttachmentId: doc.id });
   ```

   `protocol.signatures-requested` then carries `documentAttachmentId`, and `create` opens it
   (`conn.openAttachment`, on the very connection it is about to send with) and puts those
   bytes out under the vertical's own filename. With nothing
   bound, today's one-page sheet goes out unchanged — the template, the parties, and the content
   hash — which stays the honest artifact for a caller that renders nothing.

   Three things worth knowing about the shape:

   - **The connection needs `protocol:read`** (`grantToConnection`), on top of
     `protocol:record-signature` and `protocol:attach`. It is a permission-diff line.
   - **A bound-but-unreadable document is a hard failure, not a quiet fallback.** Once a
     vertical has said which bytes its signatory must see, sending different paper instead is
     the exact failure this closed — quieter than a refusal and worse, because a document still
     goes out and a counterparty still signs it. So a missing grant or a deleted attachment
     dead-letters; the ledger row is written only after `start`, so the retry after the fix
     sends the right document.
   - **The id is named, never searched for.** The return path lands the sealed SIGNED copy on
     this same instance, so a connector that picked "the document on this instance" could mail a
     counterparty their own signed contract to sign again. Naming an id makes that
     unrepresentable rather than merely unlikely.

   What is signed is still the **hash**: this changes the bytes shown to the signatory, not the
   identity of what the signature attests to. `bindDocument` is where the two are reconciled —
   it refuses an attachment that is not on the instance being bound, and carries the kernel's
   own `sha256` of the bytes onto `protocol.content-bound`.

   What was **never** true, in either direction: this caveat first said the store did not exist,
   then that only the connector was missing a line. `attachmentTargets` has been implemented in
   both adapters since #473, and this connector already wrote through it on the return path — so
   the store was never missing. But the outbound leg needed a read the platform genuinely did not
   have, and neither reading told the truth about where the work was:

   - on `adapter-sqlite` a connector runs INSIDE the scope's actor task, and the ordinary
     attachment surface re-enqueues per verb — reading from a dispatch wedged the scope
     (`packages/adapter-sqlite/test/connector-reads.test.ts` pins it);
   - on the hosted Cloudflare path only `upload` crossed the `/internal` seam, so the control
     plane held the credential while the vertical held the bytes.

   Both are closed: `ScopedConnectorConnection.openAttachment` — the read hangs off the
   connection `ctx.connection(provider)` returns, so it is authorized as the credential the
   dispatch is actually using and cannot drift from it — and `open` now crosses the delegation
   seam beside `upload`. `list` deliberately does not; see the third bullet above.

## Verified against the testbed

The API layer was checked against `api-testbed.scrive.com`, not just the docs — and the first
version, written from the docs, was wrong in three ways one live call exposed at once:

- **auth is OAuth1 PLAINTEXT**, not OAuth2 bearer (the UI's "Client" + "Token" credentials are
  two halves of one four-part signature; the `oauth2.scrive.com` endpoint rejects them)
- **`documents/new` returns no `status`** — only `get` does, so mutation responses are parsed for
  their id and status is re-read
- **`setfile` is `multipart/form-data`**, not a base64 body

`test/live.test.ts` runs the real lifecycle (`new → setfile → update → get`), what `start`
validates, and that Scrive accepts a document this codebase did not render (caveat 4), when
`connectors/scrive/.dev.vars` holds a complete OAuth1 credential; it **skips**
otherwise — so CI without secrets stays offline and a local run against the testbed verifies the
actual API. Nothing it creates is delivered: no document reaches `pending` (the account setting in
caveat 3 sees to that), no party carries a real address, and every document is cancelled and
deleted.

The `start` tests read Scrive's error **list** rather than a single message, which is what lets
them assert the interesting thing — which errors are *absent*. `authentication_to_sign_method_disabled`
is present in all of them and cannot be avoided from this account; everything else is controlled
by the party shape the connector builds. That the suite never called `start` at all is why the
`personal_number` 409 was discoverable only in production.

## Testing

`ScriveMock` implements the endpoints in memory, so the whole lifecycle runs without a provider
account — credential resolution, egress, health, retry, and the dispatch → sign → reconcile loop
(a test signs the mock's parties, then drives `runPlatformSweep`).

**What a mock proves:** that our shape works. **What it cannot prove:** that our reading of
Scrive's API is correct at the one step the testbed cannot reach — the BankID signature and its
`get` shape. The mock *is* our reading; green here meant *ready to check against the testbed*, and
the outbound half now has been (caveat 2 is the residue).
