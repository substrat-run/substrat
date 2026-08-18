# FAQ

Short answers, each pointing at the page that has the long one.

## What is Substrat, in one sentence?

A hosted substrate for vertical B2B SaaS: multi-tenancy, permissions, audit, and GDPR
enforced **below** the API surface, so it stops mattering who — or what — wrote the code
above them. → [What is Substrat?](/guide/what-is-substrat)

## How is this different from a framework like Rails or Wasp?

A framework gives you **conventions**; Substrat gives you **guarantees**. Conventions are
correct the day they're written and erode with every edit after. A guarantee is a property of
the runtime: there is no API that returns another tenant's data with the wrong flag set,
because the API for reaching a scope *is* the isolation mechanism.

For one app for one organization, take the framework — it will beat us, and it isn't close.
→ [How Substrat compares](/guide/comparisons)

## How is this different from Supabase?

Supabase does enforce at runtime, but the guarantee is contingent on row-level-security
policies **you** write correctly — precisely the surface inexperienced builders and LLMs
misconfigure most. Substrat's isolation is not a policy you author. It is also
vertical-SaaS-shaped rather than app-shaped: nested tenancy, a module system, domain engines.
→ [Backend-as-a-service](/guide/comparisons#backend-as-a-service)

## How is this different from Lovable, Bolt, or Base44?

They generate the whole app, *including the dangerous parts*. Substrat inverts the split: the
dangerous 30% is a hardened substrate; the safe, high-velocity 70% — screens, forms,
workflows — is where generation happens.

They're complementary, not rivals. A prompt-to-app tool pointed at Substrat's manifest
generates *above* the guarantees instead of reinventing them.
→ [Building for AI agents](/guide/ai-agents)

## Do I own the code?

Yes, and it runs without us. The whole stack boots on the pure-SQLite adapter with no
platform in the loop — that is how CI runs on every commit. Contracts and the build surface
are Apache-2.0; the runtime (kernel, adapters, engines) is AGPL + commercial, with escrow.

Said plainly: *"open source"* here means **copyleft and inspectable, not permissive**. If MIT
is a requirement, this is a real reason to pick something else.
→ [What Substrat doesn't have (yet)](/guide/what-substrat-lacks)

## Can I self-host it?

Your **vertical**, yes — it is published, AGPL, has one runtime dependency, and is
contract-tested on two adapters. The multi-tenant **hosting product** — router, control
plane, PR previews, per-tenant database minting — is private and Cloudflare-native.

Escrow answers *"can we keep running"*. It does not answer *"can we run the platform
ourselves"*. That distinction is deliberate and we'd rather state it than blur it.

## Do I have to use AI to build on it?

No. Substrat is an ordinary TypeScript codebase and works fine with no agent anywhere near
it. It is *designed* for agents — small typed surface, mechanical pushback, self-describing
manifests — because that design also makes it legible to humans. The two goals turned out to
be the same goal.

## Which model does the AI tooling use?

Whichever you point it at. Design and build run in *your* agent (Claude Code, Cursor,
opencode) against skills that ship in the repo, and the hosted builder runs against a model
you choose. Your tokens, your model, your agent.
→ [Building for AI agents](/guide/ai-agents#bring-your-own-model-bring-your-own-agent)

## What can't an agent do on its own?

Two things, and they hold even in a fully agent-driven shop:

1. **Schema migrations** — the blast radius of a bad one is data, not pixels.
2. **Permission definitions** — who can do what, where in the tree.

Both are reviewed as a human-readable diff, and CI re-emits the permission artifact and fails
on drift, so a widened role cannot merge without appearing in the pull request.
→ [Why runtime enforcement?](/guide/why-substrat#the-two-human-checkpoints)

## How do I know a new version won't destroy my customers' data?

You watch it happen first. Open a pull request and the platform forks the production scope,
runs *that PR's code and migrations* against the copy, and posts a URL on the PR. When a bind
crosses a migration-digest boundary the pre-migration state is snapshotted automatically —
the digest comparison is the gate, not a flag anyone remembers to pass. Per-scope
point-in-time rewind covers roughly 30 days underneath all of it.
→ [Environments & previews](/guide/environments-and-previews)

## What's an "engine", and why can't I just fork one?

A headless, versioned package that owns an invariant — a state machine that can't skip
states, an append-only ledger, an invoice that is immutable after export. You extend it by
**composition**: call its in-scope functions inside your own operation, in your own
transaction, with your own permission check.

You *can* fork one; nothing stops you. But if you need to, the engine drew its line wrong —
that's the design test, and we'd rather hear about it.
→ [What is an engine?](/engines/)

## Why two levels of tenancy?

Because one is never enough for the customers this is for, and retrofitting the second is
close to a rewrite. A tenant is the customer you bill; a **scope** is the consistency domain
inside them — a branch, a site, a housing association, a country. Permissions inherit down
the tree; data does not leak up it.
→ [Tenants & scopes](/concepts/tenancy)

## Is it production-ready?

It is 0.x, and interfaces change without notice until the first vertical ships. There are
verticals deployed and serving real data on it today, on custom domains. Whether that adds up
to "ready" depends entirely on what you need — the honest inventory of what is missing is
[here](/guide/what-substrat-lacks), and it is not short.

## What if I'm building something Substrat is wrong for?

Then use something else, and the docs will tell you so rather than sell around it. Single-
tenant internal tools, scale-heavy single tenants, deep-domain products like payroll or core
banking, and anything where the foundation isn't your binding constraint are all better served
elsewhere.
→ [When Substrat is the wrong tool](/guide/comparisons#when-substrat-is-the-wrong-tool)

## How do I start?

```sh
npm create substrat my-app
```

→ [Getting started](/guide/getting-started)
