# @substrat-run/demo-ticket0

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
