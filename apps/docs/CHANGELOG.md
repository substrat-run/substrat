# @substrat-run/docs

## 0.1.13

### Patch Changes

- f5846ce: The landing page leads with what you can build, not with the five things Substrat fixes

  The old page opened by naming multi-tenancy, identity, permissions, audit and GDPR as
  the parts that were missing — which sells a patch for a gap rather than a way to build
  the whole application, and left the strongest evidence off the page entirely. Eight demo
  verticals exist across eight unrelated domains, and three of them run their core domain
  on the kernel alone; that set was represented by three cards near the bottom.

  So the page now opens on the claim and spends the rest of itself earning it: the eight
  demos first, with the kernel-only ones marked, then a new section inventorying the
  twenty-three things that arrive with a project — the API and its client, identity and the
  audit record, snapshots and per-PR production forks, hosting and domains — then the
  single-operation code sample, the three layers, and only then the runtime guarantees,
  which are proof rather than premise. The engine section is reframed to match: seven
  engines you don't have to write, with the star topology drawn rather than asserted.

  Two removals. The fifteen-row package table is gone — it was a reference artifact on a
  marketing page, and its seven consecutive `seed` badges said something the engines page
  takes a paragraph to say properly. The "honest half" is reduced to a link row, because
  `/guide/what-substrat-lacks` already does that job with the shipped / built-unproven /
  bet labelling the summary flattened away.

  Layer colour now runs the whole page — amber for verticals, cyan for engines, indigo for
  the kernel — instead of appearing as three hairlines and three dots.

## 0.1.12

### Patch Changes

- 04ebaff: The docs CSP names the desk a page mounts the support widget on, so the widget on
  `/guide/support` loads again. The site-wide embed is a `<script>` in the built HTML,
  which the policy was derived from; the per-page `<Ticket0Widget>` appends its script
  from JavaScript after mount, so nothing about `ticket0.substrat.net` reached the build
  and the browser blocked it on production only. The desks are now read out of the
  markdown, and the origin guard covers them too.

## 0.1.11

### Patch Changes

- e1920ec: The docs site ships a Content Security Policy, and a build that refuses to outgrow it

  `vitepress build` now writes `_headers` into the built site, so Cloudflare Pages serves
  substrat.net with a CSP plus `X-Frame-Options`, `Permissions-Policy` and HSTS. Nothing was
  framing or injecting into a static docs site with no cookies and no user input, so this is
  defence in depth rather than a closed hole — `frame-ancestors` is the one directive that
  covers something previously unguarded, and the policy is what will bound the ticket0
  support widget on the day it goes live.

  The script hashes are read back out of the HTML each build just wrote, because VitePress
  inlines three scripts per page and one of them embeds a content hash of every page — a
  checked-in hash list would be stale the first time anyone edited a page, and stale in the
  worst way, since the page still renders but unstyled and stuck in light mode.

  The build also refuses to emit a policy the site already violates: add a font from Google
  or an analytics snippet and the build fails naming the origin and the directive, instead of
  going green and dropping that resource in the browser, on production only.

## 0.1.10

### Patch Changes

- c2d5c2a: The ticket0 support widget on one docs page. `widget.js` now keeps one widget per page and exposes `window.ticket0.unmount()` for a host with a client-side router; the docs site mounts it at `/guide/support` through a `Ticket0Widget` theme component that tears it down on navigation.

## 0.1.9

### Patch Changes

- 2003d6e: The enforcement story gets its own page, and the AI-agents page gets its subject back

  `guide/ai-agents.md` had grown two arguments inside one page: what makes the platform
  _legible_ to a coding agent, and what happens when that agent gets it wrong. The second one
  was the more load-bearing of the two and the harder to find — a reader asking "what stops a
  mistake" had to assemble the answer from five non-adjacent sections, plus the layer rules in
  `reference/boundary-lint.md` and the honest caveats in `guide/what-substrat-lacks.md`.

  **New: `guide/ai-guardrails.md` — Where AI mistakes stop.** The six guards a change passes
  through, ordered as the sequence they actually fire in (compile → bound → derive → judge →
  review → rehearse) rather than as a list of virtues, so the claim the page makes — that a
  mistake surviving one guard meets the next — is carried by the structure and not just
  asserted. It expands the five that need more than a paragraph: the R1–R6 layer rules and the
  load-bearing exit code `2`, the three marks a generated file carries, the
  code-from-model/tests-from-concept oracle, the two human checkpoints, and the preview fork.
  It closes on what none of it claims, including the Durable-Object hole in the egress
  allowlist.

  **`guide/ai-agents.md` keeps the other half** — bring-your-own-model, the markdown docs
  slice and `llms.txt`, the session-start hook, self-describing manifests, the local loop —
  and hands off. Retained prose is unchanged; nothing is stated twice across the two pages.

  **Two new figures, on the existing twin machinery.** `<BlastRadius />` draws the line with
  what sits either side of it, and `<GuardPath />` draws the six stages. Both keep every string
  in a sibling `.content.mts` and register an `alt()`, so they reach `llms.txt` as markdown
  rather than as a pointer. `BlastRadius` imports `theLine` from `LayerStack.content.mts`
  instead of restating the thesis — the cosmetic/catastrophic split is already the spine of the
  three-layer diagram, and a second copy is exactly the drift the rest of the repo lints for.

## 0.1.8

### Patch Changes

- ffe59cc: The five pages that most needed a picture get one, and the engine state machines get drawn from the code.

  Five diagrams, all on the twin machinery from the previous change, so every one of them reaches
  `llms.txt` as markdown rather than as a pointer.

  **The engine state machines are now emitted, not redrawn.** Five engine pages each drew their
  machine in ASCII by hand, and two of the five had already drifted from the engine: booking's
  picture showed neither `cancel` nor `no-show`, and protocol's omitted `voided` entirely. One
  `<StateMachine engine="…" />` now derives the layout — a spine from the initial state, with
  branches falling off it — from the machine itself. For `workorder`, `booking` and `invoicing`
  that machine is read straight out of the emitted `model.json` that `lint:model --check` already
  gates, so those three cannot drift again. `absence`, `protocol` and `invites` declare no
  lifecycle yet, so theirs is transcribed in the same shape and **the page says so under the
  figure**; when those engines adopt `defineLifecycles`, the entry swaps to `fromModel` and the
  note goes away.

  Four more, each replacing prose or a chart that was fighting its own layout:

  - **`/concepts/permissions`** — the six-node mermaid `flowchart TD` becomes `<PermissionPipeline />`.
    Every node was a three-line paragraph, and dagre sizes boxes from label length, so a straight
    pipeline rendered as ragged blocks. The `lint:permissions` fork is now drawn as what it is — a
    review branch ending in a person, not a peer of `push`.
  - **`/concepts/tenancy`** — `<TenancyTree />`. Tenancy is a tree and "one scope = one database" is
    a containment claim; both are shapes prose had to walk you through.
  - **`/concepts/reads`** — `<ReadPaths />` draws the three paths as increasing distance from the
    scope boundary, because that distance _is_ the staleness. Three peer boxes would have restated
    the table above it.
  - **`/guide/environments-and-previews`** — `<InstanceResolution />`. The page's whole argument is
    that an instance is `(scope × version)` and exactly one link is mutable, so the binding is the
    only thing drawn in the accent.

  `toTwin` and the `lint:llms --check` component assertion now match components with props, since
  one component serving five pages is one component and five props.

## 0.1.7

### Patch Changes

- 8a2da00: The diagrams reach llms.txt, and three of them get redrawn.

  A theme component was flattened to `*(Diagram: LayerStack — rendered at the HTML page for
this document.)*` on the grounds that a diagram cannot be flattened honestly. True of a
  drawing, and false of ours: `LayerStack` and `RuntimeTopology` render ordinary prose out of
  ordinary arrays, so what the pointer dropped was content that already existed — and dropped
  it from the one surface agents read.

  Each component's content now lives in a sibling `*.content.mts` that exports both the data
  the component renders and an `alt()` that renders the markdown twin **from that same data**.
  Add an engine to `engines.chips` and it appears in `llms.txt`; there is no second list to
  update and no way for the picture and its text to disagree. `toTwin` calls `altFor`, and the
  pointer survives only as the fallback for a component with genuinely nothing to flatten.

  `lint:llms --check` gains a fourth assertion: a page rendering a component with no registered
  `alt()` fails, naming the file to create. Without it the failure is invisible — the page looks
  right and everything the diagram says is missing from the twin.

  Three drawings change, all in one vocabulary of hand-authored SVG on the existing `--layer-*`
  tokens, so they read the same and flip with the theme:

  - **`/guide/architecture` §Topology** — the mermaid `flowchart TB` becomes `<ScopeTopology />`.
    Mermaid sized boxes from label length and routed edges with dagre, so the fan-out the picture
    exists to show came out looking accidental.
  - **`/guide/architecture` §The hosted runtime** — an SVG now leads the six numbered steps,
    which stay. It draws the one thing a numbered list cannot: the request coming _back_. Step 6
    said the response travels up; now you can see it, and see which layer's code executes in each
    box along the way.
  - **`/connectors/` §The seam** — the ASCII block becomes `<ConnectorLoop />`, which draws the
    round trip it could only describe: the scope delegating a delivery out to the worker because
    it has no `fetch` of its own, and the result re-entering through `getConnectorScope`.

  Both figures are drawn at 700 units, not the 920 they were designed at — the docs content
  column is roughly 665px, and anything wider is either clipped or scaled until the labels are
  unreadable.

## 0.1.6

### Patch Changes

- dc2c726: A dev server that cannot work refuses to boot, and says what it needs.

  `.dev.vars` is this repo's per-project local-env convention — gitignored, written by
  `scripts/secrets.mjs dev`, and named as such in `secrets/README.md`. **`wrangler dev` loads
  it and `tsx src/server.ts` did not.** The same file, in the same directory, read by one
  entry point and silently ignored by the other, with no signal either way: `cf:dev` picked up
  your values and `pnpm dev` started without them.

  Callout's `server` script now loads it (`node --env-file-if-exists=.dev.vars`), and a new
  `preserver` hook checks what that leaves unresolved before the process starts.

  **Why a boot failure rather than a prompt.** There is no terminal to prompt at. Claude
  Desktop starts these servers from `.claude/launch.json` (`pnpm run server`) with no TTY, so
  a `readline` question hangs forever and a warning scrolls past. What an agent _can_ read is
  a server that died and said why — which is already how this surface signals: `autoPort:
false` is set so a stale port "does not get quietly reassigned, it fails the boot. For an
  agent, mid-session" (`tools/launch-emit.mts`). Same mechanism, one more failure mode. The
  report names each missing key with its declared label, description and placeholder, and the
  exact file to write. Values are never read into the tool or printed — only key names.

  **Two declarations, because they answer different questions.** `envSpec[].required` means
  required to **deploy**, and is rarely true: a hosted install receives config through
  per-scope delivery, so the manifest can honestly call most keys optional. The new
  `devServers[].requires` means required to **run this process locally** — the gap the first
  cannot express. Locally there is no delivery channel, so `OIDC_ISSUER` absent means broken;
  and the harness secrets that actually bite (`PLATFORM_SECRET`, `ROUTER_SECRET`) are
  deliberately undeclared in `envSpec` at all. A key named in both gets the spec's prose in
  the failure message; a key named only in `requires` is reported bare.

  `requires` is deliberately **not** emitted into `launch.json`. A launch file starts a
  server; what a server needs in order to start is the `preserver` hook's business, and
  duplicating it into a client-specific adapter would make it substance an adapter may not
  hold (agent-surface §3).

  Callout's `dev` script now calls `pnpm run server` instead of inlining `tsx src/server.ts`,
  so the check fires on the human path too — and the command stops being a second copy of the
  server invocation. Root `pnpm dev` and `pnpm dev:connected` both funnel through it.

  Precedence mirrors the runtime exactly: Node's `--env-file` does not override an already-set
  variable, so a shell value wins over `.dev.vars`, which wins over the spec's `default`. The
  docs gotcha that used to send you to Desktop's local environment editor now points at
  `.dev.vars` instead — Desktop does not inherit your shell, which makes the file the only
  route that works in both places.

  Callout is wired as the reference; the other demos, the scaffolder template (which needs the
  preflight published as a bin), and a generated `.dev.vars.example` are follow-ups.

## 0.1.5

### Patch Changes

- 5e0a3af: The API conventions get a page, and the error model gets an RFC.

  Substrat is opinionated about API shape, and until now that opinion was distributed across
  `CLAUDE.md`, six architecture documents, and the header comments of the files that
  implement it. A builder asking "how should my list endpoint look" had nowhere to be sent.

  `/concepts/api-design` is that page. Nine defaults — the operation spine, boundary parsing,
  value types, keyset pagination, the error model, the context clock, request idempotency,
  additive evolution, and the generated OpenAPI document — each with the shape, the reason,
  and an honest status. Three of the nine are designed and unbuilt, and say so with the issue
  number rather than reading as though they work.

  Writing it turned up one claim in our own docs that was not true. `boundary-lint` does
  **not** check that an operation calls the permission it declares; its rules are star
  topology, raw data access, network, spine writes, and the extraction escape hatch. What is
  actually enforced is narrower: the _declaration_ is a compile error to omit
  (`permission` or `narrows` with a reason, never both and never neither), and the permission
  _surface_ is re-emitted by CI so a widened role appears in the diff. The handler's
  `assertAllowed` first line is convention plus review. The page says that, because a docs
  site that overstates its own mechanisms is worse than one that admits the gap.

  Companion RFC in `docs/rfc/error-model.md` (issue #113): RFC 9457 problem+json, a closed
  ten-code taxonomy with module-owned `reason` slugs, and a four-phase rollout that keeps
  `detail` byte-identical to today's messages — which is what stops the change turning the
  contract suite's thirty message assertions red. It also names the part that is genuinely
  awkward: errors crossing the ScopeDO RPC boundary are rebuilt as plain `Error`s by our own
  adapter code, which is why `instanceof PermissionDenied` is false in production today.

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
