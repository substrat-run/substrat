# @substrat-run/docs

## 0.1.4

### Patch Changes

- 3ddbbe1: feat(console,docs): make the directory backup observable (#40)

  The mechanism landed with no way to ask whether it is working, and a backup nobody has
  looked at is a belief rather than a guarantee — a cron cannot raise an alarm about its own
  absence.

  **Console → Settings → Recovery.** Freshness of the newest copy (Current / Late / Stale
  against the daily cadence), how many are held, total size, the copies themselves, and a
  **Back up now** button for the pre-migration checkpoint. An unbound store renders as the
  alarm it is — _this control plane keeps no copy of its own directory_ — which is why the
  route answers 501 rather than an empty list: "nothing held" and "nobody is looking" must
  not read alike. An overdue copy points at the sweep rather than the backup, and says so,
  because the cadence guard catches a missed tick up on the very next pass.

  Deliberately **no Restore button.** Replacing the directory has a blast radius of every
  tenant at once — past what a type-to-confirm dialog can carry — and the disaster it answers
  is one where the directory is _gone_, so a recovery path that assumes a working console is
  not there when it is needed. Restore stays a deliberate API call from the runbook, and the
  panel links to it rather than performing it.

  **Docs:** a _Backup and recovery_ section on the control-plane page — which failure each
  instrument covers (PITR for scope data, the reap copy for teardown, snapshots for a
  non-destructive copy, and the directory backup for the map itself), RPO/RTO, the rehearsed
  restore, and the honest limits (survives losing the directory, not the account; does not
  bring back the D1 staff roster, worker secrets, or sealing keys). `concepts/snapshots.md`
  already drew the "not backup/PITR" line, so it now points onward from exactly where a
  reader arrives with the question. Self-hosters get the note that matters most to them: on
  SQLite there is no PITR underneath, so this pair is not a second line of defence but the
  only one.

  The control-plane dev server binds an in-memory directory-backup store, so the Recovery tab
  is drivable locally.

## 0.1.3

### Patch Changes

- f9db289: `substrat push` resolves its workspace from the project, never the machine: `--tenant` →
  `SUBSTRAT_TENANT` → a `"substrat": { "tenant" }` pin in the vertical's `package.json`. The
  machine-wide login default is deliberately out of the chain — the first push of a slug
  **claims** `<workspace>/<slug>` for whatever workspace resolved (builder-plane.md §5), so a
  stale global default silently pointing at the wrong workspace would claim the vertical for
  the wrong owner.

  A first interactive push with no pin lists your workspaces (whoami), auto-selects a sole
  one, and offers to write the pin into `package.json` — repo-scoped, reviewable, shared with
  every teammate and CI — so the question is answered once per project, not once per push. A
  non-TTY push with no pin refuses with an actionable error instead of guessing. The push
  line now prints the full target (`pushing acme-co/crm@0.1.0 …`) so the claiming workspace
  is always visible; service-token pushes are unchanged (the platform actor has no
  workspace). `promote`/`scope pull` keep the login-default fallback — ownership is already
  checked server-side there.

  `resolveAuth` gains `useDefaultTenant: false` and a `kind: 'session' | 'service'` field;
  `readVerticalMeta` reads the new `substrat.tenant`; new `pinTenant(dir, tenant)` writes it
  back preserving the file's indentation. Docs: CLI reference gets the full command surface
  (`whoami`, `versions`, `publish`/`unpublish`, flagless `push` defaults table, first-push
  transcript) and the deploying guide explains the per-project pin.

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
