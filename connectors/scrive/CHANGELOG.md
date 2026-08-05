# @substrat-run/connector-scrive

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
