# @substrat-run/demo-ticket0

## 0.3.6

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
- Updated dependencies [ee70af5]
  - @substrat-run/adapter-cloudflare@0.98.0
  - @substrat-run/adapter-sqlite@0.98.0
  - @substrat-run/contracts@0.98.0
  - @substrat-run/kernel@0.98.0
  - @substrat-run/vertical-host@0.98.0
  - @substrat-run/engine-metering@0.5.4
  - @substrat-run/dev-issuer@0.1.13
  - @substrat-run/vertical-auth@0.12.1

## 0.3.5

### Patch Changes

- Updated dependencies [9fcfebc]
- Updated dependencies [59121f6]
  - @substrat-run/vertical-host@0.97.0
  - @substrat-run/vertical-auth@0.12.0
  - @substrat-run/contracts@0.97.0
  - @substrat-run/kernel@0.97.0
  - @substrat-run/dev-issuer@0.1.12
  - @substrat-run/engine-metering@0.5.3
  - @substrat-run/adapter-cloudflare@0.97.0
  - @substrat-run/adapter-sqlite@0.97.0

## 0.3.4

### Patch Changes

- Updated dependencies [218d39a]
- Updated dependencies [db5a3da]
- Updated dependencies [d0cde56]
  - @substrat-run/vertical-host@0.96.0
  - @substrat-run/contracts@0.96.0
  - @substrat-run/kernel@0.96.0
  - @substrat-run/adapter-cloudflare@0.96.0
  - @substrat-run/adapter-sqlite@0.96.0
  - @substrat-run/engine-metering@0.5.2
  - @substrat-run/dev-issuer@0.1.11
  - @substrat-run/vertical-auth@0.11.1

## 0.3.3

### Patch Changes

- Updated dependencies [2b53117]
  - @substrat-run/vertical-auth@0.11.0
  - @substrat-run/dev-issuer@0.1.10

## 0.3.2

### Patch Changes

- Updated dependencies [f065a84]
- Updated dependencies [301ac66]
- Updated dependencies [7bf77df]
- Updated dependencies [4f641a7]
  - @substrat-run/contracts@0.95.0
  - @substrat-run/engine-metering@0.5.1
  - @substrat-run/adapter-cloudflare@0.95.0
  - @substrat-run/adapter-sqlite@0.95.0
  - @substrat-run/dev-issuer@0.1.9
  - @substrat-run/kernel@0.95.0
  - @substrat-run/vertical-auth@0.10.1
  - @substrat-run/vertical-host@0.95.0

## 0.3.1

### Patch Changes

- 35147a9: The model runtime is bound only for a vertical that declares it (#1054). `substrat.usesModels` in package.json travels with the version, like `outbound` and `sendsEmail`, and the control plane binds `env.AI` only when the platform allows it AND the version asked — so the capability appears in a manifest diff a human reads at admit, rather than being granted to every pushed script. `ModelHost.status()` now applies exactly `createModel()`'s rule: only a row declaring a binding transport is credential-free, so a direct row's factory no longer reports a keyless provider as configured.
- 35147a9: Hosted verticals reach Workers AI through a **binding**, not a credential (#1054). A provider row may declare `binding`, meaning it is also reachable through a runtime capability rather than over HTTP with a token; `createModelHost({ aiBinding: env.AI })` supplies it, and the control plane binds `env.AI` on every pushed script. The `cloudflare` row is then runnable with no `CLOUDFLARE_AI_*` set anywhere — nothing on the script to read, leak or rotate, and Workers AI bills the account that owns it. The HTTP transport is unchanged for hosts that have a token (the local builder studio). Also replaces the default model: `@cf/meta/llama-3.1-8b-instruct` was deprecated on 2026-05-30 and fails at runtime; the default is now `@cf/meta/llama-3.1-8b-instruct-fast`.
- Updated dependencies [b91753e]
- Updated dependencies [225bb69]
- Updated dependencies [692cb92]
- Updated dependencies [d8c5ca9]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [24b6855]
- Updated dependencies [568ba88]
- Updated dependencies [1fc01d3]
- Updated dependencies [733469b]
- Updated dependencies [35147a9]
- Updated dependencies [35147a9]
  - @substrat-run/engine-metering@0.5.0
  - @substrat-run/vertical-auth@0.10.0
  - @substrat-run/contracts@0.94.0
  - @substrat-run/adapter-sqlite@0.94.0
  - @substrat-run/adapter-cloudflare@0.94.0
  - @substrat-run/kernel@0.94.0
  - @substrat-run/dev-issuer@0.1.8
  - @substrat-run/vertical-host@0.94.0

## 0.3.0

### Minor Changes

- 9606869: ticket0 answers through the platform's model host (#1054, step 4). The per-install `CF_ACCOUNT_ID` / `CF_AI_TOKEN` settings are gone; a desk's setting is only `TICKET0_MODEL`, a `provider:model` from the platform catalog (default `cloudflare:@cf/meta/llama-3.1-8b-instruct`), run on the platform's credential. `record-answer` takes the host's usage line beside the token counts and raises it to the platform ledger as a `model-usage` intent in the same transaction as the meter entries. Settings → Assistant shows where inference runs (vendor, location, what is sent) and, when the platform cannot run the chosen model, exactly which credential it is missing. `ModelHost.status` now carries that hosting disclosure.

### Patch Changes

- Updated dependencies [4bbcf6b]
- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
- Updated dependencies [0a536b7]
- Updated dependencies [9606869]
  - @substrat-run/vertical-host@0.93.0
  - @substrat-run/contracts@0.93.0
  - @substrat-run/kernel@0.93.0
  - @substrat-run/adapter-sqlite@0.93.0
  - @substrat-run/adapter-cloudflare@0.93.0
  - @substrat-run/engine-metering@0.4.3
  - @substrat-run/dev-issuer@0.1.7

## 0.2.0

### Minor Changes

- c25c74d: ticket0: the assistant's failures are visible in the desk, with their reason.

  - A failed turn now carries `error` — why it failed, in the words of whatever threw
    (migration `0002-add-ticket0_ai_turns-error`). `record-answer` accepts it (additive,
    optional) and `list-turns` returns it. The conversation view draws a failed turn as a
    "could not answer" card with the reason, in place of an internal note that said only
    that it had given up.
  - `answerConversation` records a failed turn for an index that refused, not just for a
    model that threw; the reason used to leave with the exception.
  - New `ticket0/record-assistant-failure` (`conversation:widget`, entity-narrowed): when the
    assistant itself cannot act — no service principal, no role, its first call refused — the
    host records the failure through the widget, the principal that just accepted the
    message. Both hosts do this from their `catch`; the worker's used to be bare and silent.
  - New `ticket0/assistant-health` (`desk:configure`) and `GET /api/assistant/status`, behind
    Settings → Assistant: which model this install would answer with (and a plain warning
    when it is `offline/extractive` because no `CF_ACCOUNT_ID`/`CF_AI_TOKEN` is set), the
    last day's turn and failure counts, and the newest failures linked to their conversations.

- 7843c4f: The client half of a request, normalised once. `@substrat-run/contracts` gains `ClientContext` — the browser, OS and device kind parsed out of the `User-Agent` (`parseUserAgent`), the preferred language, and a geo (country, region, city, timezone, continent) — plus `clientContextOf(headers, geo?)` to build one from the headers every host has. `@substrat-run/adapter-cloudflare` gains `cloudflareClientContext(request)` / `cloudflareGeo(cf)`, the one place `request.cf` is read: Cloudflare's `T1`/`XX` country sentinels become null, the region is the name rather than the code, and latitude, longitude and postal code are not carried. No IP address in either.

  ticket0 stores it: `ticket0/widget-start` takes an optional `client`, the widget surface supplies it from the request (the worker via the Cloudflare adapter, the dev server from headers alone), `ticket0_widget_openings` and `ticket0_widget_sessions` each grow the same eleven nullable columns for it (the opening records them, the first message carries them onto the session), and a new staff read `ticket0/widget-session` (`GET /conversations/{id}/widget-session`, `conversation:read`) returns the latest session minus its token hash. The inbox rail shows it as "Safari 17 on iOS · Stockholm, Sweden · 03:12 their time".

### Patch Changes

- aad0e26: fix(ticket0): opening the widget opens a session, not a conversation

  Every `widget-start` used to open a conversation and mint a blank contact on the spot, so
  the inbox showed an empty "Chat" for every curl, every crawler that ran the script, and
  every visitor who clicked the bubble and left — the live desk on substrat.net held three
  threads for one real chat. `spec/concept.md` had already promised the opposite: an
  anonymous visitor is not a record, and the desk creates nothing on their behalf that
  anybody has to clean up later.

  - A new `widgetOpening` entity (`ticket0_widget_openings`) holds a session until its first
    message: token hash, origin, and — for a visitor the host site vouched for — the contact.
    The first `widget-post` opens the conversation (and the anonymous contact with it) and
    moves the row into `ticket0_widget_sessions` under the same id and token, so the widget
    holds the same session throughout and never learns the difference.
  - `widget-thread` on an opening answers an empty page rather than a refusal: the widget
    polls before anything is said, and a 404 would make it discard the session.
  - `widget-start` no longer returns `conversationId` (the widget never read it), and
    `ticket0.widget-session-started` is at `schemaVersion: 2`: it is about the opening, and
    `conversationId` left its payload.
  - Its own table rather than a nullable `conversation_id`: the journal cannot relax a
    `NOT NULL` in place, and would have reported up-to-date over a live table that still
    refused NULLs. One appended migration, `CREATE TABLE` only.
  - Scenario: a session open leaves the conversation and contact counts unchanged and reads
    an empty thread; the first message adds exactly one of each and the same session reads
    it back. The seed finds the customer's contact by external id instead of through a
    conversation that no longer exists at that point.

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0
  - @substrat-run/adapter-cloudflare@0.92.0
  - @substrat-run/engine-metering@0.4.2
  - @substrat-run/adapter-sqlite@0.92.0
  - @substrat-run/dev-issuer@0.1.6
  - @substrat-run/kernel@0.92.0
  - @substrat-run/vertical-host@0.92.0

## 0.1.3

### Patch Changes

- 1242a9c: fix(ticket0): a desk admin can add and remove widget origins, and what is kept is an origin

  The hosted desk on substrat.net answered every widget preflight from `https://substrat.net`
  with 403 — "this desk is not embedded on https://substrat.net". The allowlist is desk data
  (`ticket0/widget-origins` reads `ticket0_desk_settings.allowed_origins`), the hosted worker
  never seeds it, and Settings → Desk rendered the list read-only: no input to add one, a
  `Remove` button that was disabled. A hosted desk had no way to embed its own widget anywhere.

  - Settings → Desk → Widget origins now has an input + Add (Enter works), a working Remove,
    and an empty-state line saying the widget is refused everywhere until an origin is added.
  - `configure-desk` reduces each entry to its `URL.origin` and dedupes. The input schema
    asks for a URL, the browser sends an origin, and `widget-start` compares by string —
    so `https://substrat.net/` or a page path pasted from the address bar used to save
    cleanly and never match. A non-http(s) URL is refused with `validation_failed`.
  - Scenario: a page URL admits the page it came from; `mailto:` is refused; the seeded
    desk is restored after.
  - @substrat-run/contracts@0.91.1
  - @substrat-run/kernel@0.91.1
  - @substrat-run/adapter-sqlite@0.91.1
  - @substrat-run/adapter-cloudflare@0.91.1
  - @substrat-run/vertical-host@0.91.1

## 0.1.2

### Patch Changes

- 75bd27c: The owner seat is claimed by whoever signs in first — for fifteen minutes, and then by a claim link (#925)

  A hosted vertical's owner seat is minted empty at provision and bound to a human by the first
  verified subject to arrive. That is the right trade in the install flow, where the installer
  opens the app seconds later. It was the wrong trade everywhere else: the window was unbounded
  in time and in audience, so a CI-deployed instance whose issuer had open sign-up sat as a seat
  anyone could take, indefinitely — and nothing anywhere said it was open. A re-provision made
  it worse: `INSERT OR REPLACE` re-minted the pending seat on every reconcile, so a sweep could
  hand a claimed desk's ownership to the next stranger to sign in.

  **`@substrat-run/vertical-auth`** — the rules now live in `owner-seat.ts`, unit-tested over a
  real SQLite. The first-sign-in claim closes `FIRST_SIGN_IN_WINDOW_MS` (15 min) after provision;
  a seat from before the column existed reads as closed. The seat then stays pending — `needsSetup`
  keeps saying so, and the new `ownerSeat` says _why_ — until a claim binds it. `mintOwnerClaim` /
  `claimOwner` are the claim link (only the token's hash is stored; minting again retires the
  earlier link), and `mintOwnerClaimLink` does token + hash + URL in one call. A re-provision
  keeps the window it has and never re-opens a claimed seat.

  **`@substrat-run/vertical-host`** — two flavored routes, `GET /internal/owner-seat` and
  `POST /internal/owner-claim`, over the `ownerSeat` / `mintOwnerClaim` hooks (501 without them),
  parsed on the way out as well as in. **`@substrat-run/contracts`** — the `ownerSeat` and
  `ownerClaimLink` shapes. **`@substrat-run/control-plane-api`** — `GET …/owner-seat` and
  `POST …/owner-claim` per scope, with the link's origin taken from the platform's own hostname
  directory (canonical `app` first), never from a body.

  **Dashboard** — an _Owner seat_ card on the app's Overview: claimed, unclaimed with the window
  still open (pulsing — open it now), or unclaimed and closed, with a _Get claim link_ button.
  The link is shown once and stored nowhere.

  **The four verticals on vertical-auth** (callout, meridian, manyfold, ticket0) — `/api/me`'s
  `needs-setup` answer now carries `firstSignInOpen`, the SPAs say which way in applies instead
  of offering a sign-in that binds nobody, and `?claim=<token>` → `POST /api/claim-owner` is the
  counterpart of the invite flow.

  Not built: binding from the projected identity links (#406). The dashboard links identities
  under the platform's own pool, and a hosted app's issuer is always an external one or a team
  Auth Server — so no link would ever match, and matching on `sub` alone would be the cross-pool
  bind the issue warns against.

- 0822167: A desk admin can add a documentation source, and a read that fails says so on the row

  Settings → Knowledge base listed the desk's sources and offered "Re-read", and that was
  all: `ticket0/add-kb-source` existed, `desk-admin` held `kb:manage`, and no screen ever
  called it. Two more things stood between an admin and a source that actually worked.
  "Re-read" called `/kb/sources/:id/ingest`, which records the intent and emits — the fetch
  lives on a separate `/refresh` route the hosted worker mounted and nothing ever called, so
  on a hosted desk a re-read spun at `ingesting` for good. And nothing anywhere wrote
  `status = 'failed'`: a URL that could not be read — the likeliest thing a person types —
  spun the same way, with the reason on the dev server's stdout and nowhere else.

  - **`ticket0/record-kb-ingest-failure`** (new, `kb:manage`, entity-scoped, emits
    `ticket0.kb-ingest-failed`): the other half of `record-kb-articles`. Marks the source
    `failed` with the reason and leaves `last_ingested_at` alone — it is when the last GOOD
    read happened, which is what the desk wants to know once one fails.
  - **`harness/kb-refresh.ts`** — `readSource()` marks, fetches, records the articles or
    the failure, and `mountKbRefresh()` mounts `POST /api/kb/sources/:id/refresh` (502 with
    the reason on a failed read). The worker's inline route is replaced by it, the dev server
    mounts the same one, and its boot-time ingest goes through it too, so the two hosts
    cannot drift and a boot-time failure lands on the row.
  - **The screen** gains "Add a source" — label, URL, kind — which adds and reads at once.
    Only `llms.txt` and `Markdown` are offered: `sitemap` is in the model but the fetcher
    does not implement it, and a control that always fails is worse than none. "Re-read"
    now hits `/refresh`. A failed row shows the reason and whether a last good copy exists.
  - A network failure names the URL (`could not reach …`) rather than the runtime's bare
    `fetch failed`, since the message is what the row shows.

  Additive: the new operation joins `openapi.json`, `api.generated.ts`, `model.json` and
  `CONFORMANCE.md` through their gates; no permission key or role changed.

- c2d5c2a: The ticket0 support widget on one docs page. `widget.js` now keeps one widget per page and exposes `window.ticket0.unmount()` for a host with a client-side router; the docs site mounts it at `/guide/support` through a `Ticket0Widget` theme component that tears it down on navigation.
- Updated dependencies [75bd27c]
  - @substrat-run/vertical-auth@0.9.0
  - @substrat-run/vertical-host@0.91.0
  - @substrat-run/contracts@0.91.0
  - @substrat-run/dev-issuer@0.1.5
  - @substrat-run/engine-metering@0.4.1
  - @substrat-run/adapter-cloudflare@0.91.0
  - @substrat-run/adapter-sqlite@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.1.1

### Patch Changes

- 366086d: ticket0's README says how the widget is actually embedded

  The README described the demo's ports and the substrat.net dogfood, and never the one
  thing a reader of this vertical arrives wanting: the tag you put on your own page. So
  `widget/widget.js` was documented only by its own header comment — which meant the
  answer to "is it a script or a web component?" was a file read rather than a paragraph.

  It is a script, and the section now says so and says why: a vanilla IIFE rendering into a
  shadow root, no framework, because it runs on somebody else's page and neither side's CSS
  should reach the other. Four attributes in a table (`src`, which is also the default API
  base, so nothing is baked in at build time; `data-api`, which only the demo needs;
  `data-user` and `data-signature`, both or neither).

  The two mechanisms behind it get named where a reader will look for them rather than only
  in the code that implements them:

  - **`data-signature` is `HMAC-SHA256(desk secret, data-user)`, computed by the embedding
    site's server** — Intercom's `user_hash`. Where the secret comes from
    (`POST /api/desk/verification-secret`, shown once, every read of the desk omitting it)
    and what rotating it costs (every signature that site is currently producing) are the
    parts a reader needs before they wire it, not after.
  - **The origin allowlist is checked against the `Origin` header, in middleware.** The
    section keeps the reason the check is where it is: withholding
    `access-control-allow-origin` stops a browser _reading_ a response and does nothing to
    stop the write behind it, so a refusal that lived beside the handler would be a refusal
    the write had already passed.

  Also written down: the session token in `localStorage` and its silent replacement when it
  no longer names anything, the polling cadence _as the stopgap `widget.js` already calls it_
  (the answer is a WebSocket on the scope's DO, and neither the router nor the DO carries an
  `Upgrade` today), and why `scripts/copy-widget.mjs` is a copy rather than an import — the
  file is not part of this app's import graph, it is part of somebody else's page.

  Documentation only. No code, no schema, no permission changes.

- Updated dependencies [7b50231]
  - @substrat-run/contracts@0.90.1
  - @substrat-run/kernel@0.90.1
  - @substrat-run/adapter-sqlite@0.90.1
  - @substrat-run/adapter-cloudflare@0.90.1
  - @substrat-run/vertical-host@0.90.1

## 0.1.0

### Minor Changes

- 807502f: ticket0 becomes a pushable vertical

  `substrat push` refused it with "nothing to build: no `substrat.runtimeNeeds` in
  package.json and no wrangler.jsonc", and the refusal was right — ticket0 had no
  Cloudflare side at all. `src/server.ts` is a node host (`@hono/node-server`, `node:fs`,
  adapter-sqlite, the dev issuer), and there was nothing else. It now has `src/worker.ts` in
  the sandbox-clean, control-plane-less shape — one `ScopeDO` per desk plus the shared
  per-tenant `IdentityDO`, OIDC-only auth, `mountPlatformSurface` for the whole `/internal/*`
  contract — and a `substrat.runtimeNeeds` block the CLI derives the deploy config from.

  **`MODULES` and `ROLES` move to `src/provision.ts`.** They lived in `seed.ts`, which imports
  `node:*` and a concrete adapter, so a worker could not import them without dragging both
  into a workerd bundle. The alternative — a second copy in the worker — is the failure the
  template's playbook names: a module registered in only one of them runs locally and
  silently does not deploy. `seed.ts` re-exports, so there is still one registration.

  **The widget surface is now shared code rather than dev-server code.** `harness/widget-surface.ts`
  mounts on both hosts, which forced out an inconsistency it had been carrying. Its CORS
  layer used `hono/cors`, whose `origin` callback is synchronous, so the dev server fed it a
  list refreshed on a five-second interval while `widget-start` read `desk_settings` — two
  answers to one question, and a `configure-desk` change made them disagree in both
  directions. The middleware is hand-rolled and async now, and a new operation,
  `ticket0/widget-origins`, is where it reads the list: the same array the operation refuses
  out of, held by `conversation:widget`, which is the desk's own widget service and no human
  role. No new permission key, no migration.

  What differs between the two hosts is genuinely host-specific and all of it is in
  `worker.ts`: which desk a request belongs to (the embedding origin across two seeded desks
  on one node; the hostname the router resolved, in a hosted install), where the login lives
  (`packages/dev-issuer`; whatever issuer the tenant bound), and how a background job stays
  alive (node keeps the process up; `executionCtx.waitUntil`, or the isolate cancels the
  assistant mid-answer).

  Three things a hosted desk cannot get from a seed:

  - **Service accounts.** `/internal/provision` mints the desk's `widget`, `assistant` and
    `relay` principals once, idempotently, and records them in the tenant's identity DO. The
    assistant is minted SUPERVISED — an AI that answers customers unattended from the moment
    of install is a decision somebody should make on purpose.
  - **People.** `POST /api/invites` — `desk-admin` / `agent` at scope level, or `customer`
    with a `contactId`, which grants `conversation:read-own` on that one contact and nothing
    else. The three service roles are not invitable.
  - **A knowledge base.** A worker has no boot and a dispatch user-worker has no cron, so the
    ingest is a route rather than a schedule: `POST /api/kb/sources/:sourceId/refresh`, which
    fetches out here (module code has no network) and re-enters through the ordinary
    `record-kb-articles`, running as the caller and refused unless they hold `kb:manage`.

  `modelFromEnv` takes its environment as a required argument instead of defaulting to
  `process.env`: there are two hosts now and only one has a `process`, and the worker resolves
  the credential per install through `resolveScopedEnvSpec` — a bare `env.CF_AI_TOKEN` read
  would bill every desk on a serving script to whoever set the binding last. A desk with no
  credential still answers, extractively, labelled `offline/extractive`.

  `tsconfig.worker.json` compiles the worker's import graph with the Workers lib set and no
  node types, which is what makes a `process.env` or a `globalThis.crypto` that slipped into
  shared code a compile error rather than a runtime one in workerd. Both were there.

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/engine-metering@0.4.0
  - @substrat-run/kernel@0.90.0
  - @substrat-run/adapter-sqlite@0.90.0
  - @substrat-run/adapter-cloudflare@0.90.0
  - @substrat-run/dev-issuer@0.1.4
  - @substrat-run/vertical-host@0.90.0
