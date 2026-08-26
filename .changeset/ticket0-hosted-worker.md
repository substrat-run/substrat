---
'@substrat-run/demo-ticket0': minor
---

ticket0 becomes a pushable vertical

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
