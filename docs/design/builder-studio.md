# RFC: the builder studio — chat → vertical, hosted

**Status:** proposed — **internal PoC first** (§1.1). Not a customer surface, not linked from
substrat.net or the dashboard. · **Depends on:**
[generated-verticals.md](./generated-verticals.md) (the channel, the debug scope, the CI gate,
and every gotcha that decides whether this is legitimate),
[builder-plane.md](./builder-plane.md) (tenant-owned verticals, builder authz, self-serve
promote), [self-serve-deploy.md](./self-serve-deploy.md) (the push seam, admission, the
declared surface), [control-plane.md](./control-plane.md) (tenant/scope provisioning).

**What this is:** the *application* half of the prompt-to-app channel — the chat surface, the
container the code is written in, the git repo behind it, the preview, and the seam that keeps
the LLM swappable. [generated-verticals](./generated-verticals.md) answered *what the loop is
and where the trust boundary sits*; it did not say what we build. This does.

**Sequencing, stated first so it is not mistaken:** master-plan §7.4 pins the whole channel as
**strictly post-operator-proof optionality**, and §6 below names a blocker that is a product
decision, not an engineering one. Nothing here argues for opening a customer-facing channel; §1.1
scopes what is actually proposed, which is much smaller.

---

## 1. The frame

The local loop already exists and works: Claude Code, the two skills
(`.claude/skills/substrat`, `.claude/skills/new-vertical`), a checkout, and
`pnpm callout-demo dev`. A designer interviews the user into `spec/concept.md`, a builder turns
that into `demos/<name>/src/module.ts`, and the scenario test says whether it holds.

The studio is that loop with the laptop replaced by a container and the terminal replaced by a
chat pane. **Nothing about the method changes** — same skills, same checks, same git. That
observation is not a nicety; it is the design constraint that §3 turns into an interface, and
the reason a local version falls out for free rather than becoming a second product that rots.

**What we are not building:** a general prompt-to-app tool. Master-plan §7.9 (non-goals) excludes
that explicitly — the median generated app has no tenants and unopinionated wins there. The
studio only makes sense for the shape the kernel already enforces.

### 1.1 Scope: an internal PoC, deliberately unlisted

What is proposed is a **staff-only internal tool**, reachable by URL behind the staff roster,
absent from substrat.net, the dashboard nav, and the marketing surface. Everything from §2 onward
describes the full shape because the PoC should not be architecturally disposable — but the
*scope* is this section, and where the two disagree, this section wins.

**Why this framing is not a dodge of §6.** generated-verticals §6.1 offers three ways to make the
permission-diff gate mean something; the first is *"Substrat staff review every promotion —
meaningful, and does not scale, which may be correct early."* **An internal PoC is that option,
selected by construction.** The reviewer is competent because the reviewer is us. So the PoC does
not defer the blocker; it adopts the one answer that is defensible at n=1 staff-operated verticals.
The moment this is offered to anyone outside the staff roster is the moment §6 must be answered
properly, and that transition should require a decision, not a deploy.

**The honest question the PoC exists to answer.** Staff already have the local loop, and for an
engineer it is *better* — real editor, real terminal, no container, no cold start. A studio that
merely reproduces it for people who already have it has no reason to exist. The thing worth
learning is the one that maps onto the eventual product:

> Can a **domain expert who is not an engineer** — the operator, the person who actually knows
> förvaltning or the workshop — drive a session to a vertical that passes the tier-1 gates (§9.1)
> and that staff can then read and admit?

That is the internal workflow *and* the product hypothesis, and it inverts §6 usefully: the
non-engineer builds, the competent reviewer approves. If the answer is no, we learn it against our
own operator work rather than against a paying customer, and the sunk cost is a container image
and a chat pane.

**Secondary purpose, not to be undersold:** the PoC is how §9.3's acceptance ledger and §9.6's
`evals/` get built at all. Both are needed before any customer channel could open, both are useful
to the existing vertical work independently, and neither will ever be prioritised as standalone
infrastructure.

**In scope:** the container and workspace (§3, §4), the generator and chat (§5), Monaco, the
acceptance ledger (§9.3), `evals/` (§9.6), staff-roster auth, preview proxied through the app.

**Out of scope for the PoC:** public preview URLs and the wildcard-DNS work (§4.3 — proxy through
the Worker instead), repo *creation* (import an existing repo, or a platform org), builder-plane
self-serve promotion, `code-server`, multi-tenant studio sessions, billing and cost controls
beyond a hard token ceiling, and anything on a marketing page.

## 2. Shape

An isolated app — `apps/builder`, its own Worker — that owns no durable domain state and talks
to four things it does not own:

| Dependency | For |
|---|---|
| Control-plane API | provision the debug scope, `registerVertical`, push, promote (builder-plane §4) |
| GitHub App (`apps/dashboard/src/github.ts`) | the repo, the CI workflow, PR previews |
| The sandbox (§4) | the filesystem the agent writes into |
| The generator (§5) | the model |

It shares `@substrat-run/ui` with the dashboard and console so the design system does not fork,
but it is **not** a dashboard surface. The dashboard is the privileged control plane for a
running business; the studio is a build tool. Keeping them separate means the studio can be
rewritten or killed without touching what customers operate on.

**Three tiers of state, and only one is durable.** This is the whole reliability story:

1. **The git repo** — source of truth. Every turn ends in a commit (§4.2 forces this).
2. **The workspace container** — ephemeral. Rebuildable from (1) with one clone. Losing it
   costs a boot, never work.
3. **The debug scope database** — throwaway, seeded with a fake world, never real data.

Container loss is therefore never data loss, and that is what lets §4's ephemeral disk be a
design input instead of a defect.

### 2.1 Whose code is this?

**The customer's.** The studio is a tool that helps them build their vertical — the alternative
they have today is pointing their own LLM at the same problem with worse guardrails. We are not
the author, and framing the studio as "we generate apps for you" gets several things wrong at
once. Stating it plainly here because four decisions fall out of it:

1. **They own the output, and can leave with it at any time.** Export is not a feature to be
   earned or a favour at offboarding — it is returning their property, so it is available from
   day one and in a standard format (§4.6: push the history to a repo they own). Anything that
   makes leaving awkward is a defect.
2. **We are a custodian by arrangement, not by default.** This is why §4.6 refuses to put their
   repo in our GitHub org even for the PoC. "It's only our own code right now" was the wrong
   read: the storage layer should be shaped for the relationship the product actually has.
3. **The model provider is a subprocessor, and the choice is theirs to constrain.** Their source
   is sent to whichever LLM runs the loop. A customer may require EU-resident inference, refuse a
   given vendor, or demand no-training / zero-retention terms. **This turns the provider seam
   (D-49) from an engineering nicety into a compliance surface**: "any LLM" is how a procurement
   objection gets answered by configuration rather than by losing the deal — including pointing it
   at a self-hosted model when nothing else will do. Whatever the studio runs by default must be
   disclosed, and per-tenant provider policy is the shape this eventually takes.
4. **Ownership does not transfer the safety promise.** "It's their code and they approved it" is
   not a resolution of §6 and must never be used as one. The platform's entire proposition is that
   it *prevents* the class of failure a non-expert would otherwise ship (master-plan §2); making
   approval trivial and then pointing at the click is exactly the failure mode with extra
   ceremony. Authorship sits with them; the enforcement claim stays ours.

The AGPL point in §10 is the mirror image: their code, our engines, so the commercial licence and
escrow story are part of what they are buying rather than paperwork bolted on later.

## 3. The workspace contract

The seam that keeps hosted and local the same product. Deliberately shaped to the Sandbox SDK's
surface, because that surface is small and the local implementation is then trivial:

```ts
interface Workspace {
  exec(cmd: string, opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  listFiles(path: string): Promise<string[]>;
  exposePort(port: number): Promise<{ url: string }>;
  dispose(): Promise<void>;
}
```

| | Hosted | Local |
|---|---|---|
| `exec` | `sandbox.exec()` | `node:child_process` |
| file ops | Sandbox SDK | `node:fs` |
| `exposePort` | preview URL + wildcard DNS (§4.3) | already `localhost:8871` / `:5271` |
| git | App installation token, clone into the container | the checkout you are sitting in |

Everything above this line — the skills, the generator, the chat UI, the check sequence, the
commit discipline — is identical across both. **Build the interface before there is a second
implementation.** The cost is one file; the cost of not doing it is discovering six months later
that the hosted product and the local one disagree about what a build is.

**One rule about where behaviour lives:** anything that must hold in *both* modes belongs in the
turn loop, above the seam — not in a `Workspace` implementation. Commit-per-turn is the load-bearing
example. §4.2's ephemeral disk *forces* it in the hosted mode but not locally, so if it lived in
`ContainerWorkspace` the local mode would quietly drift into long uncommitted sessions and the
hosted path would be the only one that ever broke. Put it in the loop; let the environment be the
reason it matters, not the mechanism that enforces it.

### 3.1 Three run modes — and only one of them needs a container runtime

| Mode | What runs | Container runtime |
|---|---|---|
| **A. Local-native** | `LocalWorkspace` over a real checkout; studio Worker under `wrangler dev` with the container binding unused | **none** |
| **B. Local container emulation** | `wrangler dev` with the Sandbox binding; image built and run locally | Docker-compatible engine |
| **C. Deployed** | Cloudflare Containers | n/a (Cloudflare's) |

**Mode A is the default and needs no Docker, Podman, or anything else** — `exec` is
`child_process`, file ops are `node:fs`, and the dev servers are the ones
[CLAUDE.md](../../CLAUDE.md) already documents. This is not a degraded fallback: §1 establishes
that the local loop is the *reference* implementation and the hosted one is the port, so mode A is
where the studio is developed day to day, and it is also how §9.6's `evals/` must run — an eval
suite that requires a container runtime is an eval suite that gets run once a quarter.

**Mode B is only for working on the container path itself** — the Dockerfile, `exec` plumbing, the
preview proxy. `wrangler dev` needs *a Docker-compatible CLI and engine*, not Docker specifically:
Docker Desktop and Colima are both named in Cloudflare's docs, and `DOCKER_HOST` points Wrangler at
a non-standard socket when auto-detection fails. So an engineer who never touches §4 never installs
one.

**What mode A gives up, stated so it is not discovered later:**

- **Isolation — there is none.** The agent has shell access to the machine. This is the same
  exposure as running Claude Code locally, with one real difference: the studio drives turns
  *unattended*, so the blast radius is a session rather than a keystroke. Mitigate by pointing
  `LocalWorkspace` at a **scratch clone in a temp directory** rather than your working checkout,
  and by giving it a path allowlist. Do not run mode A against a checkout with real credentials in
  it.
- **Port collisions.** `exposePort` must allocate dynamically once more than one session can run;
  the demo scripts already accept `PORT` / `WEB_PORT` overrides, so this is wiring, not design.
- **Toolchain drift.** The image pins Node and pnpm; your laptop does not. `packageManager` is
  already pinned in `package.json`, which covers most of it — but `better-sqlite3` builds for your
  arch locally and `linux/amd64` in the container, so a native-module failure is one of the few
  things mode A genuinely cannot catch.

## 4. The container

### 4.1 Substrate

Cloudflare Containers via `@cloudflare/sandbox`. Same account, same bindings, same `wrangler`
deploy as every other app in the repo — and Durable-Object-backed, so it composes with the
Agents SDK session (§7) natively rather than by integration.

**Instance type: `standard-3` (2 vCPU, 8 GiB, 16 GB disk).** A pnpm monorepo install plus
`tsc`, vitest, a `tsx` API server and a Vite dev server does not fit below that; `standard-4`
(4 vCPU, 12 GiB) if turns feel slow or a full editor server ships (§7). The SDK's own example
config says `lite` (1/16 vCPU, 256 MiB) — that is for running a Python snippet, not a build.

**The image is the warm repo**: `FROM cloudflare/sandbox:<v>` (Node 20, `linux/amd64`), plus
pnpm, the monorepo, and `pnpm install && pnpm -r build` **baked in**. Cold start is 1–3s and
image-size-dependent, so this trades image weight against not paying a cold install per session
— measure both. `better-sqlite3` must be verified resolving in the image, not installed at
session start (adapter-sqlite is genuinely Node-bound: native bindings, `node:fs`, `mkdirSync`
per scope at [index.ts:1629](../../packages/adapter-sqlite/src/index.ts#L1629)).

Watch the account cap of 50 GB total image storage if variants multiply.

### 4.2 Ephemeral disk is load-bearing

Cloudflare Containers: *"All disk is ephemeral. When a Container instance goes to sleep, the
next time it is started, it will have a fresh disk as defined by its container image."*

So **every turn ends in a commit**, without exception. This is not a workaround — it is the
behaviour we want anyway — it is how a build gets a version history at all, and what
[builder-plane](./builder-plane.md)'s `vertical_channel_history` rollback picker rewinds to —
and it is what makes §2's tier model true. A session that sleeps and wakes resumes by cloning at
`HEAD`. Design for it deliberately rather than discovering it when a customer's overnight
session comes back empty.

### 4.3 Preview URLs — two catches

> **PoC shortcut (§1.1):** none of this is needed at first. `proxyToSandbox()` runs in our Worker,
> so an internal build can serve the preview on a single path under the studio's own origin,
> behind the staff session, and skip wildcard DNS entirely. Both catches below become real only
> when previews need to be shareable with someone who is not signed in — which is a customer
> feature, not a PoC one. Read this section as the cost of that later step.

Format is `https://{port}-{sandbox-id}-{token}.<domain>`, requiring **a custom domain with
wildcard DNS**; `.workers.dev` will not serve them.

- **Route collision.** [apps/router/wrangler.jsonc:89](../../apps/router/wrangler.jsonc#L89)
  claims `*/*` on `substrat.run`. A preview wildcard must be a *more specific* pattern to win —
  which works, and the precedent is already in that file: the comment at line 86 states
  more-specific patterns beat the catch-all, and `*.global.substrat.run/*` on line 88 is exactly
  that shape. Use a dedicated wildcard (`*.build.substrat.run`) or a separate zone, and make the
  router's ownership boundary explicit rather than incidental.
- **Preview URLs are public by default.** *"Anyone with the URL can access your service."* The
  custom token controls URL *stability*, not access. `proxyToSandbox()` runs in our Worker, so
  gate it on the studio session before proxying. An unlisted URL is not access control, and the
  preview is a customer's unreleased application.

### 4.4 Cost

Billing is per 10ms awake: memory and disk on provisioned capacity while awake, CPU on active
use only, and charges stop entirely on sleep. A `standard-3` lands around **$0.10 per awake
session-hour**. An hour of Opus 5 codegen at `xhigh` effort is comfortably 20–30× that, and the
Workers Paid allowance (25 GiB-hours memory ≈ 3 hours at 8 GiB) is noise either way.

**The container is not the cost driver; the model is.** Tune `sleepAfter` short because it costs
nothing to do, and spend the real optimisation effort on prompt caching (§5.4). One genuine cost
bug to avoid, inherited from [generated-verticals](./generated-verticals.md) §6.4: a
regenerate-per-keystroke loop. Debouncing is a design input.

### 4.5 Persistence: git is the durable tier, R2 is a cache

The container's disk is ephemeral (§4.2), which invites an obvious-looking fix: back the
filesystem with R2 so files survive. **Don't.** It is the wrong layer, for reasons that are
design-level rather than mechanical:

- **We already have durable storage with better properties.** The repo gives history, diffs,
  branches, review, rollback and an offboarding story. R2-as-filesystem gives a bag of bytes with
  none of that, and then we would own the sync logic that git already implements correctly.
- **It would fight commit-per-turn.** §4.2's discipline exists precisely so that ephemeral disk
  is survivable. A second persistence path makes "what is the real state of this vertical" a
  question with two answers, which is how the durable tier stops being durable.
- **Mechanically it is also awkward.** R2 is object storage with an S3 API, not a filesystem;
  mounting it wants FUSE and a privilege level a managed container will not give you. Even where
  a sync tool works, you have re-invented `git clone` with worse semantics.

So the resume path is: **clone at `HEAD`, not restore a disk.** Session start clones the repo
into the fresh container; every turn commits; a slept-and-woken session re-clones. Losing the
container costs a boot, never work — which is §2's tier model doing its job rather than being
worked around.

**R2 is genuinely useful here, as a cache — never as the source of truth:**

| Use | Why R2 fits |
|---|---|
| pnpm store / `node_modules` tarball | Large, regenerable, no history wanted. Cuts cold-start install. |
| Session artifacts (build output, screenshots, logs) | Write-once blobs the repo should not carry. |
| Warm-start snapshot of the workspace | Optional fast-resume *optimisation*; the clone remains the correct path, and the snapshot must never be authoritative. |

The test for whether something belongs in R2: **if losing it would lose work, it is in the wrong
place.** A cache you can delete at any time without consequence is the only thing that belongs
there. Note the image already carries prebuilt `node_modules` (§4.1), so the R2 cache is a
second-order optimisation — measure the cold start before building it.

### 4.6 Where the generated repo lives

Generated verticals do **not** live in this monorepo. §4.5 settles that git is the durable tier;
this settles where the remote is, which is a different and more consequential question because it
decides who is custodian of customer code.

The premise throughout is §2.1: **this is the customer's code**, and we are holding it for them.

**Not our GitHub org, as the default.** It is the obvious choice and it is wrong for three
reasons, in ascending order of how hard they are to undo:

1. **Operational scale.** One repo per generated vertical means thousands of repos we administer,
   under one org's limits, App rate limits and billing.
2. **Custodianship.** A private repo of a customer's business logic, held in our org, makes us
   the custodian of their IP with an offboarding story we would have to invent (K-21: tombstone,
   never silently reassign).
3. **Jurisdiction — the non-obvious one, and the reason this is a real decision.** A tenant's
   data has a jurisdiction (`eu`/`us`/`global`) that the platform takes seriously. Putting that
   tenant's *code* in a US SaaS while their *data* is EU-resident is an inconsistency we would
   have to explain to exactly the buyer the trust moat is aimed at. **Code should live where the
   data lives**, under the same tenancy and residency controls.

**Recommended: a bare git repo per vertical, stored in R2 as a `git bundle`.**

`git bundle create <file> --all` is a single file holding the complete repository with history,
and `git clone` accepts one directly. So the flow is: session start fetches the bundle from R2 and
clones it into the fresh container; every turn commits (§4.2); the turn ends by re-bundling and
uploading. Full history, no git host, no third party, and it sits under the same account and
jurisdiction as the tenant's data.

Why this does **not** contradict §4.5's "R2 is a cache, never the source of truth": the
distinction there was between R2 holding *loose files* (no history, competing with git) and R2
holding **git objects** (structured, history-preserving, git remains the interface). Here git is
still the durable tier — R2 is merely where its objects rest. If work would be lost by deleting
it, it is git data and gets versioning; if not, it is cache.

What makes it tractable rather than clever:

- **Single writer, for free.** The `BuilderAgent` DO (§7.1) is the only thing that touches a given
  vertical's bundle, so there is no locking problem to solve — the DO *is* the lock.
- **Durable.** R2 has NO object versioning (verified against docs and API — an earlier draft
  claimed otherwise), so the rollback trail is app-level: ULID-keyed bundle per save
  (lexicographic = chronological), pruned to the last N. Each bundle is complete, so history
  depth is a rollback budget, not a chain.
- **Small.** A vertical's history is a few MB. Bundle-per-turn is cheap.
- **Zero lock-in, and this is the deciding property.** Moving to any git host later is
  `git clone <bundle> && git remote add … && git push`. Choosing this forecloses nothing.

**"Publish to my GitHub" is a one-way export, not a transfer.** When a builder wants their code on
their own GitHub, we push the history into a repo *they* own, through *their* App installation —
we never transfer a repo out of our org, because we never had one. The existing App
(`apps/dashboard/src/github.ts`) already does installation tokens, repo listing and one-click CI
setup for customer-owned repos; the gap is repo *creation*, which is one API call.

**The reversibility argument, since this is a judgement call.** Starting on R2 bundles and later
adopting GitHub is a push. Starting on our GitHub org and later moving customers off means
transferring or deleting repos we have become custodian of, plus unwinding whatever expectations
formed around them. The asymmetry is the argument; the cost of being wrong is low either way
because it is all just git.

**Alternatives considered:** self-hosted Gitea/Forgejo gives a real web UI and PR flow, at the cost
of infrastructure to operate that is not Cloudflare-native — worth revisiting only if the *review*
surface (§6) turns out to want PRs rather than the in-studio diff. GitLab/Bitbucket carry the same
custodianship and jurisdiction issues as GitHub with less existing integration. A git smart-HTTP
server as a Worker over R2 is the "proper" version of the bundle approach and is a project in
itself; bundles get the same durability for a day of work.

## 5. The provider seam

### 5.1 Where pluggability actually lives

Most of what makes this loop work is **already provider-neutral, for free**:

- **The prompt is files** — the two skills, `spec/concept.md`, the manifest surface. Any harness
  that can read a directory can be driven by them. This is master-plan §5.6 and D-21 cashed in.
- **The verification is exit codes** — `pnpm typecheck`, `node tools/boundary-lint.mjs`, the
  scenario test, the migration replay check. A model that cannot pass them does not ship,
  whoever made it.

That is where portability lives, and it costs nothing. The question is only what interface the
*harness* sits behind.

### 5.2 Three candidate seams

**A. Per-message chat abstraction** (LiteLLM / one-interface-many-providers). **Rejected.** It
sounds like the pluggable option and is the least useful one: it collapses to the intersection of
every provider's chat API, which means giving up thinking blocks, prompt-cache breakpoint
placement, the tool runner, skills, and resumable sessions — all of which are exactly what makes
an agentic codegen loop work. It also abstracts the wrong axis: what differs between providers
here is the *harness*, not the message envelope.

**C. Swap the whole studio.** Too coarse to be a seam at all.

**B. The generator seam.** ← recommended. The provider brings its own harness and drives a
`Workspace`; we own the event vocabulary.

```ts
interface VerticalGenerator {
  /** Drive one turn to completion against the workspace. Events stream to the chat pane. */
  run(input: {
    workspace: Workspace;
    concept: string;          // spec/concept.md, or the opening prompt on turn 1
    message: string;          // this turn's user message
    history: SessionRef;      // provider-owned continuation handle
  }): AsyncIterable<BuildEvent>;
}

type BuildEvent =
  | { type: 'assistant-text'; text: string }
  | { type: 'file-written'; path: string }
  | { type: 'command'; cmd: string; exitCode: number }
  | { type: 'check'; name: 'typecheck' | 'boundary-lint' | 'scenario' | 'migration-replay'; ok: boolean; output: string }
  | { type: 'commit'; sha: string; summary: string }
  | { type: 'preview-ready'; url: string }
  | { type: 'needs-review'; kind: 'migration' | 'permission'; diff: string }   // §6
  | { type: 'error'; message: string };
```

`BuildEvent` is **ours**, not a provider's stream shape — that is the actual boundary. The chat
pane, the diff view, the preview and the review gate all render off this union and never see a
provider type. A second implementation is then a contained piece of work rather than a permanent
tax on the first.

### 5.3 The default implementation

**Requirement: any LLM must be runnable.** That decides the harness by elimination — the Claude
Agent SDK and Managed Agents are both Claude-only, so neither can be the *core*; each can only ever
be one implementation behind the seam.

So the default is **`AiSdkGenerator`**: the Vercel AI SDK (MIT, TypeScript) as the provider layer,
with **the model's tools being the `Workspace` methods** (§3). Consequences worth stating:

- **Provider is config.** `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, Ollama for local
  models — tool calling and streaming are normalised across all of them.
- **Identical in every run mode.** Because the tools go through `Workspace`, the generator behaves
  the same over `LocalWorkspace` and `ContainerWorkspace`, and **no API key ever enters the
  sandbox** (§10's "no real secrets in the image" holds by construction rather than by care).
- **Provider-specific settings survive** via `providerOptions` — Claude's adaptive thinking, effort,
  and cache-control breakpoints are passed through rather than abstracted away. This is the part of
  §5.2's warning that the AI SDK genuinely mitigates; it is not a lowest-common-denominator layer.
- **What is still given up:** anything harness-shaped rather than request-shaped — Claude's skills,
  server-side session resumption, and the Agent SDK's context management. We rebuild the last of
  those or do without.

**Recommended settings when the provider is Claude:** `claude-opus-5`, `effort: "xhigh"`, adaptive
thinking **on** (do not disable it — with thinking off the model occasionally writes a tool call
into visible text instead of emitting a `tool_use` block: the turn succeeds, the call never runs,
no error is raised, which in a build loop reads as *"the agent said it created the file and
didn't"*), large `max_tokens` streamed, and the stable skill prefix cached (§5.4).

**"Any LLM" is an architectural guarantee, not a capability claim.** Writing a correct Substrat
vertical is a hard agentic coding task, and weaker or local models will simply fail the tier-1
gates (§9.1). That is the right outcome and it is *self-reporting*: `evals/` (§9.6) is what tells
us which models actually pass, which turns pluggability from a claim into a measurement. Expect a
short viable list and publish it.

**A `ClaudeAgentGenerator` remains worth building later** — same seam, drop-in — if the Agent SDK's
harness proves materially better than our tool loop on the same evals. Build it when the evals say
so, not speculatively.

### 5.4 Prompt caching

The skills plus the manifest surface are a large, byte-stable prefix — cache it. Opus 5's minimum
cacheable prefix is 512 tokens, so even the smaller preambles qualify. Keep the volatile parts
(the user's message, the current diff) after the last breakpoint, and never interpolate a
timestamp or session id into the stable head. This is the optimisation that actually moves the
bill (§4.4). The concrete follow-through — what the loop already does, what we adopt from the
opencode/models.dev research, and in what order — lives in
[builder-harness.md](./builder-harness.md).

## 6. The blocker

[generated-verticals](./generated-verticals.md) §6.1, restated because it governs this document
and no amount of shell polish touches it:

> A smooth prompt-to-app experience ends at a human review gate. If the human is the studio user,
> the checkpoint is a rubber stamp — a non-technical builder clicking approve on a permission diff
> they cannot evaluate. That reproduces the exact failure this platform exists to prevent
> (master-plan §2), with extra ceremony.

Three ways out, none free, **one of which must be chosen before this reaches anyone outside the
staff roster**: staff review every promotion; constrain the generated surface to a fixed
permission/role vocabulary so the diff is cheap to evaluate; or sell the review (the hardening
consultancies of §7.4 are the competent reviewer, and promotion review is their product).

**The PoC selects the first, by construction** (§1.1) — every promotion is staff-reviewed because
every user is staff. That is a real answer at PoC scale and an expiring one: it does not scale, and
the scaling limit arrives exactly when the tool stops being internal. So the useful thing the PoC
can do for this question is not defer it but *inform* it — running real sessions is how we learn
whether option 2 (a constrained permission vocabulary) is achievable, which is the only one of the
three that would let the channel ever be self-serve.

The `needs-review` event in §5.2 is where whichever answer lands gets rendered. Note that a full
in-browser IDE does **not** address this — showing a non-technical reviewer more code they cannot
evaluate is decoration, not review.

**The second constraint** (§6.2 there): regeneration versus append-only migrations. **Scope v1 to
first-ship** — generate, debug, ship once; subsequent edits take the normal vertical path. The
promotion boundary is exactly where migrations freeze, and that is a clean rule worth stating in
the product. Promising regeneration forever is a research project.

## 7. Surface

### 7.1 Where each piece runs — the UI is NOT in the container

The obvious-looking layout is to serve the UI from the sandbox, the way `code-server` does. That
is wrong here, and the reason is the container's lifecycle: it sleeps, and its disk resets when it
does (§4.2). A UI living inside it would mean waking a container just to render a page, losing
chat history to a sleep, and paying container cost for an idle browser tab.

So the split is:

```
Browser — React SPA (chat · code · preview)
   │  WebSocket
   ▼
BuilderAgent — Durable Object, ALWAYS the session's home
   │    · chat history + resumable streaming (Agents SDK AIChatAgent)
   │    · runs the generator loop; holds the provider credential
   │    · survives container sleep, restart, and the user closing the tab
   │  RPC
   ▼
Sandbox — Container DO: the Workspace (§3). exec, files, dev servers.
   │
   ├─ git → the durable tier (§4.5)
   └─ R2 → cache only (§4.5)
```

Three properties fall out of that, and each is the reason for the split rather than a bonus:

- **The credential never enters the sandbox.** The loop runs in the DO; only tool calls cross into
  the container. This is §5.3's property, preserved by construction in the hosted mode.
- **Session outlives the workspace.** Close the tab, come back tomorrow: the DO still has the
  conversation and the ledger; the container is re-cloned at `HEAD` on the next turn.
- **Idle is nearly free.** An open tab with a sleeping container costs a DO, not $0.10/hr (§4.4).

The container is woken lazily — on the first tool call of a turn, or when the user opens the
preview tab. Chat and the code pane must both work while it sleeps, which is possible because
their content comes from the DO and from git, not from the sandbox.

### 7.2 The three panes

Two audiences want different weights, and the difference is real rather than cosmetic:

- **Non-technical builder** — chat, preview, and a readable *diff*. This is the §7.4 latent
  channel's nominal user and the one §6 is about.
- **Hardening consultancy / technical builder** — a real editor and a terminal, because they are
  the competent reviewer the model needs. §7.4 names them as the cheaper first channel, which
  argues for serving them first.

**Monaco for v1** — MIT, the editor core of VS Code, embeds as a component with no server process
in the container. `code-server` / `openvscode-server` (both MIT) as a power-user escape hatch only
if the technical channel proves out; a VS Code server is ~1 GiB resident on top of pnpm, Vite and
`tsx`, which is a real bite out of `standard-3`.

**Monaco versus a real VS Code, stated plainly**, because "a VS Code tab" can mean either:

| | Monaco (v1) | `code-server` (later, opt-in) |
|---|---|---|
| What it is | The editor component of VS Code | The whole IDE, running in the container |
| Terminal, extensions, LSP | No | Yes |
| Works while the container sleeps | **Yes** — files come from git/the DO | No, needs the container awake |
| Cost | Bundle size | ~1 GiB resident, +cold start, +proxy |

The sleeping-container row is the one that decides v1. A code pane that only works when a
container is awake turns "glance at what it wrote" into a wake-and-wait, on the pane people open
most. Monaco plus a file tree and a **diff view** covers reading, reviewing and small edits — and
the diff view matters more than the editor for §6's reviewer, who is reading a change, not
authoring one.

**The preview tab** is an iframe onto a proxied sandbox port (§4.3), so it *does* require the
container awake — which is correct, since a preview of nothing running is meaningless. Opening
that tab is one of the two things that wakes it.

**Session plumbing: the Cloudflare Agents SDK.** `AIChatAgent` gives message persistence and
resumable streaming across reconnects; `useAgent()` / `useAgentChat()` give the React side; state
syncs over WebSockets. Durable-Object-backed, so it sits beside the sandbox container on the same
primitive. This solves "the user closed the laptop mid-build," which is otherwise a bespoke build.

## 8. What we reuse

| | Verdict |
|---|---|
| **Claude Agent SDK** | Take. The agent loop, Read/Write/Edit/Bash/Grep/Glob, context management, hooks, subagents, sessions. Otherwise we rebuild it. |
| **Cloudflare Agents SDK** | Take. §7's session plumbing. |
| **Monaco** | Take. The code pane. |
| **OpenHands** (MIT, ~70k stars) | Study, do not adopt. Architecturally the closest thing that exists — agent session per isolated Docker sandbox with terminal, editor, browser, filesystem. But: Python runtime beside a TS monorepo, its sandbox is Docker-on-host rather than Cloudflare Containers, and enterprise self-hosting needs a license after an evaluation period. Read its sandbox↔agent boundary. |
| **bolt.diy** | Reference only. The right three-pane UX, but built on StackBlitz **WebContainers, which require a commercial license for commercial use** — and WebContainers is browser-Node with no native modules, so `better-sqlite3` cannot run there regardless. Mine the interaction design; that part is genuinely good. |

## 9. Verification — rank checks by who authored the oracle

The question "how do we stop turn 40 breaking what turn 6 established" has a bad default answer
— *the agent writes tests* — that is the testing equivalent of §6's rubber stamp. An agent that
authors both the implementation and its test can get both wrong in the same direction, and a
green suite it wrote is evidence of internal consistency, not of correctness. So the useful
axis is not *how many tests* but **who authored the oracle**, and the tiers differ enormously
in trust.

### 9.1 Tier 1 — gates the agent cannot author (already built)

Four golden-file tools already exist and CI already fails on drift:

| Gate | What it pins |
|---|---|
| `pnpm lint:permissions` | `PERMISSIONS.md` re-emitted from `MODULES` + `ROLES`; a widened role cannot merge without appearing in the diff |
| `pnpm lint:api` | the operation catalog / `API_DOCUMENT`; deterministic by construction, which is what lets string equality be the check |
| `node tools/boundary-lint.mjs` | R1–R5 — raw data access, node imports, spine writes, cross-module SQL |
| migration replay | `0001..000N` from empty, compared to the schema the code expects ([generated-verticals](./generated-verticals.md) §6.2) |

These are the highest-trust checks in the system precisely because **the expected output is
derived from committed artifacts rather than asserted by the author**. The agent cannot make
them pass by writing a matching assertion; it can only make them pass by not drifting, or by
producing a diff a human reads.

They are also, today, **invisible to anything but a terminal**. The studio's job here is
plumbing, not invention: run them every turn and render their diffs as `needs-review` events
(§5.2). That is most of the regression story already paid for.

### 9.2 Tier 2 — invariants the vertical does not need to test

The three-layer rule means state machines that cannot skip states, append-only entries,
immutable-after-export, every-mutation-emits, every-operation-checks are **engine** properties,
verified once in `packages/contract-tests` (`scope-host-suite`, `permission-suite`,
`schedule-suite`) and inherited by every vertical composing them.

This is the structural advantage over a general prompt-to-app tool and it is worth stating
plainly: **the surface a generated vertical's own tests must cover is only its vocabulary,
pricing, roles, and composition** — not the correctness of the workflow substrate. A Lovable-class
tool has to test everything because nothing underneath it is guaranteed. We do not, because
master-plan D-2 (runtime enforcement over conventions) already paid for it.

Generated tests that re-assert engine invariants are noise; the generator should be told not to
write them.

### 9.3 Tier 3 — the acceptance ledger (the oracle the *user* authored)

This is the piece that does not exist yet and the one that makes updates safe.

`demos/callout/test/scenario.test.ts` is not a unit-test suite — it is a **numbered narrative
mirroring the spec**: 13 steps, each an `it` tracing a step of `spec/concept.md` §8, from
"anna creates a work order" through "the guard: a montage order cannot complete without a signed
self-inspection." The test *is* the spec, executable.

The studio can produce that artifact from something a CLI loop throws away: **the user's
confirmations in chat.** Every time the builder says "yes, that's right" — the technician
shouldn't see prices, a closed order can't be reopened, the portal user sees only their own — that
is an acceptance event with a human-authored claim behind it.

- A **pin** affordance on any assistant turn appends a named case to `spec/accepted.md` and a step
  to the scenario narrative. The agent writes the test's *code*; it does not author the *claim*.
- **The whole ledger runs every turn thereafter.** Not a subset, not on request.
- A regression is reported **in the user's own words**: *"Turn 41 broke 'a technician cannot see
  prices' — you accepted that on turn 6."* That sentence is the entire feature; everything else is
  mechanism.

The ledger is also the artifact that makes §6's review gate cheaper over time: a permission diff is
much easier to evaluate next to the list of behaviours the builder already said they wanted.

### 9.4 Tier 4 — agent-authored tests: lint, not proof

Keep them. They catch the agent's own typos and cost nothing. But they are self-graded, so they
**must never be the promotion gate** — a green agent-authored suite is not evidence and should not
be rendered to the user as if it were. Label them accordingly in the UI.

A cheap strengthener: after a turn, run an **independent review** — a second generator invocation
with no memory of having written the code, given only `spec/concept.md`, the ledger, and the diff,
asked to find where they disagree. Different oracle, adversarial framing, one extra call. It
catches direction errors that a self-consistent implementation-plus-test will not.

### 9.5 The update path for a *live* vertical

Everything above tests against a seeded fake world. For a vertical with real users, the strongest
regression test is running the candidate against **a copy of their actual data** — and that
primitive is already designed in [preview-and-snapshots](./preview-and-snapshots.md): `exportScope`
forks a scope, `bindScopeVersion` pairs the fork with the new version, and the router resolves the
pair at a hostname. Run the acceptance ledger against *that*.

This is what upgrades [generated-verticals](./generated-verticals.md) §6.2's "scope v1 to
first-ship" from a permanent limit to a **phase**: first-ship stays the v1 boundary because the
migration-delta problem is real, but the ledger plus fork-and-replay is the mechanism that would
eventually make ship-two defensible. Do not confuse the two — shipping updates needs the migration
answer *and* this, not this alone.

### 9.6 Meta-testing: the studio needs its own regression suite

The most under-appreciated point in this document. **The skills are the product.** Every edit to
`new-vertical/SKILL.md`, every model change, every `effort` adjustment, every prompt-cache
restructure changes what every future vertical looks like — and today there is no way to tell
whether such a change made things better or worse.

So: `evals/` holding N frozen concept documents, each with expected structural properties (gates
pass, these operations exist, these roles hold these permissions, the ledger passes). Run the
generator across all of them on any change to the prompt, the model, or the harness. Compare.

This is the same move `packages/contract-tests` makes for adapters — it is what makes a change to
the generator *reviewable* instead of a leap of faith. Without it, the seam in §5 gives you the
ability to swap providers and no ability to tell whether the swap was an improvement. **Build this
alongside phase 2, not after phase 5.**

## 10. Honest limits

Shipped with the mechanism, per the D-45 rule:

- **`boundary-lint` is not a sandbox.** It is static analysis and generated code can ignore it at
  runtime. Correct as an admission gate, never as the runtime guard.
- **The debug container is disposable, not a security boundary.** That is sufficient *here* only
  because nothing inside it is worth protecting (generated-verticals §3.2). It still wants egress
  control and no real secrets in the image.
- **Mode A has no isolation at all** (§3.1). The container is a disposability boundary in the
  hosted path and simply absent locally — an agent driving unattended turns with shell access to a
  developer's machine. A scratch clone and a path allowlist are mitigations, not a sandbox, and the
  doc should not imply otherwise.
- **Preview URLs are public by default** (§4.3) until we gate them.
- **Licensing.** The engines are AGPL and a generated vertical bundles them. If the build container
  is Anthropic-hosted (Managed Agents) *and* runs the engines to test, that is the same AGPL
  surface generated-verticals §7 wants kept in-house — and §9's ledger means tests genuinely do run
  the engines, so this is not hypothetical. Keep the debug scope ours; let a hosted agent
  container write code and push, not run engines. The Agent SDK option avoids the question entirely.
- **Facets are deferred, not rejected.** generated-verticals §3 prefers DO facets (ms boot, parity
  by identity). A facet is a scope, not a dev server — it cannot serve Vite with HMR and it needs
  esbuild in the loop. The container does both, so facets become an optimisation for the scope
  runtime once boot time or density hurts, not a v1 fork.
- **§6.3 is unresolved and this document does not resolve it.** A successful channel means N
  deployments for N generated apps, and master-plan §5.5's one-deployment-per-vertical topology
  does not survive its own success. Building the container loop first buys operating experience
  before that call; it must not be allowed to make the call by accident.
- **A green suite is not a correct app.** §9.4's tier is self-graded; §9.3's ledger only covers what
  a user thought to accept. Neither proves absence of the failure mode master-plan §2 names — a
  misconfigured permission that nobody thought to write a case for. The tier-1 gates and the human
  diff are still what catch that class, which is why §6 does not get easier as the ledger grows.
- **Nobody has committed to maintaining generated code.** Engine surfaces evolve additively, but N
  generated verticals each pin engine versions and none has a maintainer. If the generator wrote
  it, does the generator upgrade it — and who verifies the upgrade? §9.3's ledger is the only
  artifact that would make an automated upgrade checkable, which is an argument for building it
  early even though the update path is out of v1 scope. This is §6.3's cousin and it is unanswered.

## 11. Phasing

**The PoC (§1.1) is phases 1–4. Phases 5–6 are the customer channel and are not proposed.**

1. **Workspace, then image.** `Workspace` (§3) with `LocalWorkspace` first, the four tier-1 gates
   (§9.1) wired to exit codes, then the Dockerfile and `ContainerWorkspace` against the same
   interface. No model, no UI. Provable by driving the existing Callout build through the interface
   by hand — if that does not work, nothing after it will. Local-first ordering is deliberate: it
   keeps mode A (§3.1) honest rather than letting it become a retrofit of the container path.
2. **Generator + chat + evals.** `ClaudeGenerator`, `BuildEvent`, the Agents SDK session, chat
   pane, Monaco, commit-per-turn, preview proxied through the Worker behind the staff session —
   and `evals/` (§9.6) in the same phase, because from here on every prompt or model change is
   otherwise unmeasurable. Repo imported, not created.
3. **The acceptance ledger.** Pin affordance, `spec/accepted.md`, ledger-runs-every-turn,
   regressions reported in the user's words (§9.3). This is what makes a *multi-turn* session
   safe, and it is the artifact with value independent of whether the studio ever ships.
4. **The real test: a domain expert drives it** (§1.1). Not a demo — one of our own operator
   verticals, built by the person who knows the domain, reviewed and admitted by staff. This phase
   produces a written answer to the §1.1 question and a recommendation, not a feature.

   — *PoC ends here. Everything below requires a decision, not a sprint.* —

5. **Repo + push + public previews.** Repo creation through the GitHub App (today we only
   *import*), the wildcard route and preview auth (§4.3), one-click CI, then builder-plane §4's
   self-serve private-vertical path end to end.
6. **The gate.** Whichever §6 answer was chosen, rendered off `needs-review`.

Every PoC phase is independently reversible and leaves something behind even if the studio is
abandoned: phase 1 gives a containerised build of the monorepo, phase 2 gives `evals/` for the
skills, phase 3 gives the acceptance ledger. **That is the test of whether this is a good PoC** —
if a phase leaves nothing behind when cancelled, it is scoped wrong.

## 12. Open questions

- **What would graduate this from PoC?** §1.1 names the question the PoC answers, but not the bar.
  A domain expert reaching a staff-admittable vertical *once* is an anecdote; some number of times,
  against some class of domain, is evidence. Set the bar before phase 4, or the PoC will be judged
  on enthusiasm.
- **Where does it live?** A separate `apps/builder` Worker behind the staff roster keeps container
  bindings out of the privileged console and preserves the option to make it a product. Hosting it
  inside `apps/console` is cheaper — staff auth and UI are already there — at the cost of putting a
  container binding next to the control plane. Recommendation: separate Worker; the saving is a day
  and the coupling is permanent.
- **§6's three options** — which one, *if* it graduates. Product decision; blocks phase 6. The PoC
  runs on option 1 by construction and should report on whether option 2 looks reachable.
- **Who maintains a generated vertical as the engines move?** (§10, last limit.) Platform-driven
  regeneration verified by the ledger, pinned-forever-and-bit-rot, or a paid maintenance tier —
  each implies a different business, so this is not only an engineering question.
- **Does the ledger survive a rewrite?** If turn 40 restructures the module, ledger cases written
  against turn 6's operation names break as *tests*, not as *behaviour*. Cases probably need to
  bind to the spec's vocabulary rather than to function signatures; unproven.
- **Exit.** A customer's business runs on generated code. The repo being theirs is most of the
  answer and is why git is the source of truth (§2), but the engines are AGPL + commercial and the
  studio should say so at signup rather than at churn.
- **Repo ownership.** Does the studio create a repo in the customer's GitHub org (App needs
  `administration: write`), or in a platform org with a transfer path? Affects offboarding (K-21:
  tombstone, never silently reassign).
- **Preview domain.** Dedicated wildcard on `substrat.run` versus a separate zone — the latter
  keeps the router's `*/*` unambiguous at the cost of another zone to manage.
- **Session ↔ sandbox lifetime.** `sleepAfter` value, and whether an idle session evicts the
  container immediately (cheap, ~3s to resume) or holds it (responsive, ~$0.10/hr).
- **Does the studio hold the concept phase, or only the build phase?** The `substrat` skill's
  interview is a genuinely different interaction from the `new-vertical` build loop, and merging
  them into one chat may be worse than two modes.

## 13. Proposed decision-log entries

Not yet in master-plan §12 (latest is D-46). **D-47 is the one the PoC decision implies; D-48–D-51
are shape, and only need recording if the PoC graduates** — though building against them costs
nothing now and retrofitting them later costs a rewrite.

- **D-47 — The builder studio is built as an unlisted internal tool first, and staff review is its
  §6 answer at that scale.** No marketing surface, no dashboard entry, staff roster only; the
  competent-reviewer problem is solved by construction because every user is staff. Rationale: the
  local loop already serves engineers, so the only hypothesis worth testing is whether a
  *non-engineer domain expert* can reach a staff-admittable vertical — which is simultaneously the
  internal workflow and the product question, testable against our own operator work rather than a
  paying customer. Offering it outside the staff roster is a separate decision that re-opens §6,
  not a deploy.

- **D-48 — The studio's local and hosted modes are one product behind a `Workspace` interface.**
  The method (skills, checks, git, commit-per-turn) is identical; only `exec`, file access and
  port exposure differ. Rationale: the local loop is the reference implementation and already
  works, so the hosted one is a shell over it — and a shared interface is what stops the two
  from silently diverging into different definitions of "a build."
- **D-49 — The LLM is pluggable at the generator seam, and running any provider is a requirement,
  not an option.** A `VerticalGenerator` produces our `BuildEvent` union over a `Workspace`; the
  default implementation uses the Vercel AI SDK with `Workspace` methods as the model's tools, so
  provider is config and no credential enters the sandbox. Rationale: the prompt (files) and the
  verification (exit codes) are already provider-neutral for free, so the only real question was
  where the harness binds — and a hard any-LLM requirement rules out the Claude Agent SDK and
  Managed Agents as the *core*, leaving them as optional implementations behind the same seam.
  The honest bound: architecture permits any model, `evals/` (D-51) decides which ones can
  actually pass the gates, and that list is expected to be short.
- **D-50 — Regression safety comes from an acceptance ledger the user authored, not from tests the
  generator wrote.** A pinned confirmation in chat becomes a named case in `spec/accepted.md` and a
  step in the scenario narrative; the whole ledger runs every turn; a break is reported in the
  builder's own words. Agent-authored tests stay, labelled as lint, and never gate a promotion.
  Rationale: an agent that writes both the implementation and its oracle can be wrong in the same
  direction twice, so the only assertions worth trusting are the ones it did not author — the
  golden-file gates that already exist (`lint:permissions`, `lint:api`, boundary-lint, migration
  replay) and the user's own accepted behaviours. This is also what makes the *chat* interface
  load-bearing rather than cosmetic: a terminal loop discards the acceptance signal, and the
  ledger is the only artifact that could later make an automated engine-upgrade checkable.
- **D-51 — The generator itself is regression-tested against frozen concept fixtures (`evals/`).**
  Any change to the skills, the model, the effort level or the harness runs N stored concepts and
  compares structural outcomes. Rationale: the skills are the product, so a prompt edit is a
  fleet-wide behaviour change with no reviewable diff — this is what `packages/contract-tests` is
  for adapters, applied to the thing that writes every future vertical.
- **D-52 — A generated vertical's repo is hosted by us as a git bundle in R2, not on GitHub; a
  builder's own GitHub is a one-way export target.** One bare repo per vertical, written only by
  that vertical's `BuilderAgent` DO, stored under the tenant's namespace with R2 object versioning.
  Rationale: the code is the customer's (§2.1) and we merely hold it, so code should live where
  the data lives — a tenant with EU-resident data whose business logic sits in a US SaaS is an
  inconsistency aimed squarely at the buyer the trust moat targets — and hosting customer repos in
  our own org would make us custodian of their IP at a scale (thousands of repos) with an
  offboarding story we would have to invent. The decision is also
  asymmetrically reversible: bundles → any git host is a `git push`, while our-org → elsewhere
  means transferring repos we should never have held. §4.5's "R2 is a cache" still holds, because
  git objects are not loose files: git remains the durable tier and R2 is only where it rests.
  (Correction, post-implementation: R2 has no object versioning — rollback is app-level ULID-keyed
  bundle history, not a bucket feature.)
- **D-53 — The generated vertical is the customer's code; the studio is a tool, not the author.**
  Export is available from day one rather than at offboarding, we hold the repo as custodian by
  arrangement (D-52), the model provider is a disclosed subprocessor the tenant may constrain, and
  ownership is never offered as an answer to §6. Rationale: the honest description of the product
  is "a better-guardrailed agent than the one they would point at this themselves" — and each
  consequence is something that becomes expensive to retrofit once customers exist. The
  subprocessor point is the one with teeth: it converts the pluggable provider seam (D-49) from a
  portability nicety into the mechanism that answers a procurement objection by configuration —
  EU-resident inference, a vendor veto, or a self-hosted model — instead of by losing the deal.
- **D-54 — The generator's skills are builder-distilled documents owned by the studio
  (`apps/builder/skills/`), not the repo's Claude Code skills.** The originals assume monorepo
  access ("read `demos/callout/…`"), a deploy CLI, and curl — all unreachable or denied in the
  project-rooted sandbox — and they duplicate the system prompt's module rules, so every turn
  billed the same rules twice and pointed the model at files it cannot read. The distilled pair
  carries the engine coverage map + concept template (interview phase) and inline code shapes
  replacing the unreachable reference files (build phase), at roughly a third of the size.
  Consequence accepted: a second document to keep in sync when platform surfaces change — the
  studio's files say so in their header, and `evals/` (D-51) is the mechanism that catches a
  drifted skill producing a vertical that no longer passes the gates.
- **D-55 — Which skills ride a turn is decided by a phase ladder derived from workspace facts,
  and prefix content changes only at phase boundaries.** Three phases — interview (no
  `spec/concept.md`), scaffold (no `src/module.ts` yet), iterate — gate a skill manifest
  (`phase.ts`) shared by both hosts; the UI's phase stepper renders the same server-emitted
  facts, so what the user sees IS what the generator is loaded for. Rationale: a phase the
  loader can't detect at turn start is a phase it can't enforce (which is why
  "planning" and "design" are not phases — they happen inside interview turns with no
  workspace fact between them), and per-turn dynamic prefix selection would invalidate the
  prompt cache from byte one — anything finer-grained than a phase belongs behind a read
  tool, not in the prefix. The ladder is monotonic in practice; a deliberate re-design
  (deleting/rewriting the concept) moves it backward honestly, because the facts moved.

## 14. Addendum — studio teams (2026-08-15)

Supersedes "multi-tenant studio sessions" in §1's out-of-scope list. The studio is now
**team-scoped**, the dashboard's model verbatim (dashboard-teams.md: team = tenant):

- **URL**: the first path segment is the team slug (`builder.substrat.net/<team-slug>`),
  exactly the dashboard's scheme — slugs carry a ULID tail, so they can never shadow a
  reserved segment. The SPA rewrites an absent/unknown slug to the remembered (else first)
  membership; a pasted link always lands in the team it names.
- **One BuilderAgent DO per team** (`idFromName(tenantId)`), mirroring the per-tenant
  IdentityDO pattern: projects, chat history, and names partition by tenant. The pre-teams
  shared instance (`idFromName('studio')`) was deliberately abandoned, not migrated —
  nothing in it was worth saving.
- **Membership is the dashboard's**: the worker verifies its own OIDC session, then asks
  the shared control plane (`POST /internal/builder/identity-tenants`, service-token
  gated, over a service binding) which tenants that login builds for — the same
  `builderTenantsFor` read `/api/auth/whoami` does session-side, reachable because the
  studio cannot share the CP's session secret. Every `/api/*` call names its team via
  `x-substrat-tenant`; a team outside the caller's own memberships is refused before the
  DO is addressed.
- **The staff roster stays as an AND-gate** until the builder entitlement flag exists on
  plans (builder-plane.md §"open questions"). Dropping it is then a one-line deliberate
  act — the teams work never widens access by itself.

Follow-ups this creates: per-team metering scopes (retiring the fixed studio node,
src/metering.ts), the plan entitlement + a `builder:use` dashboard role key, and eager
vertical registration so a project surfaces in the dashboard's Deployments view.
