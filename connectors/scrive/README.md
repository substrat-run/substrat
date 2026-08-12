# @substrat-run/connector-scrive

Scrive eSign (Swedish **BankID**) for Substrat: turns a vertical's signature request into a real
Scrive signing flow, and records the completed signatures back into the scope. A **connector** is
host code — you register it on a scope host; it is never module code.

**Full documentation: https://substrat.net/connectors/scrive**

## What it does

Two halves, both built and tested against the real testbed API.

**Outbound.** `engine-protocol` emits `protocol.signatures-requested` when a vertical freezes a
document and sends it for signature. The connector (only for `method: 'scrive'`) turns that into a
Scrive document: **create → set file → set parties → start**, external signatories on `se_bankid`.
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
import { registerScriveConnector, sweepScriveReconciliations } from '@substrat-run/connector-scrive';

// 1. Register the connector on the scope host (host code, like an engine module).
registerScriveConnector(host, { baseUrl: SCRIVE_TESTBED /* or SCRIVE_PRODUCTION */ });

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
//    Node:        startPlatformSweeper(host, { sweepers: { scrive: sweepScriveReconciliations }, intervalMs })
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

2. **The live BankID signing round-trip is unverified.** The outbound lifecycle is checked against
   `api-testbed.scrive.com`, but `se_bankid`-to-sign is **disabled on the testbed account**
   (`start` → 409), so the actual signature — and Scrive's real signed-`get` party shape and order
   — have only been exercised against `ScriveMock`. Because the reconcile fails closed on a
   party-shape mismatch, a wrong assumption *skips* (visibly, in the sweep result), never
   mis-records. It stays a `0.x` release for this reason.

3. **It sends an attestation sheet, not the avtal.** A one-page PDF naming the template, the
   parties, and the content hash the signature refers to — honest for a hash-attestation model,
   but not the contract itself. Rendering the real document belongs to the **vertical** (a
   connector cannot read another module's tables), and it needs a document store that does not
   exist yet (`attachmentTargets` is declared in the manifest contract and implemented nowhere).

## Verified against the testbed

The API layer was checked against `api-testbed.scrive.com`, not just the docs — and the first
version, written from the docs, was wrong in three ways one live call exposed at once:

- **auth is OAuth1 PLAINTEXT**, not OAuth2 bearer (the UI's "Client" + "Token" credentials are
  two halves of one four-part signature; the `oauth2.scrive.com` endpoint rejects them)
- **`documents/new` returns no `status`** — only `get` does, so mutation responses are parsed for
  their id and status is re-read
- **`setfile` is `multipart/form-data`**, not a base64 body

`test/live.test.ts` runs the real lifecycle (`new → setfile → update → get`) when
`connectors/scrive/.dev.vars` holds a complete OAuth1 credential, and **skips** otherwise — so CI
without secrets stays offline and a local run against the testbed verifies the actual API. It uses
`standard` auth because `se_bankid`-to-sign is disabled on the account (see caveat 2).

## Testing

`ScriveMock` implements the endpoints in memory, so the whole lifecycle runs without a provider
account — credential resolution, egress, health, retry, and the dispatch → sign → reconcile loop
(a test signs the mock's parties, then drives `runPlatformSweep`).

**What a mock proves:** that our shape works. **What it cannot prove:** that our reading of
Scrive's API is correct at the one step the testbed cannot reach — the BankID signature and its
`get` shape. The mock *is* our reading; green here meant *ready to check against the testbed*, and
the outbound half now has been (caveat 2 is the residue).
