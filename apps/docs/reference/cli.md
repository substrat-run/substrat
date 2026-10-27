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
≥ 20, and Node ≥ 22 for `push`, since wrangler 4 does. It runs on macOS, Linux and Windows.
For `push`, the vertical must have **wrangler installed as a devDependency** (`npm install --save-dev wrangler`; a project from
`npm create substrat` has it). The push builds with that pinned wrangler
(`wrangler deploy --dry-run`), run directly by Node rather than through `npx`. It never
downloads a wrangler for you, so a project without one is refused with that instruction.

On Windows, long paths should be on. A project's `node_modules` holds files deeper than Windows'
old 260-character limit, and many programs (PowerShell, Python, installers) stop at that limit
until the setting is on. `npm create substrat` offers to turn it on, and `substrat doctor --fix`
does it any time: Windows asks you to allow the change once, as it does for any machine-wide
setting. Node, npm, pnpm and this CLI work either way. `cmd.exe` and Explorer keep the old limit
whatever the setting says.

## Commands

| Command | What it does |
|---|---|
| `substrat init --ci github` | Write `.github/workflows/substrat-deploy.yml` — the deploy + preview workflow, generated rather than re-derived. |
| `substrat model view [dir]` | Render the entity model as a self-contained HTML page and print its path — the design gate, as something you can look at. Offline. |
| `substrat changeset [dir]` | Write a `.changeset` file whose bump is **computed** from what your model, API and permissions changed, instead of chosen. `--check` refuses a changeset that declares less. Offline. |
| `substrat concept sync [dir]` | Rewrite the generated sections of `spec/concept.md` — roles and permissions, the entity diagram, one state diagram per lifecycle — from `model.json` and `PERMISSIONS.md`. Offline, idempotent; `--check` writes nothing and exits 1 when the file is stale. |
| `substrat plan [dir]` | The **concept delta** a design gate shows: entities before and after, lifecycle and permission changes, the spec-version impact, and the decisions-log entry approving it writes. `--approve <digest>` records a person's approval. Offline. |
| `substrat login` | Sign in via the browser (per-human), or store a CI service token with `--token`. |
| `substrat doctor [dir]` | Check that this machine and project can push: Node, the project's wrangler and, on Windows, long paths. `--fix` turns long paths on. |
| `substrat whoami` | Print who you are and the workspaces you can build for. |
| `substrat push [dir]` | Build the vertical and push a version — **admitted** for a private vertical, **pending** for a listed one. No flags needed from inside the project. |
| `substrat promote <slug> --version <id>` | Point **`prod`** (the only channel) at a version. `--channel` defaults to `prod`. |
| `substrat versions <slug>` | List a vertical's versions + whether `prod` points at each. |
| `substrat preview create [dir] --tag <t>` | Run a version against a fork of prod (or `--empty` clean room) at its own URL — the non-prod environment primitive. |
| `substrat scope bind <scopeId> --version <id>` | Pin **one** scope to a version of the same vertical — the per-scope rollout primitive (canary, test env). |
| `substrat scope rebind <scopeId> --to <vertical>` | Move **one** scope onto another vertical's serving version, data carried. |
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

### `concept sync`

```bash
substrat concept sync                     # this directory's spec/concept.md
substrat concept sync ./apps/helpdesk     # a directory, or its model.json
substrat concept sync --check             # write nothing; exit 1 if it is stale
```

A vertical's `spec/concept.md` is the readable description of it for the people who own it,
and three of its sections are generated, between `<!-- substrat:roles -->`,
`<!-- substrat:entities -->` and `<!-- substrat:processes -->` markers (each closed by
`<!-- /substrat:… -->`): the roles and permissions table, a Mermaid `erDiagram` of the
entities, and a `stateDiagram-v2` per declared lifecycle. Everything outside the markers is
yours and is never touched. The same input gives byte-identical output, so running it twice
changes nothing.

`pnpm lint:concept` is the gate: it fails when a generated section is stale, and, given
`--base <ref>`, when `model.json` or `PERMISSIONS.md` changed without a new entry in the
document's *Decisions log*. Write that entry yourself; it is the part a tool cannot — or let
[`substrat plan --approve`](#plan) write it when the change was approved at the design gate.

### `plan`

```bash
substrat plan                             # the concept delta against the merge-base
substrat plan --why "Owners asked to tag items"   # the reason, in the proposed entry
substrat plan --json                      # the same delta, for an agent
substrat plan --approve 04efc4b846a3 --by "Ada" --why "Owners asked to tag items"
```

The **design gate** of a change, as something an owner can read. Declare the change in
`spec/model.ts` (and its roles), re-emit `model.json` and `PERMISSIONS.md`, then run it: it
compares those artifacts and `openapi.json` in the working tree with the merge-base of your
base branch (`--base <ref>`; by default the changesets `baseBranch`, else `main`, on `origin`
when fetched) and prints:

| Section | What it shows |
|---|---|
| Entities | Each entity added, changed or removed, with what changed in it, and the model as a Mermaid `erDiagram` before and after — the same diagram `concept sync` draws |
| Lifecycles | States added or removed, and every transition added, removed or retargeted, with the operation that triggers it, the key that operation declares it checks (from the Operations section of `PERMISSIONS.md`), and the roles and per-record grant shapes holding that key. An operation that checks in its handler and declares nothing is marked "checked in code, not declared", and one a `PERMISSIONS.md` emitted before that section does not list is named without a key: neither is guessed |
| Permissions | The permission-diff table — key, description, which roles held it before and hold it now — and each change listed for the human checkpoint |
| Spec-version impact | `none`, `patch`, `minor` or `major`, from the [`changeset`](#changeset) classifier, with the changes that set it — so the bump approved is the bump the release is held to |
| Proposed decisions-log entry | The entry approving it writes, and the command that does |

Nothing is written until a person approves. `--approve <digest>` takes the digest the delta was
shown with, `--by` the person who approved it and `--why` their reason; it appends the entry
to the *Decisions log* of `spec/concept.md` and re-syncs the generated sections. A digest that
no longer matches — the model was edited after it was shown — is refused, so an approval
always records the delta that was actually read. `--by` and `--why` must be one line of plain
text, with no `<!--` or `-->`; anything else is refused and the document is left as it was.
The same two trees give the same output and digest on every run. Offline; no login.

What the CLI cannot do is tell a person from an agent. The digest is printed by `--json` as
well as in the rendered delta, so anything that can run `substrat plan` can run
`substrat plan --approve`. "A person approves" is held by the instructions an agent works
under (the playbook's design gate and the plugin's `substrat-plan` skill): the agent passes
`--approve` only after the person has said yes in the conversation, with their name and
reason. The digest guarantees *what* was approved, not *who* approved it.

### `model view`

```bash
substrat model view                       # this directory's model.json
substrat model view ./apps/helpdesk       # a directory, or the model.json itself
substrat model view . --out model.html    # place it deliberately
```

Reads [`model.json`](/concepts/model) and writes **one** HTML file: an ER diagram of the
entities and the `parents` edges permission flows along, then a card per entity listing its
fields with the primary key, the natural key and the `erasable` and `outsideText` fields marked. Declared
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

### `changeset`

```bash
substrat changeset                        # write .changeset/<name>.md with the computed bump
substrat changeset --summary "Add tags"   # your own first line above the computed list
substrat changeset --check                # refuse a changeset that declares less (exit 1)
substrat changeset --json                 # the classification, for a script or a status line
```

For a vertical released with [changesets](https://github.com/changesets/changesets): the bump
is read off the diff of the three checked-in artifacts — `model.json`, `openapi.json` and
`PERMISSIONS.md` — against the merge-base with your base branch (the changesets `baseBranch`,
on `origin` when it is fetched; `--base <ref>` overrides). A breaking change marked `patch`
looks exactly like a green release, so the bump is not left to judgement:

| Change | Bump |
|---|---|
| Something removed or narrowed — an operation, field, entity, state, transition, response or enum value; an input now required, tighter or `readOnly`; an output that may now be omitted, looser or `writeOnly`; a type, key or `operationId` changed | **major** |
| Something added — an operation, field, entity, state or key; an input now optional or looser; a `default` added, changed or dropped | **minor** |
| Only `description`, `title`, `examples`, `$comment`, `deprecated`, `x-*`, an operation's `summary` or `tags`, or `info` | **patch** |
| Any permission change — including an operation now checking a different key, or narrowing its check differently | at least **minor**, and listed for review |

A change the classifier cannot rank — a schema keyword whose direction it cannot tell, or a
key it does not know — counts as **major**, so an unknown shape can never lower the bump.
When that is wrong for your change, keep the lower bump and say why in the changeset, where a
reviewer reads it:

```md
<!-- bump-override: @acme/helpdesk minor — the removed field was added in this same release -->
```

The override names the package and the level the changeset declares for it, and must give a
reason; `--check` refuses one that does not.

### `login`

```bash
substrat login                     # browser loopback (PKCE) — a per-human session
substrat login --workspace acme-co # …and set the default workspace without being asked
substrat login --token <SERVICE_TOKEN>   # CI: store a service-actor credential
```

The browser flow starts a one-shot `127.0.0.1` server, opens the platform's CLI broker, signs
you in through [AuthHero](/concepts/identity), and exchanges a PKCE-bound `code` for a session
token — the token never transits a URL. On success the CLI also resolves your workspace(s) and
stores a default — used by `promote` and `scope pull`; `push` pins its workspace
[per project](#push) instead. With several workspaces it asks which, unless `--workspace <slug>`
(a slug or id) answers first. Everything lands in `~/.substrat/config.json` (mode `0600`).

**Without a terminal** (a coding agent, piped input, CI, Git Bash in its own mintty window) login asks nothing.
The control-plane URL is `--cp`, else the one stored from before, else
`https://console.substrat.net/api`. With several workspaces and no `--workspace`, the session is
saved without a new default; the CLI says how to set one, and an earlier default stays if it is
one of yours. A sign-in completed in the browser is always saved. An unknown `--workspace` is
saved too, then reported with your workspaces listed and a non-zero exit. If the browser does not
open, visit the URL the CLI prints.

### `doctor`

```bash
substrat doctor          # check, change nothing; exits 1 when a check fails
substrat doctor --fix    # and turn Windows long paths on
```

It checks the Node version (`push` needs 22 or later, because wrangler 4 does), that the project
has wrangler installed, and on Windows whether long paths are on. `--fix` changes only that last
setting. It is machine-wide and needs an administrator, so Windows shows its own permission
prompt once, and `doctor` reads the setting back before it says it worked. Programs that were
already running keep the old limit until you restart them.

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
| schedules run? | refuse if a module declares `schedules` and they would still go unrun: your own `defineScopeSweeperDO` unbound, the platform's `SWEEPER`/`SweeperDO` names taken, or a `@substrat-run/vertical-host` too old for the platform's sweeper | `--allow-unswept-schedules` |
| permission surface | derived from `"substrat": { "permissions" }` and shipped in the manifest | check it without pushing: [`--check`](#push-check-the-local-gate-without-pushing) |

**Push refuses a UI that nothing would serve.** A front end ships as native assets: the push
runs your declared `build`, hashes the output and uploads it to the runtime's asset store.
Undeclared, `app/` is never built and never uploaded, and the deployed vertical answers the
API on `/api/*` and 404s on `/` — a deploy that looks entirely successful. So when
`app/index.html` exists (Vite's own entry marker, and what the scaffold writes) but there is
no `assets` block in either vocabulary — `runtimeNeeds.assets` or a hand-authored
`wrangler.jsonc` — and no inlined-assets module under `src/`, the push stops before uploading
anything. The inlined-assets pattern counts as served whether or not it has been built yet: the
check accepts either an `assets.generated.*` module under `src/`, or source that **imports** one.
The module is usually build output and gitignored, and this check runs before your declared
build, so on a fresh checkout the import is the only evidence there is. The fix for a genuinely
undeclared UI is the declaration it prints:

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

**The platform runs your schedules.** On a hosted deploy, a vertical's declared `schedules`
need a timer inside its own deployment: a
[`defineScopeSweeperDO`](/reference/adapter-cloudflare) class, bound as a Durable Object.
You no longer write one. When any module declares a schedule, including an engine you compose
whose schedules your own source never names, and your worker entry exports no sweeper, the
platform adds one at upload: the class `SweeperDO`, bound as `SWEEPER`.
`mountPlatformSurface` gives it your worker's scope host, and adds each scope it provisions or
reconciles to the sweeper's list (the roster), and removes each scope it deletes. Upgrade
`@substrat-run/vertical-host` if it predates this; the push says so. Before it uploads, the
push also checks that the control plane it targets says it adds the sweeper. A control plane
that doesn't say so is too old to add one, and the push refuses. The control plane decides
once, when a version is pushed, and records it with the version. Promoting or rolling back a
version reuses that record, so it can never be refused over the sweeper.

A worker that exports its own `defineScopeSweeperDO` keeps it. The push reads the export from
your entry's source, following relative re-exports, and sends its name with the version, and
the platform adds nothing. Keep the class bound as a store
(`{ "binding": "SWEEPER", "class": "SweeperDO" }`) and call `noteScope` from `onProvision`, as
before.

To move from your own sweeper to the platform's, delete the export, its store and the two
hooks, once the control plane you push to supplies one (the push checks). The platform's sweeper has the same class name, so a deployed vertical keeps its
sweeper's state, its scope list and its scheduled alarm. A vertical that wired its own under
another class name should keep it: switching would be a class rename, which no upload performs.

The push refuses only where the schedules would still never run: an exported sweeper no store
binds, a `SWEEPER` binding or `SweeperDO` class used for something else, or a vertical-host
too old to hand the platform's sweeper its host. `push --check` makes the same check. If a
sweeper you wired in some other shape already runs them, `--allow-unswept-schedules` says so
and the push proceeds.

#### `push --check` (the local gate, without pushing)

```bash
substrat push --check           # layer rules + the declared permission surface
substrat push --check --json    # the same surface as data, for a CI diff
```

Runs everything a push does **locally** and stops there: the layer rules, then your declared
permission surface — resolve `"substrat": { "permissions" }`, import the entry, derive the
registry, print every key with the module that declares it and its description, every role,
every entity-grant shape, and the digest promotion compares. It needs **no login and makes no
registry request**, so it belongs in a pull-request job. A configured Wrangler build command
still runs locally and may make its own network calls:

It also bundles the Worker entry under workerd export conditions and refuses static, dynamic,
or CommonJS imports of Node builtins that its compatibility flags do not provide. This includes
imports in dependencies and imports behind a `typeof` guard. The error traces the path from the
entry to the builtin. Remove the Node dependency, use a Worker-compatible API, or declare
`nodejs_compat` when the Worker actually requires it. `nodejs_als` permits only
`node:async_hooks`. A single tested Worker crypto fallback in `tweetnacl` has an exact-match
allowance; there is no general guarded-import exception. `push` and `preview` apply the same
check before upload.

```text
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

`--json` prints `{ registry, digest }` and nothing else on stdout (the gate's notes and any
configured build command's output move to stderr), so
`substrat push --check --json > permissions.json` is a diffable artifact.

`--check` (and `push`, and `preview`) also reads the worker entry and the modules it imports for
`https://host` literals and `new URL('https://…')`, and warns about each host
`"substrat": { "outbound" }` does not cover, with the file, the line and the line to add — the
egress worker refuses such a call at run time. `--strict` makes it an error. A declared host no
literal names is only a `note:`. It is best effort: a host built at runtime or read from config is
not found. See [declared outbound hosts](/guide/deploying#declared-outbound-hosts).

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
substrat promote helpdesk --version 01J… --ack-migrations --review 01J…:5f3c…
```

Points **`prod`** at an **admitted** version — a rebind of the live scope(s) to new code, same
data. `prod` is the *only* channel, so `--channel` defaults to it; a promote to anything else is
refused with a pointer at [`preview`](#preview). For a vertical you own privately this is
self-serve, prod included; a **listed** vertical's prod promotion is a staff decision (the
marketplace gate). A promote whose permission or migration digest differs from what is live is
refused until you acknowledge the diff (`--ack-permissions` / `--ack-migrations`). The refusal
prints the permission diff and each migration the version adds on top of the live one, with its
SQL, so the flag answers something you have read. A version pushed before migrations were carried
in the manifest says its SQL is not available, and so does one whose push left its SQL out because it
is over what a manifest carries: the platform has no migrations to compare for either, so a promote
to or over it always asks for `--ack-migrations`.

The refusal also prints a `--review <token>`: the review those diffs are, bound to the version prod
pointed at when they were read. Re-run with it. If prod moved since, the promote is refused as
stale and the current diffs are printed with a new token. An acknowledgement of a changed
permission or migration digest without a token is refused; CLI 0.45.0 or later supplies the token. See
[An acknowledgement answers one review](/guide/deploying#acknowledgement-answers-one-review).

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
Re-running the same `--tag` **rebinds** onto the same fork and **renews** its TTL. On a host with a
per-version resolver, routing between distinct version deployments copies the data before binding;
unchanged routing and co-located incoming versions need no copy. Migrations roll forward on the
same data, but writes during a copy may be lost (see
[what a push copies](/guide/environments-and-previews#previews-the-non-prod-primitive)).
A fork or a copy too large for one request runs in the background: `create` prints its progress
and waits until the preview is ready, for up to six hours. A poll that fails as a gateway or the
network fails, or with a `500` that names no reason, is polled again, up to ten in a row; past
that, `create` stops waiting and says the copy may still be running. If the CLI stops waiting (its CI job is
cancelled, say), the preview is left as it was: a new one is not ready, and one being updated keeps
serving the previous push. Running `create` again pushes a new version, whose copy starts over and
replaces the one left running. A copy that fails, or that a newer push, a refresh or a delete
stops, ends `create` with the reason (a `409`), and `create` never starts the copy over by itself:
only running it again does.
If two creates of the same version reach the same preview before either copy job starts, the
destination keeps the first staged copy. The competing request receives `503` while that first
page is being staged; the CLI retries this transient response. Once the winner's job is visible,
the competing request receives the usual `202` progress answer and polls that job. If the short
`503` retry window ends first, rerun `create` after the active copy finishes. A failed, cancelled
or superseded job discards its own staged copy. A stage whose job record is lost can be reclaimed
only after the six-hour copy limit plus its lease safety margin.
`--refresh` starts from a clean fork, and stops a copy still running, though not a newer push's:
a refresh of an older version is refused as superseded, as any create of one is. `--ttl` defaults to `72h`; `--ttl none`
**pins** the preview until you delete it. Default preview pushes use a semver *prerelease* label, so
they never advance the release version your repo owns. Because `create` is a push, it takes push's
own overrides: `--skip-lint`, `--allow-unserved-ui` and `--allow-unswept-schedules` mean the same thing here as they do there.
Full workflow — sticky-per-PR + per-build URLs,
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
point). A scope that runs on its bound version's own deployment, such as a preview or a test
environment forked from one, has its data copied before binding when routing moves between distinct
version deployments and the host has a per-version resolver. Unchanged routing and co-located
incoming versions need no copy. Writes during a copy may be lost. A pending (unadmitted) version
is refused unless the scope is a preview.

### `scope rebind`

```bash
substrat scope rebind <scopeId> --to <vertical> --ack-migrations --review 01J…:5f3c…
```

Moves **one** scope onto a different vertical's serving version: the data is exported from the
script the scope runs on, restored onto the target's serving script, and then the route and the
version pointer move together. The old copy is deleted once the move is confirmed, so take a
snapshot first if you want a way back. Staff may rebind any scope; a workspace's own credential may rebind
one of its own scopes, between verticals it can see (its own, or listed). A CI push token cannot.

The two verticals' migration histories are independent. When their migration digests differ, the
rebind is refused and prints what it would apply: each migration the target's serving version
carries over the version the scope is bound to, with its SQL and what it declares it moves or
discards (the SQL only when you own both verticals; otherwise it says the digests differ). It also
prints a `--review <token>`. Re-run with `--ack-migrations` and that token. If
either vertical has been promoted since, the rebind is refused as stale and prints the current
migrations with a new token. `--ack-migrations` without a token is refused; see
[A rebind answers one review](/guide/deploying#a-rebind-answers-one-review).

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
the scope's dump from the control plane and, for a scope without
[scope stores](/concepts/scope-stores), writes a **real SQLite file** —
`.substrat/<tenant>__<scope>.sqlite`, the exact file shape
[`adapter-sqlite`](/reference/adapter-sqlite) stores scopes in, so a local harness runs the
identical vertical against it. On node < 22.13 (no `node:sqlite`) the dump lands as JSON with
a notice instead.

A full pull of a scope **with** scope stores writes no `.sqlite`: a SQLite file holds only the
scope's tables, so the pull is written as `.substrat/<tenant>__<scope>.dump.json`, and a
`.sqlite` an earlier pull left for the same scope is removed. `substrat scope restore` restores
that file, stores included. A local harness loads it with `adapter-sqlite`'s `importScope`, on a
host whose `scopeStores` binds a runner of the same driver for each store the dump names; a store
the host does not bind is refused before anything is written.

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
