---
description: "What makes the platform legible to a coding agent: bring your own model, docs published as markdown, a project that announces its own rules, and self-describing module manifests."
---

# Building for AI agents

Substrat treats coding agents as primary users of the platform, and that shapes the API
more than any other single requirement. If you're pointing Claude Code (or any agent) at a
Substrat vertical, this page explains what the platform does to make itself **legible** to
one — the surface, the docs, and the rules a project announces about itself.

## The one-paragraph version

The layer where LLMs are weakest — tenancy, auth, migrations, integrations, compliance — is
the layer where mistakes are catastrophic. The layer where they are strongest — screens,
forms, workflows, reports — is the layer where mistakes are cosmetic. Substrat puts hard
guarantees under that line and agent velocity above it.

## What stops a mistake

That half of the story — the six guards a change passes through, the layer rules, the
oracle the build is not allowed to edit, and the two things an agent never self-approves —
has its own page: **[Where AI mistakes stop](/guide/ai-guardrails)**. Read it first if the
question you have is *"what happens when the agent gets it wrong"*.

What follows here is the other half: what makes the platform readable to an agent in the
first place.

## Bring your own model, bring your own agent

You are not locked into someone's prompt box. Design and build run in *your* agent against
repo skills — `npm create substrat` writes `AGENTS.md`, `.substrat/playbook.md`, and command
stubs for Claude Code, Cursor and opencode alike, so the project announces its own rules and
build flow to whatever you open it in.

And the code is on your disk, running locally: not "export a zip that dies without our SDK",
but a repo that boots against SQLite with no platform in the loop.

## These docs, as markdown

An agent that reads this site as HTML spends its context on navigation and theme markup.
Every page here is also published as raw markdown at the same path plus `.md` —
`/concepts/model` is also [`/concepts/model.md`](/concepts/model.md) — and two files index
the whole set:

| File | What it is |
|---|---|
| [`/llms.txt`](/llms.txt) | The index: every page, grouped by section, one line of description each. Start here and fetch only the pages you need. |
| [`/llms-full.txt`](/llms-full.txt) | Every page concatenated, for one-shot ingestion. Large — the index exists so this is the fallback, not the default. |

Both state the `@substrat-run/kernel` version they describe, and `/llms.txt` is also served
at `/llms-<version>.txt`. That second URL is the one to pin: Substrat is 0.x and interfaces
change without notice, so an agent holding pages from two minors ago is a real failure mode.
Fetching `/llms-<the version you have installed>.txt` returns 200 only while the published
docs still describe your kernel — a 404 means they have moved on, and the answer is to
re-read `/llms.txt` rather than trust the cache.

::: tip Fetch the markdown, not the page
Point your agent at the `.md` URLs. Links *inside* those files already point at other `.md`
files, so an agent that follows a reference stays in markdown instead of bouncing back into
HTML.
:::

## The project announces itself

You should not have to remember any of the above. A scaffolded vertical carries
`.substrat/hooks/session-start.mjs`, which runs when an agent session opens and hands it
three things it would otherwise have to discover: that this is a Substrat vertical, where
the rules and the build flow live, and the URL of the docs slice describing **the kernel
this project actually has installed** — read from `node_modules`, not from the range in
`package.json`, because a caret on `0.x` pins the minor and the resolved version is what
your code compiles against.

It also remembers which version it last announced, so the first session after an upgrade
opens by stating the jump rather than letting an agent discover it by being wrong.

The script sits in `.substrat/` — the tool-neutral home, beside `playbook.md` — and
`.claude/settings.json` is a three-line adapter that runs it. Any other client that grows
a session hook binds to the same script.

It is silent unless `package.json` has a `substrat` block, so it is inert in any other
project; it makes no network request, so it costs nothing at startup and works offline;
and it never fails a session — any unexpected error exits quietly. Opt out entirely by
creating `.substrat/no-session-context`.

::: tip Why not just check whether the docs match?
Because the check is already mechanical for whoever actually fetches. `/llms-<version>.txt`
returns 200 only while the published docs still describe that kernel, so a 404 *is* the
mismatch warning — and putting an HTTP request on the critical path of every session start,
to compute an answer the next fetch computes for free, is a poor trade.
:::

## Self-describing modules

The [module manifest](/concepts/modules) is what makes a Substrat system legible to an
agent without reading its implementation: every module declares its permissions (with
descriptions), the events it emits and consumes (with schema versions), its entity
relations, its migrations and compatibility window, and its UI contributions. An agent
scaffolding a new vertical can discover the whole surface of the installed engines from
their manifests.

## Local loop

The pure-SQLite adapter is the agent's development loop: real serialization semantics,
real isolation, real stamped events, in-process, deterministic, fast. An agent can build
a module, run the contract tests, inspect the resulting `.sqlite` files, and iterate —
with no credentials and no shared environment to damage.

## Where this is honest about itself

Nothing above claims an agent cannot write a bug. What the platform does about that — and
what it still doesn't — is on [Where AI mistakes stop](/guide/ai-guardrails#where-this-is-honest-about-itself)
and [What Substrat doesn't have (yet)](/guide/what-substrat-lacks).
