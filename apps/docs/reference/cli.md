# @substrat-run/cli

The `substrat` CLI — authenticated deploy tooling. You **push** a vertical to the platform,
then manage its versions and channels. It is the client half of the
[self-serve deploy](/guide/deploying) flow: it builds your worker locally and POSTs a bundle;
the [control plane](/platform/control-plane) holds the Cloudflare credential and does the
upload, so **you never hold a platform token** (decision D-34).

Published to npm as [`@substrat-run/cli`](https://www.npmjs.com/package/@substrat-run/cli),
Apache-2.0. For the narrative walkthrough — including *why* push is not deploy — see
[Deploying a vertical](/guide/deploying).

## Install

```bash
npm install -g @substrat-run/cli    # or pnpm add -g @substrat-run/cli
substrat --help
```

The package has no runtime dependencies and ships web-standard + `node:*` only. It needs Node
≥ 20 and, for `push`, `npx wrangler` available in the vertical's directory (it builds with
`wrangler deploy --dry-run`).

## Commands

| Command | What it does |
|---|---|
| `substrat init --ci github` | Write `.github/workflows/substrat-deploy.yml` — the deploy + preview workflow, generated rather than re-derived. |
| `substrat model view [dir]` | Render the entity model as a self-contained HTML page and print its path — the design gate, as something you can look at. Offline. |
| `substrat login` | Sign in via the browser (per-human), or store a CI service token with `--token`. |
| `substrat whoami` | Print who you are and the workspaces you can build for. |
| `substrat push [dir]` | Build the vertical and push a version — **admitted** for a private vertical, **pending** for a listed one. No flags needed from inside the project. |
| `substrat promote <slug> --version <id>` | Point **`prod`** (the only channel) at a version. `--channel` defaults to `prod`. |
| `substrat versions <slug>` | List a vertical's versions + whether `prod` points at each. |
| `substrat preview create [dir] --tag <t>` | Run a version against a fork of prod (or `--empty` clean room) at its own URL — the non-prod environment primitive. |
| `substrat scope bind <scopeId> --version <id>` | Pin **one** scope to a version of the same vertical — the per-scope rollout primitive (canary, test env). |
| `substrat scope domain <scopeId> --domain <d>` | Bind a custom domain to **any** owned scope (a prod app, a preview, a test env). |
| `substrat publish <slug>` | Request a listing on the public marketplace (a staff operator reviews). |
| `substrat unpublish <slug>` | Remove a vertical from the public marketplace (staff). |
| `substrat scope pull <scopeId>` | Pull a scope's data to a local SQLite file — pseudonymized by default (recognised PII columns get plausible fake values, stable across the whole pull; free text stays `[masked]`), `--full` is break-glass. |

Options on any command: `--cp <url>` (control-plane API base), `--token <tok>` (a service
credential), `--tenant <id-or-slug>` (which workspace to act for).

### `init`

```bash
substrat init --ci github                        # → .github/workflows/substrat-deploy.yml
substrat init --ci github --release changesets   # the repo owns its version
substrat init --ci github ./apps/helpdesk --branch main --force
```

Writes the deploy workflow: a merge to the deploy branch releases, a PR gets its
[preview](#preview) with the URL commented back, and closing the PR reaps it. It is the same
file the dashboard's [one-click CI setup](/guide/deploying#deploy-from-ci) commits — one
generator, so the two paths cannot drift — and it is for the case the one-click path does not
cover: you own your CI, or you want the release-train shape.

`--release` picks what a merge means:

| Mode | A merge to the deploy branch |
|---|---|
| `trunk` *(default)* | **releases.** The push carries no `--version`, so the registry patch-bumps and `--promote prod` points prod at it in the same run. |
| `changesets` | **releases only when `package.json` version moved.** The repo owns the version, so the merge that lands a changeset just moves the test env; prod moves when the version PR lands. |

Two behaviours are opt-in through **repository variables**, so enabling them never means
regenerating the file:

| Variable | Effect |
|---|---|
| `SUBSTRAT_TEST_SCOPE_ID` | Every merge rebinds that scope to the just-built version — the [long-lived test environment](/guide/environments-and-previews#a-long-lived-test-environment). |
| `SUBSTRAT_PER_BUILD_PREVIEW` | Set to `1` and each PR push also mints a frozen [per-build URL](/guide/environments-and-previews#sticky-per-pr-and-per-build-urls) alongside the sticky one. |

The command is **offline** — it never authenticates and never calls the control plane — so it
works in a fresh repo before the vertical exists. The slug comes from `package.json`, the
branch from `.git/HEAD`; `--slug` / `--branch` override, `--out` relocates the file, and an
existing file is never replaced without `--force`. You still add the
[push token](/guide/deploying#deploy-from-ci) as the `SUBSTRAT_SERVICE_TOKEN` Actions secret
yourself; the command prints the steps.

### `model view`

```bash
substrat model view                       # this directory's model.json
substrat model view ./apps/helpdesk       # a directory, or the model.json itself
substrat model view . --out model.html    # place it deliberately
```

Reads [`model.json`](/concepts/model) and writes **one** HTML file: an ER diagram of the
entities and the `parents` edges permission flows along, then a card per entity listing its
fields with the primary key, the natural key and the `erasable` fields marked. Declared
lifecycles are rendered too, when the model has any. The path is printed on its own last
line — open it in a browser, or click it in an agent's chat pane.

It reads the **emitted artifact**, not the TypeScript. `model.json` is what
`pnpm lint:model --check` gates, so the view describes what actually shipped, and it stays
correct across a change of authoring notation. Run `lint:model` first if you have just
edited the model.

The page is self-contained — inline CSS and SVG, no script, no CDN — so it opens from a
file path with no server and no network. It writes to a temp file by default rather than
next to your source: a rendered view is something you look at, not something you commit.

The point of it is the **design gate**: approving a diagram of your own domain is a
categorically better checkpoint than approving prose about it, and it needs no login and no
push, so it works before any code exists.

### `login`

```bash
substrat login                     # browser loopback (PKCE) — a per-human session
substrat login --token <SERVICE_TOKEN>   # CI: store a service-actor credential
```

The browser flow starts a one-shot `127.0.0.1` server, opens the platform's CLI broker, signs
you in through [AuthHero](/concepts/identity), and exchanges a PKCE-bound `code` for a session
token — the token never transits a URL. On success the CLI also resolves your workspace(s) and
stores a default (prompting if you belong to several) — used by `promote` and `scope pull`;
`push` pins its workspace [per project](#push) instead. Everything lands in
`~/.substrat/config.json` (mode `0600`).

### `whoami`

```bash
substrat whoami
# signed in as you@acme.com
#   acme-co   (Acme Co)
#   side-org  (Side Org)
```

Prints the signed-in identity and every workspace you can build for — useful before a push if
you're unsure which workspace a project will act as.

### `push`

```bash
cd my-vertical && substrat push      # no flags — everything defaults from the project
```

Run from the vertical's directory (the one with `wrangler.jsonc` + `package.json`) and every
input defaults from the project; flags override each:

| Input | Default | Override |
|---|---|---|
| slug / name | `"substrat": { "slug", "name" }` in `package.json`, else derived from the package name | `--slug`, `--name` |
| version | the registry's latest for the slug, patch-bumped (seeded from `package.json` `version` on the very first push) | `--version` |
| workspace | `"substrat": { "tenant" }` in `package.json` — the **pin** | `--tenant`, `SUBSTRAT_TENANT` |
| UI served? | refuse if `app/index.html` exists and nothing in the manifest would serve it | `--allow-unserved-ui` |
| layer rules | refuse if [boundary-lint](/concepts/modules) finds a violation in your module code | `--skip-lint` |
| permission surface | derived from `"substrat": { "permissions" }` and shipped in the manifest | check it without pushing: [`--check`](#push-check-the-local-gate-without-pushing) |

**Push refuses a UI that nothing would serve.** A front end ships as native assets: the push
runs your declared `build`, hashes the output and uploads it to the runtime's asset store.
Undeclared, `app/` is never built and never uploaded, and the deployed vertical answers the
API on `/api/*` and 404s on `/` — a deploy that looks entirely successful. So when
`app/index.html` exists (Vite's own entry marker, and what the scaffold writes) but there is
no `assets` block in either vocabulary — `runtimeNeeds.assets` or a hand-authored
`wrangler.jsonc` — and no inlined-assets module under `src/`, the push stops before uploading
anything. The fix is the declaration it prints:

```json
"runtimeNeeds": {
  "build": "npm --prefix app install && npm --prefix app run build",
  "assets": {
    "directory": "app/dist",
    "notFoundHandling": "single-page-application",
    "runWorkerFirst": ["/api/*", "/internal/*"]
  }
}
```

`runWorkerFirst` must list **every** worker-owned prefix: with single-page-application
handling, a prefix missing from it answers `index.html`, so the app reports parse errors where
it should report denials. If the app is deliberately not part of this deploy — a mock, a
fixture, or built and deployed elsewhere — `--allow-unserved-ui` says so and the push proceeds.

**Push runs the layer rules.** Before anything is built, `push` runs
[`boundary-lint`](/concepts/modules) over your source and refuses on a violation — data access
is `ctx.sql`, capabilities come from `ctx`, another module's tables are private, time is
`ctx.now()`, and an engine error is caught only inside `ctx.atomic`. These are the rules the
platform states as mechanical, so they run where your code actually reaches production rather
than only in a CI job you may not have wired. It reads the same `boundary-lint.config.json`
the standalone linter does.

Two cases are a **note, not a refusal** — a push whose only fault is an unusual layout has to
stay pushable — and both say what went unchecked, so a partial pass never reads as a clean
one:

- **No module code found.** Nothing was checked; point the linter at your sources with
  `boundary-lint.config.json` (`{ "packages": [{ "src": "src" }] }`).
- **Engines declared but not resolvable** under `node_modules/@substrat-run`. Everything else
  was checked, but R5 (another module's tables are private) has no ownership map to check
  against, so it passed over your SQL without looking.

`--skip-lint` pushes ungated deliberately, and prints that it did.

#### `push --check` — the local gate, without pushing

```bash
substrat push --check           # layer rules + the declared permission surface
substrat push --check --json    # the same surface as data, for a CI diff
```

Runs everything a push does **locally** and stops there: the layer rules, then your declared
permission surface — resolve `"substrat": { "permissions" }`, import the entry, derive the
registry, print every key with the module that declares it and its description, every role,
every entity-grant shape, and the digest promotion compares. It needs **no login and makes no
network call**, so it belongs in a pull-request job:

```
permission surface — helpdesk: 19 key(s), 7 role(s), 1 entity-grant shape(s)

keys:
  conversation:read   [@acme/helpdesk]  See every conversation in this desk
  …
digest: 3a1e93e81599723a94ebaaa4d1b356b4  (digests.permission — the promotion checkpoint compares this)
```

Three things break a push and all three are otherwise silent until the moment you deploy: the
pointer is missing or names a file that has moved, the entry stops exporting `permissions`, or
the entry cannot be imported outside your vertical's runtime (a worker-only import, an
import-time side effect wanting a live host). Each one exits non-zero here with a message
naming the pointer — which is the whole point of having the command: gate the surface with the
CLI, not with a second implementation of the derivation and not by importing the CLI's build
output.

`--json` prints `{ registry, digest }` and nothing else on stdout (the gate's notes move to
stderr), so `substrat push --check --json > permissions.json` is a diffable artifact.

The push builds the bundle (`wrangler deploy --dry-run`, running your own `build.command`),
reads the declared surface (your own DO classes, D1 databases, compatibility date/flags, entry
module), computes the three digests, and POSTs to `{cp}/verticals/{slug}/deploy`. The slug is
**bare** — the control plane forms the registry id `<workspace>/<slug>` from the workspace you
push as (see [the prefix](/guide/deploying#the-workspace-prefix)). The version lands
**pending**; admission is a separate, human step.

**The first push of a project** has no pin yet, so the CLI asks — once — and offers to write
the answer into `package.json`, where it's reviewable and shared with every teammate and CI:

```
$ substrat push
this project has no pinned workspace. you belong to:
  1. acme-co   (Acme Co)
  2. side-org  (Side Org)
push as [1-2, enter = 1]: 1
pin 'acme-co' in package.json so this project always pushes there? [Y/n]: y
✓ pinned — package.json now carries "substrat": { "tenant": "acme-co" }
authenticating with browser session (workspace acme-co)
pushing acme-co/helpdesk@0.1.0 (Helpdesk) …
```

It never falls back to the workspace stored at login: the first push of a slug **claims** it
for a workspace, so a machine-wide default silently pointing at the wrong one would claim it
for the wrong owner. A non-interactive push (CI) with no pin refuses instead of guessing.

### `promote`

```bash
substrat promote helpdesk --version 01J… --ack-migrations
```

Points **`prod`** at an **admitted** version — a rebind of the live scope(s) to new code, same
data. `prod` is the *only* channel, so `--channel` defaults to it; a promote to anything else is
refused with a pointer at [`preview`](#preview). For a vertical you own privately this is
self-serve, prod included; a **listed** vertical's prod promotion is a staff decision (the
marketplace gate). A promote whose permission or migration digest differs from what is live is
refused until you acknowledge the diff (`--ack-permissions` / `--ack-migrations`).

For a non-production environment — test, canary, a PR preview — you do **not** promote a second
channel; you run the version against a scope with data. See [`preview`](#preview),
[`scope bind`](#scope-bind), and the [Environments & previews](/guide/environments-and-previews)
guide.

### `versions`

```bash
substrat versions helpdesk
# VERSION  ADMISSION  CHANNELS      ID
# 0.2.0    admitted   prod          01J…
# 0.1.0    admitted                 01J…
```

Lists a vertical's versions (newest first), each one's admission state, and whether `prod` points
at it. The same view is in the dashboard's **Deployments** tab.

### `preview`

```bash
substrat preview create . --tag pr-42          # push this tree, fork prod, serve the pair
substrat preview create . --tag test --ttl none --empty   # a pinned, source-less environment
substrat preview ls
substrat preview delete --tag pr-42            # reap it (idempotent)
```

Creates a **preview** — a scope with data bound to a version, at its own `--<tag>` hostname. This is
the non-production environment primitive: `create` pushes the working tree, forks the vertical's prod
scope (or provisions an `--empty` clean-room scope), binds the pushed version, and mints the URL.
Re-running the same `--tag` **rebinds** onto the same fork (migrations roll forward on one copy) and
**renews** its TTL; `--refresh` starts from a clean fork. `--ttl` defaults to `72h`; `--ttl none`
**pins** the preview until you delete it. Default preview pushes use a semver *prerelease* label, so
they never advance the release version your repo owns. Full workflow — sticky-per-PR + per-build URLs,
a long-lived test environment, the release candidate — in
[Environments & previews](/guide/environments-and-previews).

### `scope bind`

```bash
substrat scope bind <scopeId> --version <versionId> [--snapshot]
```

Pins **one** scope to a version of the same vertical — the per-scope rollout primitive. A prod
promote cascades every tenant scope; `scope bind` moves a single one, which is how you canary
*tenant A first* or advance a long-lived [test environment](/guide/environments-and-previews#a-long-lived-test-environment)
on each merge. `--snapshot` forks the scope's data before a migration-crossing bind (the rollback
point). A pending (unadmitted) version is refused unless the scope is a preview.

### `scope domain`

```bash
substrat scope domain <scopeId> --domain crm-test.ahero.se [--surface app]
```

Binds a **custom domain** to any scope you own — not just a prod app, but a preview or a long-lived
test environment. The hostname resolves to the *scope*, and the router serves whatever version that
scope is bound to, so a custom domain on a [pinned test preview](/guide/environments-and-previews#a-long-lived-test-environment)
gives it a stable address like `crm-test.ahero.se`. It walks the same DNS-validation + certificate
issuance as a prod domain (`verifying` → `active`); publish the CNAME/TXT it prints, then
[`substrat hostnames verify <hostname>`](#hostnames) re-polls. A scope carrying a bound domain is
protected from reaping while it resolves.

### `hostnames`

```bash
substrat hostnames helpdesk                    # list an install's hostname bindings
substrat hostnames bind helpdesk --surface app [--domain d] [--scope <id>]
substrat hostnames verify crm-test.ahero.se    # re-poll a custom domain's DNS/cert issuance
substrat hostnames unbind crm-test.ahero.se    # remove a binding
```

The install-addressed view of the hostname map. `hostnames bind` attaches a hostname to a named
install (by vertical slug, `--scope` to disambiguate); `verify` and `unbind` are hostname-addressed
and work for a hostname on **any** scope, including one attached with [`scope domain`](#scope-domain).
A platform hostname (`--surface` with no `--domain`) is live immediately on the wildcard cert; a
`--domain` custom hostname walks DNS validation. To attach a custom domain to a bare scope id (a
preview, a test env), reach for [`scope domain`](#scope-domain) instead.

### `publish` / `unpublish`

```bash
substrat publish helpdesk      # request a public-marketplace listing — staff reviews
substrat unpublish helpdesk    # remove the listing (staff)
```

`publish` is a **request**: any owner may ask, and a Substrat operator reviews before the
vertical is listed — once listed, every tenant can install it from the catalog. Flipping the
listing itself is staff-only, so `unpublish` works for staff and is refused for builders.

### `scope pull`

```bash
substrat scope pull <scopeId> [--full] [--out <dir>] [--tenant <id-or-slug>]
```

Brings a scope's data to your local inner loop ([snapshots](/concepts/snapshots)): downloads
the scope's dump from the control plane and writes a **real SQLite file** —
`.substrat/<tenant>__<scope>.sqlite`, the exact file shape
[`adapter-sqlite`](/reference/adapter-sqlite) stores scopes in, so a local harness runs the
identical vertical against it. On node < 22.13 (no `node:sqlite`) the dump lands as JSON with
a notice instead.

The pull crosses the platform's trust boundary on purpose, so the server side is the gate:

- **Pseudonymized by default** — a column or payload field whose *name* the PII heuristic
  recognises (`email`, `phone`, `postal`, `street`, `city`, `name`, `external_id`) gets a
  deterministic fake value of the same kind, stable across the whole pull so joins and
  timelines still line up. Free text (`note`, `description`, `body`, `comment`, `message`,
  `subject`) and national identifiers (`ssn`, `personnummer`) get the literal `[masked]`
  instead: there is nothing honest to generate for either. A column the heuristic does not
  recognise is not touched, so the file stays personal data — ids and numbers pass through
  too, which is what keeps the copy debuggable. `--full` is the explicit break-glass for
  full fidelity, and the CLI prints a treat-as-production warning.
- **Audited** — every pull writes an access-log entry against your actor.
- **Jurisdiction-checked** — a scope pinned tighter than `global` is refused: pulling would
  move its data outside the pin.

One-way by design: you pull and diverge; nothing syncs back.

## Auth resolution

At request time the CLI resolves, in order:

- **Credential** — explicit `--token` / `SUBSTRAT_SERVICE_TOKEN` (a service actor, for CI) → a
  stored browser session (sent as `Authorization: Bearer`) → a stored service token.
- **Control-plane URL** — `--cp` → `SUBSTRAT_CP_URL` → the stored config (default
  `https://console.substrat.net/api`).
- **Workspace** (browser session only) — sent as `x-substrat-tenant`. For **push** it is the
  *project's* choice: `--tenant` → `SUBSTRAT_TENANT` → `"substrat": { "tenant" }` in
  `package.json` — never the stored login default, because the first push of a slug **claims**
  `<workspace>/<slug>` for whatever workspace resolved. With no pin, an interactive push lists
  your workspaces and offers to write the pin; a non-TTY push refuses. Other commands
  (`promote`, `scope pull`) fall back to the workspace stored at login.

You are always authenticated **as yourself** — a push is attributable to the human or service
that ran it, never a hand-picked actor.

## Config file

`~/.substrat/config.json`, written `0600`:

```json
{
  "controlPlaneUrl": "https://console.substrat.net/api",
  "bearerToken": "…",        // a browser session (per-human)
  "serviceToken": "…",       // a machine credential (CI)
  "defaultTenant": "acme-co" // the workspace promote/scope act for (push pins one per project)
}
```

It is a home-dir file, never committed to a repo.
