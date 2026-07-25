# @substrat-run/docs

## 0.1.2

### Patch Changes

- e6f6f6c: ci: auto-deploy the platform apps — a changeset release deploys them to prod
  (gated on `changesets.published`), and every green push to main deploys to a
  shared test env (gated on `TEST_ENV_READY` until the test resources exist).
  Adds `[env.test]` wrangler blocks + `cf:deploy:test` scripts and makes the
  migration preflight `--env`-aware.

## 0.1.1

### Patch Changes

- 6abbce9: **Standardize the deploy script name to `cf:deploy` across all deployable workspaces.** control-plane,
  router, and docs used `deploy`, which collides with pnpm's built-in `deploy` command (`pnpm deploy` →
  `ERR_PNPM_NOTHING_TO_DEPLOY`, needing `pnpm run deploy`). They now use `cf:deploy` — matching dashboard,
  the demos, and the external-vertical example — so `pnpm cf:deploy` just works. Docs references updated.

## 0.1.0

### Minor Changes

- bb7de09: **Docs: catch the site up to the self-serve-deploy era.** The site had drifted ~40 commits behind
  — the whole CLI / deploy / platform-app / scope-local-permissions arc was undocumented, and a
  handful of pages had gone stale against the code.

  New pages:

  - **Guide → Deploying a vertical** — the `substrat` CLI (`login`, `push`), the push-lands-pending /
    admission-gates-serving model, and the laptop → console → router path. Wired into getting-started
    and running-locally.
  - **A Platform section** — the four surfaces that run the verticals: the shared **control plane**,
    the operator **console**, the environment **router**, and the tenant-facing **dashboard**.
  - **Three missing vertical pages** — **Callout** (the canonical reference vertical, previously
    undocumented), **Handlebar**, and **Kallkälla/shop** — plus links from the verticals index.
  - **`@substrat-run/oidc-rp` reference** — the shared AuthHero relying party behind the platform
    apps.

  Rewrites for landed architecture:

  - **Scope-local permissions** — `concepts/permissions.md` and the `adapter-cloudflare` reference now
    describe projection-on-write and the control-plane-optional host mode, replacing the old
    per-request-control-plane-read model. The adapter Status section drops the router / scope-local
    claims it listed as unbuilt (both shipped).
  - **Auth** — `concepts/identity.md` records that the platform apps consolidated onto AuthHero OIDC
    while demos stay Better Auth.

  Corrections: Scrive is documented as **published `0.1.0`** (was "private, unpublished");
  `protocolContentHash`'s real signature (no `ctx`); the **invites** engine added to the engines
  overview; the booking state machine's true terminal transitions and two missing in-scope functions;
  `facility` / `number` added to two documented event payloads; the `what-is-substrat` status table
  refreshed with every engine, demo, connector, the CLI, and the platform surfaces.

## 0.0.2

### Patch Changes

- d212f5d: Docs: place Substrat against the tools people already know.

  - New guide page **How Substrat compares** — frames the market as a three-way choice
    (governance without code / code without governance / both in a walled garden) and
    positions Substrat as the missing fourth corner, then walks the neighbors one by one
    (templates, prompt-to-app, BaaS, low-code, Salesforce/ServiceNow, Odoo/Frappe, Medusa,
    assemble-it-yourself) and closes with when Substrat is the _wrong_ tool. Category-level
    and evergreen, not a feature scoreboard.
  - New **"What an engine is _not_"** section on the engines overview — contrasts an engine
    against the four pictures readers arrive with: an Odoo app, a Medusa v2 module (the real
    cousin), a Rails engine/plugin, and a microservice.
  - Wire the new guide page into the sidebar after "Why runtime enforcement?".
