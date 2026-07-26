# Scrive (e-signing)

Turns a signature request from the [protocol engine](/engines/protocol/) into a real signing
flow at **Scrive**, authenticated with Swedish **BankID**.

::: warning Published (0.1.0), with two honest caveats a consumer must own
Both halves work and it now ships as a public package: a request becomes a started Scrive document
(**outbound**, verified against `api-testbed.scrive.com`), and a completed signature is recorded
back into the scope (**inbound**, via `reconcileScriveDispatch` on the [authority seam](/connectors/#the-seam-a-connector-plugs-into)).
It is a `0.x` release, which already signals an unstable surface, and two caveats travel with it —
neither in the connector code: **the consuming vertical must schedule the poll on a timer**
(`sweepScriveReconciliations` via `startPlatformSweeper` on node, or `definePlatformSweeperDO` —
a self-re-arming Durable Object alarm in `@substrat-run/adapter-cloudflare` — on Workers; see the
[scheduler](https://github.com/substrat-run/substrat/blob/main/docs/design/scheduler.md)),
and **BankID-to-sign is disabled on the testbed account**, so the real signing round-trip is
unverified. See [What's missing](#what-s-missing).
:::

## At a glance

| | |
|---|---|
| **Provider** | Scrive eSign, `se_bankid` authentication-to-sign |
| **Category** | E-signing & identity |
| **Status** | Published `0.1.0` — both halves built (outbound + return path + poll driver); two caveats: the vertical must schedule the poll, and BankID is off on the testbed |
| **Package** | `@substrat-run/connector-scrive` (published, `0.1.0`, public) |
| **Consumes** | `protocol.signatures-requested` |
| **Registered with** | `registerConnector('scrive', 'protocol.signatures-requested', …)` |

## What it consumes

The [protocol engine](/engines/protocol/model) emits `protocol.signatures-requested` when a
vertical freezes a document and sends it for signature. This connector only answers when the
event's `method` is `scrive` — a vertical asking for BankID through another provider emits the
same event, and this must not answer for it.

The payload it reads is **fat by design** — a connector cannot read the vertical's tables, so
everything it needs travels on the event: the template key and version, the content hash, the
bound document hash, and the parties (each with a label, a `principal` / `external` kind, and a
`primary` / `counter` signature kind).

## The credential

The connection stores Scrive's **OAuth1 personal access credentials** — four parts:

```json
{ "clientId": "…", "clientSecret": "…", "tokenId": "…", "tokenSecret": "…" }
```

sealed at rest by the host's `SecretBox`. They combine into a PLAINTEXT signature header on every
call (`oauth_signature="<clientSecret>&<tokenSecret>"`); there is no token exchange.

::: tip Verified against reality
The connector was first written for OAuth2 bearer tokens, from the docs. A live call to the
testbed rejected that immediately — Scrive's UI labels "Client credentials" and "Token
credentials" are two *halves* of one credential, not two schemes. This is the
[connector seam's](/connectors/) "green means ready to check, never verified" caveat cashing
out, and why the connector carries an opt-in test that runs against `api-testbed.scrive.com`
when credentials are present.
:::

**A personnummer is never stored.** When a party signs with BankID, their Swedish personal
number is passed *through* to Scrive on the signing request and kept nowhere: it is `direct` PII,
and the protocol engine deliberately records an opaque `DataSubjectId` as the signatory instead.
The provider needs the number; our tables must not have it.

## The flow

Given a `scrive` signature request, the connector:

1. **Renders an attestation sheet** — a one-page PDF naming the template, the parties, and the
   content hash the signature refers to. This is **not the contract**: rendering the real avtal
   belongs to the vertical that owns its content (see [What's missing](#what-s-missing)). The
   PDF writer is dependency-free and web-standard, and its text encoder *throws* on any character
   it cannot represent rather than substitute silently — PDF text is WinAnsi, where an unmapped
   character otherwise turns an em-dash into a euro sign on a document someone is about to sign.
2. **Creates the document** — `POST /api/v2/documents/new`.
3. **Attaches the file** — `POST …/setfile`. Separate from creation in Scrive's own API, which
   is what makes the no-file creation step possible.
4. **Sets the parties** — `POST …/update`, mapping each `external` party to `se_bankid` and each
   `principal` party to `standard`. An external signatory (a new hire on their first day, with no
   account) authenticates with BankID; the issuing principal need not.
5. **Sets a capability callback URL** — an unguessable secret in the path, because Scrive's
   callbacks carry **no signature to verify**, so a callback can only ever be a *hint* to re-read
   the document, never a trusted fact.
6. **Starts it** — `POST …/start`. The document is now `pending` and the parties are invited.
7. **Records the dispatch** in a directory-side ledger (`putConnectorState`, keyed by the
   connection), carrying the document id, the frozen content hash, and each party's request id and
   signatory ref. Two jobs: a redelivery finds this row and **skips** instead of sending a second
   document, and the poll driver reads it to map a signed party back to the request it resolves.
   Directory-side because a connector runs *inside* the scope's dispatch and re-entering the scope
   actor deadlocks.

Retry is tuned for a contract, not a directory write: **8 attempts**, 5-second base backoff, up
to a 15-minute ceiling. Giving up on a signature after the executor default of five tries would
be giving up on a contract.

## Reaching the signature back

Once a party signs, Scrive changes the document status, and the connector records that signature
onto the protocol instance in the scope. Two ways to learn of the change; this connector is built
for the first, and the second is a later optimization on the *same* write-back:

- **Polling** — `GET /api/v2/documents/{id}/get` returns the full document and its status. This
  needs no ingress at all, which is why webhook transport
  ([#96](https://github.com/substrat-run/substrat/issues/96)) is *not* on the critical path.
- **Webhooks** — Scrive can POST on status change, but unauthenticated, so the callback URL is a
  capability and the body is never trusted. A webhook is an optimization over polling, not a
  replacement for it — even with one, the handler re-reads `…/get` and runs the same reconcile.

The write-back goes through the [inbound authority seam](/connectors/#the-seam-a-connector-plugs-into):
`reconcileScriveDispatch` opens a scope stub with `getConnectorScope` — the connection acting as
itself — and records the signature by invoking `protocol/record-signature`, gated on the
connection's own `protocol:record-signature` grant (visible in the permission diff). It runs as a
**top-level operation, outside any dispatch**, so re-entering the scope is safe; it re-checks the
provider-reported content hash against the frozen one and fails closed on a mismatch; and it is
idempotent across polls. `sweepScriveReconciliations` is the poll driver over it — it enumerates
the dispatch ledger (`listConnectorState`) and reconciles every outstanding instance.

The **timer** that calls the sweep now exists for both runtimes: `startPlatformSweeper` (node, a
self-rescheduling interval — live in the Meridian demo server) and `definePlatformSweeperDO`
(`@substrat-run/adapter-cloudflare`, a self-re-arming Durable Object alarm — chosen over a cron
because a vertical pushed into a Workers-for-Platforms dispatch namespace gets no `triggers.crons`).
Both drive the same `runPlatformSweep` (the kernel's
[scheduler](https://github.com/substrat-run/substrat/blob/main/docs/design/scheduler.md) unit of
work), and the control-plane worker is deliberately not the home, because its scope DO is
module-less. The call site belongs in the vertical's own runtime — what remains is a *deployed*
vertical wiring one up with a live connection.

## What's missing

Most of the gaps found by building it have since closed. What is done, and what is left:

1. ~~**Recording the provider's document id / dispatch idempotency.**~~ **Done.** A redelivery once
   created a *second* Scrive document — duplicate legal paperwork to real signatories, the sharp
   correctness problem. The connector now records each dispatch in a directory-side ledger and
   skips if a prior one is found.
2. ~~**Recording a signature.**~~ **Done** via the
   [authority seam (#97)](https://github.com/substrat-run/substrat/issues/97): `reconcileScriveDispatch`
   records it as the connection, through `getConnectorScope`.
3. ~~**Connector state has no home.**~~ **Done** — the dispatch ledger above is that home
   (`putConnectorState` / `listConnectorState`).
4. **No document store.** There is still no place for rendered document *bytes*, which is why this
   sends an attestation sheet rather than the avtal, and why the real contract's rendering waits on
   the vertical plus a store.
5. ~~**Nothing schedules the poll.**~~ **Done — both triggers ship.** `startPlatformSweeper`
   drives the sweep on node (wired in the Meridian demo server), and `definePlatformSweeperDO`
   (`@substrat-run/adapter-cloudflare`) drives it on Workers: a singleton Durable Object whose
   alarm runs one `runPlatformSweep` pass and re-arms only after the pass settles — non-overlap
   by construction, and it works inside a Workers-for-Platforms dispatch namespace, where crons
   do not ([#96](https://github.com/substrat-run/substrat/issues/96), the poll path). What's left
   is deployment wiring, not a timer: a hosted CP-less vertical holds no connection directory to
   enumerate, so its sweep waits on connections becoming reachable from the vertical's runtime.
6. **BankID-to-sign is disabled on the testbed account**, so `start` returns 409 for `se_bankid`
   and the real BankID signing round-trip (and Scrive's live `get` party shape and order) cannot
   be verified yet. The live test uses `standard` auth until it is enabled.

Because the return path landed, the connector no longer takes a required write-back callback: the
callback URL is now **optional** (polling is a complete strategy on its own), and where it is set,
a callback is only ever a hint to re-read — never a trusted fact.

## Testing without an account

`ScriveMock` implements the documented endpoints in memory, so the whole outbound lifecycle runs
without a Scrive account. What it proves is that *our shape* works — credential resolution,
egress, the document lifecycle, retry. It **cannot** prove our reading of Scrive's API is
correct, because it *is* that reading: same author, same misunderstandings, on both sides of the
call. A green suite means "ready to check against `api-testbed.scrive.com`", never "verified."
