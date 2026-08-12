# @substrat-run/connector-scrive

## 0.6.1

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.6.0

### Minor Changes

- 39807d7: feat: connecting an integration means verified, not stored — and every probe names the provider environment it asked

  **The write path was still claiming more than it knew.** Upserting a credential wrote the row and
  reported success; the console said "Connected", which was a statement about our own database. The
  first evidence the provider disagreed arrived on the next dispatch or sweep — after a signature
  request had already failed.

  The relay now checks the candidate credential with the provider _before_ any write:

  - **Refused** (the provider answers 401/403) → `422`, and nothing is stored. The order is the
    whole point on a rotation: writing first would replace a working credential with a broken one.
    The provider's own message rides the response, so the connect dialog keeps what was typed and
    says what is wrong instead of "couldn't save".
  - **Unreachable** (timeout, 5xx, DNS) → stored, reported unverified. Deliberately _not_ a refusal:
    rejecting during a provider outage would make it look like every tenant's keys had gone bad, and
    would block the rotation someone is attempting because things are broken. `ConnectionProbe.refused`
    is what separates a provider speaking about the credential from a provider that did not answer.
  - **Accepted** → stored, and the successful pre-flight is recorded as health, so a just-verified
    connection reads "last used just now" rather than "connected, not used yet" — the same empty
    claim in different words.

  Both write paths get the gate: the dashboard's connect and a vertical's own admin screen through
  `/internal/connections/upsert`. A provider with no candidate probe registered behaves exactly as
  before — the check is available, never assumed.

  `probeScriveSecret` tests a secret that is not stored yet (no connection opened, no health written
  against the live one), and `ScriveApiError` carries the HTTP status so a 401 is _classified_ rather
  than inferred from a message string.

  **Every probe also names the environment it asked.** A production credential sent to Scrive's
  testbed returns 401 — byte-for-byte what a mistyped key returns — so a verify result that does not
  say which Scrive it called sends an operator to check the wrong thing. It is now the first fact on
  both the success and the failure answer: `production (scrive.com)`, `testbed (api-testbed.scrive.com)`,
  or the bare host.

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.5.0

### Minor Changes

- ee491fc: feat: the Integrations detail actually tells you something — which credential is loaded, and the provider's own archive (not just what we sent)

  Three gaps left by #605's first pass, all found by using the screen:

  **"Manage" opened an empty form.** On the account-level Integrations page, a connected provider's
  primary button still went to the connect dialog with four blank fields — which reads as "your
  credentials are gone". It now opens the detail; rotating is one click further in, where replacing
  a credential belongs.

  **Nothing showed which credential was loaded.** The store's write-only rule is right, but with no
  view at all "connected" and "connected with a mistyped token" looked identical, and the only
  repair on offer was to paste all four fields again blind. `GET /tenants/:t/connections/:id/credential`
  now answers a reduced view, produced by the connector — the only party that knows which of its
  fields are identifiers (Scrive's own UI calls two of the four "credentials identifier") and which
  are secrets. Identifiers come back whole; secrets come back as a bullet run plus their last four
  characters, and anything shorter than eight characters is masked entirely rather than mostly
  revealed. Enough to tell two credentials apart by eye, never enough to sign a request. There is
  still no reveal and no edit-in-place: replacing a credential is rotation.

  **Activity only showed our own dispatches.** The ledger is complete for what this platform sent
  and blind to everything else in the provider account — including documents someone created in
  Scrive's own UI, and anything sent before the connection existed. `GET …/activity?source=provider`
  lists the provider's archive instead, marking which rows came from this app (via the
  `substrat_instance` tag the connector already sets). Neither view is a superset of the other, so
  `source` travels in the answer, and the detail view offers both. Unlike the ledger read, the
  provider read refuses rather than degrading on a provider failure: an empty list would read as
  "the account is empty", which is a lie an operator would act on.

  The honesty banner and page subtitle now say what is actually true about what a console can see.

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.4.0

### Minor Changes

- 92e9e03: feat: an integration becomes something you can interrogate — verify a credential against the provider, and read what the connection has actually done

  Connecting Scrive was a leap of faith. The stored credential was never checked (a typo surfaced
  days later as a failed signing dispatch), and afterwards the only trace of an outbound call was
  health — one line, last-write-wins — because `openConnection` is deliberately unaudited: a row
  per outbound HTTP call would drown the log that matters. Everything else lived in the platform
  worker's logs, which a tenant cannot see.

  Two provider-agnostic reads close that. `POST /tenants/:t/connections/:id/verify` asks the
  provider to accept the credential right now and answers whose account it is; a refused key is a
  `200 { ok: false, error }` carrying the provider's own words, because "this feature is disabled"
  and "invalid credentials" send an operator to different places. `GET …/activity` serves the
  connector's dispatch ledger — the only durable record that a call ever happened — with `?live=1`
  joining the provider's current state, and a `live` flag so a console never presents the platform's
  record as the provider's truth.

  Both dispatch through host-injected `connectionInspectors`, keyed by provider (the `sweepers`
  idiom), so `control-plane-api` still imports no connector and an unwired provider 501s honestly.
  The activity view is the connector's own **projection**, never a raw ledger row: Scrive's rows
  carry the callback capability token, so redaction is structural rather than remembered.

  The Scrive connector gains `getProfile` and `listDocuments` (both verified against the live
  testbed — `/api/v2/getprofile`, not `/api/v2/user/getprofile`), `probeScriveConnection`, and
  `scriveConnectionActivity`. The dashboard's Integrations surfaces get a Details view: health,
  the live grants the connection holds (the readable blast radius), the activity list, and a
  Test connection action. Verifying is itself a use, so it refreshes health too.

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/kernel@0.60.0

## 0.3.3

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0

## 0.3.2

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0

## 0.3.1

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.3.0

### Minor Changes

- 336352b: Webhook ingress (#96) — the push half of the return path, beside the poll floor. A
  dispatch now mints a 256-bit capability token, remembers it on the dispatch ledger
  row, and registers `${base}/hooks/scrive/{connectionId}/{instanceId}/{token}` as the
  document's callback URL (Scrive's callbacks are unauthenticated, so the minted token
  in the URL is the entire authentication). New `handleScriveCallback` verifies a
  presented token in constant time — uniform rejection, zero provider egress without a
  match — and then runs the same idempotent `reconcileScriveDispatch` the sweep runs:
  a callback is a cache invalidation, never a fact, so no body is ever read and replay
  needs no seen-set. `ScriveMock` can now deliver callbacks (`onCallback`), so the
  full sign → callback → record loop runs offline. Breaking for config only: the
  `callbackUrl` option's argument changed from `instanceId: string` to a
  `ScriveCallbackRef` (`{ connectionId, instanceId, token }`); compose it with the new
  `scriveCallbackPath`, and mount `SCRIVE_CALLBACK_ROUTE` where the deployment serves
  HTTP.

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0

## 0.2.13

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0

## 0.2.12

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

## 0.2.11

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.2.10

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.2.9

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0

## 0.2.8

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.2.7

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.2.6

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.2.5

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.2.4

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0

## 0.2.3

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.2.2

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.2.1

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0

## 0.2.0

### Minor Changes

- b0355b4: `ScriveApi.getMainFile(documentId)` — pull the sealed signed PDF. The connector
  recorded the _fact_ of each signature and walked away from the _artifact_: it
  could create, set file, set parties, start, and get, but had no
  `GET /api/v2/documents/{id}/files/main`, so the signed PDF — Scrive's sealed copy
  with the signing evidence attached — lived only at Scrive, reachable only with the
  API credential. The legacy CRM this vertical replaces fetches that file on
  completion and offers "Ladda ned signerat avtal", so it is parity, not polish
  (issue #476, step 1). `ConnectorResponse` gains `arrayBuffer()` for provider
  responses that are a file rather than JSON (web `Response` already has it; the
  declaration only widens the structural surface). Fetch-on-completion into the
  blob store is step 2, which waits on #473.
- b0355b4: Connectors can land attachments; Scrive lands the sealed signed PDF (#476 step 2).

  #473 gave attachment bytes a home, but its `attachments()` surface is minted per
  `PrincipalId` — and a connector's return path acts as a _connection_, not a person,
  so it had no way to store a provider artifact (bytes cannot ride `getConnectorScope`'s
  `invoke` pipe). This adds the missing seam and the first consumer:

  - **`ScopeHost.getConnectorAttachments(connectionId, scopeId)`** — the mirror of
    `getConnectorScope` for bytes: the same `ScopeAttachments` surface, same
    (tenant, vertical, active) door, but every gate checked against the connection's
    `connection:<id>` grants, and `createdBy` attributed to the connection. Implemented
    in both adapters (the Cloudflare ScopeDO threads the connection subject through the
    attachment gate exactly as `invoke` does) and covered on each.
  - **`engine-protocol`** declares an explicit `protocol:attach` write permission on its
    `protocol` attachment target (read stays `protocol:read`). A signing connection is
    granted `protocol:attach` and nothing else — it can land the sealed PDF but not
    browse the scope's attachments. No human role holds it yet.
  - **`connector-scrive`** fetches `files/main` once the document is `closed` and every
    party is recorded, and lands it as a `customer`-visible attachment on the protocol
    instance. Marked in the dispatch ledger (`sealedAttachmentId`) so a re-poll never
    downloads or stores a second copy; a store that is not yet provisioned is reported
    and retried next poll, never allowed to undo a recorded signature.

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.1.31

### Patch Changes

- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.1.30

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0

## 0.1.29

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/kernel@0.39.0

## 0.1.28

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0

## 0.1.27

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0

## 0.1.26

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0

## 0.1.25

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.1.24

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0

## 0.1.23

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0

## 0.1.22

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

## 0.1.21

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.1.20

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0

## 0.1.19

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0

## 0.1.18

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0

## 0.1.17

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0

## 0.1.16

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0

## 0.1.15

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0

## 0.1.14

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0

## 0.1.13

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.1.12

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0

## 0.1.11

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0

## 0.1.10

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0

## 0.1.9

### Patch Changes

- 83aa7fd: feat: `definePlatformSweeperDO` — the Cloudflare trigger for `runPlatformSweep` (scheduler.md §3.0, the last blocker on the Scrive poll path, #96)

  A singleton Durable Object whose `alarm()` runs one platform-sweep pass and re-arms itself only
  after the pass settles — the workerd analogue of the kernel's `startPlatformSweeper`, with the
  same non-overlap guarantee (a concurrent kick joins the in-flight pass; the next alarm is a gap
  after settle, never a fixed rate; a pass that sinks whole is reported and the loop re-arms). An
  alarm rather than a cron because a hosted vertical is pushed into a Workers-for-Platforms
  dispatch namespace, where `triggers.crons` is not honoured — the alarm self-arms from code
  (`ensureArmed()`, idempotent) and needs no wrangler config; where a cron IS available, point
  `scheduled()` at `ensureArmed()` as the safety net. Exercised end to end in workerd: a real
  alarm drives the real `runPlatformSweep` against live SCOPE/CONTROL_PLANE Durable Objects.

  The Scrive connector's README now points its "schedule the poll" caveat at both shipped
  triggers (node interval / workerd alarm) and names the one remaining deployment gap: a
  control-plane-less vertical has no connection directory to enumerate, so its sweep waits on
  connections becoming reachable from the vertical's runtime.

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0

## 0.1.8

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.1.7

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

## 0.1.6

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

## 0.1.5

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.1.4

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.
- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1

## 0.1.3

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.1.2

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.1.1

### Patch Changes

- 0572a3b: **Typecheck on the native (Go) TypeScript compiler — `typescript` 5.6 → 7.**

  TypeScript 7 (the native compiler, formerly the `tsgo`/`@typescript/native-preview`
  rewrite) is now GA as `typescript@latest`. The binary is still `tsc`, so every package's
  `tsc -p … --noEmit` script is unchanged — only the toolchain pin moves. No source or
  public API changes; this bumps the published packages solely because their build now runs
  through the native compiler.

  Full-workspace `pnpm -r typecheck` drops to ~3s wall; per-package the native checker is
  roughly an order of magnitude faster (kernel 1.33s → 0.07s, control-plane-api 1.50s →
  0.12s, engine-invoicing 0.91s → 0.06s on this machine).

  Two migration deltas TS7's stricter resolution surfaced (both green on 5.6, red on 7):

  - **CSS side-effect imports (`TS2882`).** `import './ui.css'` in the six Vite app/admin
    surfaces now needs an ambient declaration. Fixed the way `demos/meridian/app` already
    did it — `"types": ["vite/client"]` in each app `tsconfig.json` (vite/client declares
    `*.css`) — rather than adding a stray `vite-env.d.ts`.
  - **`boundary-lint` node globals (`TS2584`/`TS2591`).** The linter CLI's `process`,
    `console`, and `node:fs`/`node:path` imports stopped resolving because the base tsconfig
    leaves `types` unset and TS7 no longer implicitly pulls in `@types/node` here. Added an
    explicit `"types": ["node"]` to `packages/boundary-lint/tsconfig.json`.

  Note: TS7 is a major bump that drops deprecated 5.x behavior. Editors should run their
  TS Server on 7 to keep CLI and IDE diagnostics aligned.

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/kernel@0.12.0

## 0.1.0

### Minor Changes

- 462e8c9: **Publish `@substrat-run/connector-scrive` — the first released version.**

  The connector is no longer `private`. It has been unpublished-while-incomplete since it was
  written; both halves now exist and are tested — outbound dispatch (verified against the real
  `api-testbed.scrive.com`), and the return path that records a completed signature back into the
  scope through the #97 authority seam (`reconcileScriveDispatch` / `sweepScriveReconciliations`,
  driven by `runPlatformSweep`). So it ships.

  Standard publish config, matching the other packages: `publishConfig.access: public`, `files:
["dist"]`. It stays a `0.x` release, which already signals an unstable surface — two honest
  caveats a consumer should know, both documented in the README:

  - **A deployment must schedule the poll.** The connector provides `sweepScriveReconciliations`;
    the consuming vertical calls it on a timer (`startPlatformSweeper` on node, a Cron / DO alarm on
    Cloudflare). Without that, dispatch works but signatures are never recorded back.
  - **The live BankID signing round-trip is unverified.** `se_bankid`-to-sign is disabled on the
    testbed account, so the outbound lifecycle is proven live but the actual signature (and Scrive's
    real signed-`get` party shape) has only been exercised against `ScriveMock`. The reconcile fails
    closed on a shape mismatch, so a wrong assumption cannot mis-record — it skips, visibly.

## 0.0.2

### Patch Changes

- e4db6ed: **The Scrive return path — a completed signature now records back into the scope (#97).**

  The connector's outbound half was verified against the testbed; the return path — writing a
  signature onto the protocol instance in the _scope_ — could not be written because a signature
  lives in the scope database, `getScope` demands a `PrincipalId`, and a connector is not one.
  #97 (landed in the kernel/adapters) gave a connection its own door and made its authority an
  ordinary permission grant, so this closes the connector's half:

  ```ts
  reconcileScriveDispatch(host, connectionId, instanceId, { fetch });
  ```

  It reads `documents/{id}/get`, maps each signed provider party back to its request, and records
  it by invoking `protocol/record-signature` through `getConnectorScope` — the connection acting
  as itself. It runs as a **top-level operation, outside any dispatch**, which is exactly what a
  poll driver or callback ingress is, and where re-entering the scope is safe (dispatch
  idempotency stays in the directory for the opposite reason). The connection must hold
  `protocol:record-signature` (`grantToConnection`); without it the write fails closed at the
  permission check, and the grant appears in the permission diff like any other.

  - **Idempotent across polls.** Signed requests are remembered in the dispatch ledger, so a
    re-poll of a half-signed set records only what is newly done, and a fully-signed set records
    nothing. The instance transitions to `signed` only when every party has signed.
  - **Fails closed on a party-order mismatch** rather than attributing a signature to the wrong
    request, and skips a signed party the request named no `ref` for (the connector never
    extracts the signer's personnummer).
  - The dispatch ledger grew the fields the driver needs (`vertical`, `contentHash`, and per-party
    `{requestId, kind, ref}`) — none of it derivable from Scrive's document, so it is captured at
    dispatch when the event still carries it.

  `sweepScriveReconciliations(host, connectionId, { fetch })` is the poll driver over it: it
  enumerates the dispatch ledger (`HostAdmin.listConnectorState`, added alongside) and reconciles
  every outstanding instance — skipping ones the ledger already shows complete, and stepping past a
  provider error on any single instance rather than sinking the batch. Idempotent and scoped to one
  connection.

  Verified against `ScriveMock` advanced to `closed`; the outbound live test still passes. What a
  mock cannot prove — Scrive's real `get` shape and party order — waits on a testbed BankID
  round-trip (BankID-to-sign is disabled on the account).

  **Still not publishable:** nothing calls the sweep on a _timer_ (#96, poll path). No cron, queue
  or Durable Object alarm exists in any deployment — the same trigger `drainDue` still lacks — so
  `sweepScriveReconciliations` runs from a test or by hand. That trigger is a deployment concern,
  not connector code, and is the remaining reason the connector stays unpublished.

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.0.1

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
