# RFC: the agent surface — how any agent discovers and works with Substrat

**Status:** proposed · **Supersedes** the strategy narrative in #749 (which stays as tracking)
· **Depends on:** [api-surface.md](./api-surface.md) (the emitted OpenAPI document),
[generated-verticals.md](./generated-verticals.md) and [builder-studio.md](./builder-studio.md)
(the hosted channel), [self-serve-deploy.md](./self-serve-deploy.md) (the push seam).

The master plan already says the platform's primary users are agents
([master-plan.md](../master-plan.md) §5.6, decision 15) and that *"can an agent build a
vertical unaided up to the checkpoints?"* is the recurring benchmark. What it does not say
is **how an agent finds that out**. That question has been answered eight different times in
eight different files, and this document is the first place it is answered once.

---

## 1. The principle

> **Bring your own agent, bring your own model.** A builder uses whatever they already have
> — Claude Code, Cursor, Codex, opencode, Kiro, something that does not exist yet — and the
> integration is as smooth as the client can express.

This is a positioning commitment, not a feature list. The adjacent products each pick one
axis: Wasp assumes a developer in a terminal and ships a Claude Code plugin; Floot assumes
no terminal at all and *is* the IDE. Substrat runs locally **and** hosts a studio, so we are
exposed on both, and "supports Claude Code" would be the wrong shape of answer — it would
make every new client a new project.

The corollary, which is the whole design: **we do not build N integrations.** We build one
neutral core and let each client bind to it however it binds.

---

## 2. Two questions with different answers

Conflating these is what made the plan hard to see.

- **Discovery** — how does an agent learn what Substrat *is* and what the rules are, before
  it has written anything? Answered by documents: `AGENTS.md`, `llms.txt`, the docs site.
- **Interaction** — what can an agent *do*, and against what? Answered by surfaces: the repo
  and its gates, the hosted studio, and a deployed vertical's API.

Discovery is nearly free and disproportionately valuable. Interaction is where the real
engineering is. We have been funding the second and assuming the first.

---

## 3. The rule: a client-neutral core, and adapters that only route

This is already the de facto architecture in `create-substrat`. It has never been named, so
nothing stops the next client from being wired a different way.

**The core** — client-neutral, carries all substance:

| File | What it carries |
|---|---|
| `AGENTS.md` | The always-on contract: three layers, ten module-code rules, the gates, the two checkpoints. Also published at [substrat.net/guide/agent-rules](https://substrat.net/guide/agent-rules). |
| `.substrat/playbook.md` | The on-demand build flow: interview, coverage map, design document, reshape, checkpoints. |
| `substrat.net/llms.txt` | The docs index for an agent that has not scaffolded anything, keyed to a kernel version. |

**The adapters** — per client, and deliberately tiny. Every one of these is 5–10 lines that
delegate:

| Client | Binding | Substance |
|---|---|---|
| Claude Code | `CLAUDE.md` (one line: `@AGENTS.md`), `.claude/skills/substrat/`, `.claude/settings.json`, `.claude/launch.json` | none — routes |
| Cursor | `.cursor/rules/substrat.mdc`, `.cursor/commands/new-vertical.md` | none — routes |
| opencode | `.opencode/command/new-vertical.md` | none — routes |
| Codex | reads `AGENTS.md` natively | none needed |
| Kiro | reads `AGENTS.md` natively ([steering docs](https://kiro.dev/docs/steering/)) | none needed |

**The rule this establishes:** *an adapter may route, describe, and trigger. It may never
contain a rule.* A rule that lives in one client's file is a rule the other clients do not
have, which is the exact failure the two-checkpoint discipline exists to prevent.

The same holds for **configuration an adapter needs in order to trigger**, which is where
`.claude/launch.json` (#752) would otherwise have broken the rule: it carries the dev
topology — commands, env, and up to three ports per demo. Those facts already exist in
`package.json`'s `dev` script, `src/server.ts` and `app/vite.config.ts`, so writing them
into a Claude-only file would have made it a fourth copy that only one client can read and
only one client's users would notice going stale. Instead the topology is declared once in
the neutral `substrat.devServers` block — the block `substrat push` and the SessionStart
hook already read — and the launch file is **emitted** from it. The corollary worth stating:
*if an adapter needs a fact, the fact goes in the core and the adapter is generated.*

The evidence that this is right, and that it is worth stating rather than assuming: **the
`AGENTS.md` convention alone already covers Codex and Kiro with no work at all.** Two of the
five clients need no adapter. The cheapest way to support the sixth is to keep the core
strong, not to write a sixth adapter.

---

## 4. Three planes of interaction

#749 frames this as two axes (Wasp's and Floot's). That undersells the third, which is the
one neither competitor can copy.

### 4.1 The build plane — an agent in the user's repo

The user's own agent, on their disk, against a vertical that boots on SQLite with no
platform in the loop. Interaction is *the repo and its gates*: `npm test`, `boundary-lint`,
`typecheck`, `lint:permissions`, `lint:model`.

This is where "mechanical pushback beats prompting" cashes out — the agent does not need to
be convinced, it needs to be told no by a linter. Largely shipped; the gaps are distribution
(#753, #755) and freshness pinning (#754).

### 4.2 The studio plane — an agent we host

`apps/builder`. Fully designed elsewhere ([builder-studio.md](./builder-studio.md),
[builder-harness.md](./builder-harness.md)) and out of scope here except for one property
this document owns: **the model seam is part of the principle.** "Bring your own model" is a
claim the studio has to keep, not just the local loop.

### 4.3 The runtime plane — an agent against a *deployed* vertical

An agent building a UI, an integration, or an internal tool **against a running vertical it
did not build**. Today: #112 (MCP server, admin/build/user-runtime scopes), #127 (handover
bundle: OAS view + scoped token + context file), #131 (app as a first-class surface),
#125/#126 (Lovable and Bolt experiments).

Three tracking issues, no design document, and it is the plane where the differentiation
actually lives: a deployed vertical already has an emitted OpenAPI document
([api-surface.md](./api-surface.md)), a permission spine, and a tenancy model — so a token
handed to a third-party agent can be **scoped to one app, one tenant, one operation set**.
Wasp and Floot cannot offer that, because neither has a tenancy model to scope a token to.

**This RFC does not design the runtime plane.** It names it as its own plane and asserts it
deserves its own document, rather than being filed under "the Floot axis".

---

## 5. Discovery: the cold start is the weak one

Two entry points, and they are in very different health.

**Warm start — the user scaffolded.** `npm create substrat` writes the core and every
adapter. An agent opening that project is oriented before it reads a line of code. This
works today.

**Cold start — the user says "build this with substrat.net".** The agent fetches the site
and gets `layout: page` with a `<Marketing />` component. Nothing in that response is a rule,
and nothing routes it to one.

`llms.txt` (#751) is the fix, with one caveat that must be stated plainly: **no standard
obliges any client to fetch `/llms.txt`.** It is a convention. Some agents probe it, most do
not. So the cold start is improved but not solved, and the honest ranking of what closes it:

1. **Point the core at the published docs.** `AGENTS.md` does not mention substrat.net at
   all today, and `.substrat/playbook.md` references it once as an *HTML* URL. Cheapest
   available fix, and it improves the warm start too. **Open.**
2. **The SessionStart hook** (#754) — reliable, Claude Code only, and the reason `llms.txt`
   is version-keyed.
3. **Advertise from the site itself** — the homepage `<head>`, `robots.txt`. Cheap, weak,
   worth doing.

---

## 6. Canonical sources, and which drift guard is correct

Agent-facing truth now lives in `AGENTS.md`, `.substrat/playbook.md`, `SKILL.md`, the docs
site, `llms.txt`, `model.json`, and the emitted OpenAPI. Three different mechanisms guard
them, chosen case by case. The rule was never written down, so here it is:

| Situation | Guard | Example |
|---|---|---|
| Two copies that must read **identically** | **Re-emit and diff** — one is generated from the other | `lint:agent-rules`, `lint:model`, `lint:api`, `lint:permissions`, `lint:launch` |
| Two copies that diverge **on purpose** | **Hash baseline** — fail when the source moves, force a human to port | `lint:playbook` (skill → playbook) |
| A document describing code, with no derivable artifact | **Staleness proxy** — commits to the source since the page last moved | `lint:docs` |

**Prefer the first.** A copy that must be identical should not be a copy at all — it should
be emitted. Reach for the hash baseline only when the divergence is deliberate and valuable,
and say why in the tool's header.

`lint:launch` is the first case where the source is **code rather than a document**, and it
is worth naming what that changed: a port is not declared at all. The declaration says which
env var moves a server and which file binds it; the number is read out of that file's
`process.env.<VAR> ?? N`. A declared number would have been a second copy, and the copy that
goes wrong is always the one nobody runs.

**The standing constraint:** every new agent-facing artifact must name its canonical source
and its guard *before* it ships. The failure mode is not one stale file, it is an agent
reading two of our documents and finding them inconsistent — at which point it has no way to
know which one binds.

---

## 7. Non-goals

- **A per-version documentation archive.** A Cloudflare Pages deploy replaces the whole
  site, so versioned doc URLs would 404 the next day. We publish the current version and let
  a pinned fetch 404 as the signal. Reasoning in #751.
- **A `start-dev-server` skill.** Claude Desktop ships preview servers natively via
  `.claude/launch.json`, which every demo and the template now carry (#752). Wasp's plugin
  predates that capability.
- **Bare title indexes.** Wasp's `llms.txt` carries no descriptions, which works because
  their page titles are self-describing. We have seven pages titled *Events*.
- **A client-specific rule anywhere.** See §3.

---

## 8. Status

| Surface | State |
|---|---|
| `AGENTS.md` + playbook, client-neutral core | shipped |
| Adapters: Claude Code, Cursor, opencode (+ Codex, Kiro for free) | shipped |
| `llms.txt`, `llms-full.txt`, `.md` twins, version pin | shipped (#751) |
| Published agent rules page | shipped |
| Core points at the published docs | **open — §5, cheapest win available** |
| SessionStart hook, version pinning | open (#754) |
| Plugin marketplace, skills | open (#753, #755) |
| `.claude/launch.json`, emitted from `substrat.devServers` | shipped (#752) |
| Kiro adapter beyond `AGENTS.md` | open — needed only if steering earns its keep |
| Runtime plane: MCP, handover bundle, scoped app tokens | open, undesigned (#112, #127, #131) |

## 9. Open questions

1. **Does the runtime plane get its own RFC now, or after the first real consumer?** The
   one-step-ahead rule (master-plan §5.6) argues for waiting; #131 and #127 are both blocked
   on decisions nobody has made.
2. **Is `llms.txt` worth maintaining if nothing fetches it automatically?** It is nearly
   free, so the bar is low — but if the SessionStart hook and the core pointers do the real
   work, `llms.txt` is a fallback for cold starts, not the main channel. Worth revisiting
   once we can measure it.
3. **Do we ever ship an adapter that is not thin?** If a client can express something
   genuinely better — Kiro's spec workflow, say — §3's rule forbids putting substance there.
   That rule should hold until it visibly costs us something.
4. **How would we know any of this works?** There is no measurement. The builder evals
   (#630) measure the hosted loop; nothing measures whether an agent that met us cold
   produces a vertical that passes the gates.
