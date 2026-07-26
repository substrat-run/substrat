# Deploying a vertical

[Running locally](/guide/running-locally) ends on a promise: the SQLite adapter you run on
your laptop and the Cloudflare adapter you deploy on are the same kernel above
[the scope-host contract](/concepts/scope-host) — *only the composition root changes*. This
page is how you cross that gap. The tool is the **`substrat` CLI**, and the shape of the
crossing is deliberately two moves, not one: a **push** uploads your vertical; an **admission**
lets it serve. They are separate on purpose.

## Push is not deploy

The single idea to hold onto:

> A push lands a **pending** version. Admission — a human decision, in the console — is what
> lets a scope bind it and serve. A push that served without admission would be a way for code
> nobody vetted to reach a production isolate, so there is no such path.

This is the same [two-checkpoint discipline](/concepts/modules#two-human-checkpoints) that
governs migrations and permissions, extended to the deploy boundary. `substrat push` is
something an author (eventually an untrusted, paying *builder*) runs; admission is something the
platform does. The full trust model — why an opaque customer bundle can be accepted at all, and
the [sandbox contract](https://github.com/substrat-run/substrat/blob/main/docs/design/self-serve-deploy.md)
that makes it safe — is its own design note. What you need to ship a vertical is below.

One credential principle underpins all of it: **the author never holds a Cloudflare token.** The
control plane holds the Workers-for-Platforms credential and does the upload; the CLI builds
locally and POSTs a bundle. (Decision D-34.)

## Install

The CLI is published to npm as [`@substrat-run/cli`](https://www.npmjs.com/package/@substrat-run/cli) (Apache-2.0):

```bash
npm install -g @substrat-run/cli    # or: pnpm add -g @substrat-run/cli
```

That gives you the `substrat` bin. Inside this monorepo it is also wired at the root as
`pnpm substrat`, so the examples below work either way.

## Sign in — `substrat login`

```bash
substrat login
```

The default is a **browser loopback login**: the CLI starts a one-shot server on `127.0.0.1`,
opens your browser to the control plane's CLI broker (`{cp}/auth/cli`), which signs you in
through [AuthHero](/concepts/identity) and redirects back with a PKCE-bound `code`. The CLI
exchanges the code for a session token and stores it in `~/.substrat/config.json`. The token
never transits a URL — only the code does — and the loopback server accepts exactly one callback,
then closes.

For CI, where there is no browser, store a service credential instead:

```bash
substrat login --token <SERVICE_TOKEN>    # the control plane's service-actor credential
```

Either way, auth resolves in this order at push time: explicit `--token` /
`SUBSTRAT_SERVICE_TOKEN` → a stored browser session → a stored service token. The control-plane
URL resolves `--cp` → `SUBSTRAT_CP_URL` → the stored config (default
`https://console.substrat.net/api`). You are always authenticated **as yourself** — a push is
attributable to the human or service that ran it, never a hand-picked actor.

## Your workspace

A vertical is owned by a **workspace** (a tenant), not a bare user — the same account you sign
into the [dashboard](/platform/dashboard) with. On `login` the CLI resolves which workspaces you
belong to and stores a default; `substrat whoami` prints them:

```bash
substrat whoami
# signed in as you@acme.com
#   acme-co  (Acme Co)
```

Which workspace a **push** acts for is pinned per project, not per machine: a
`"substrat": { "tenant": "acme-co" }` block in the vertical's `package.json` (the first
interactive push offers to write it for you; `--tenant` / `SUBSTRAT_TENANT` override). The
stored login default is deliberately *not* used for pushes — the first push of a slug claims it
for a workspace, and a global default silently pointing at the wrong one would claim it for the
wrong owner. You never type your workspace *into* a slug — the control plane forms the prefix
for you (next section). New here? Sign up once in the dashboard to create your workspace, then
the CLI just works.

## Ship it — `substrat push`

```bash
cd my-vertical && substrat push
```

Run it from the vertical's directory (the one with `wrangler.jsonc` + `package.json`) and it
needs no flags: the **slug** and **name** come from a `"substrat": { "slug", "name" }` block in
`package.json` (or are derived from the package name), and the **version** defaults to the
registry's latest, patch-bumped — so you never hand-track it. Override any with `--slug`,
`--name`, or `--version`. This:

1. **Builds the bundle** with `wrangler deploy --dry-run --outdir` — running your vertical's own
   `build.command` first. workerd cannot bundle in the isolate, so the build always happens on
   your side; the endpoint only ever receives a *built* worker.
2. **Reads your `wrangler.jsonc`** for the declared surface that travels with the bundle: your
   own Durable Object classes, your own D1 databases (e.g. a Better-Auth `AUTH_DB`), the
   compatibility date and flags (a vertical needing `nodejs_compat` can't start without them),
   and the entry module. A vertical's *own* stores travel with it; the platform's do not.
3. **Computes digests** — manifest, permission (from the bindings), migration (from the DO
   classes) — the same digest-diff surface the checkpoints read.
4. **POSTs the bundle + manifest** to `{cp}/verticals/{slug}/deploy`, authenticated with your
   own credential.

The endpoint validates your declared bindings against the sandbox contract — a customer bundle
that tries to declare a `CONTROL_PLANE` binding or a platform secret is refused *before* it
reaches the namespace — uploads to the `substrat-verticals` Workers-for-Platforms namespace under
a `deploymentRef`, and records a **pending** version. It never promotes or binds. On success the
CLI prints the version id, its `pending` admission state, and the `deploymentRef`:

```
✓ pushed. version 01J… is pending; deploymentRef=acme-co-helpdesk-01j…
  admit it in the console to let a scope bind it.
```

### The `<workspace>/` prefix

You push a **bare** `--slug helpdesk`; the vertical's registry id is `acme-co/helpdesk` —
your workspace slug, prepended by the control plane from your authenticated session. You never
type it. The point is that the name is unique *by construction*: every workspace can own a
`helpdesk` without a global land-grab, the same way project names are scoped to your account on
Vercel. (This prefixes only the registry id and the `deploymentRef` — never an app's hostname,
which is per *instance* and chosen when someone creates one.)

Ownership is claimed on first push and fixed there: a later push to `helpdesk` from a different
workspace is *its own* `other-co/helpdesk`, and no one else can push versions of yours.

## See what you've pushed — `substrat versions`

```bash
substrat versions helpdesk
# VERSION  ADMISSION  CHANNELS      ID
# 0.2.0    admitted   staging       01J…
# 0.1.0    admitted   dev,prod      01J…
```

A bare slug again — the control plane resolves it under your workspace. The same view is in the
dashboard's **Deployments** tab (below), so you can watch admission state and channels without
the CLI.

## Promote to dev / staging — `substrat promote`

Once a version is **admitted**, you move it onto a channel yourself:

```bash
substrat promote helpdesk --channel staging --version 01J…
```

Channels are named pointers per vertical — `dev`, `staging`, `prod` are the same vertical pinned
differently. You self-serve `dev` and `staging`; **`prod` is not yours to promote.** Production
promotion, and the admission that precedes it, are a deliberate platform decision (the trust
boundary the [self-serve deploy note](https://github.com/substrat-run/substrat/blob/main/docs/design/self-serve-deploy.md)
draws) — `substrat promote … --channel prod` is refused, and so is the dashboard's prod control.

## Watch it in the dashboard

Everything above is mirrored in the [dashboard](/platform/dashboard)'s **Deployments** view: the
verticals your workspace has pushed, each version's admission state, and which channel points
where — with the same `dev`/`staging` self-serve promotion, and `prod` shown read-only. Push
from the CLI, manage from either.

## The whole path

**push → pending version → admission → promote → serve** — laptop to production with the author
never holding a Cloudflare credential, and no unvetted code reaching a production isolate:

| Step | Who | Where |
|---|---|---|
| `push` a bare slug → `<workspace>/<slug>` pending version | you (the builder) | CLI |
| **admit** the version (the human gate) | platform staff | console |
| promote `dev` / `staging` | you | CLI or dashboard |
| promote `prod` | platform staff | console |
| resolve hostname → scope → dispatch | the [router](/platform/router) | — |

## Where this is going

Self-serve for *vetted* builders — you own your verticals, push them, and drive their non-prod
channels — is what ships today. The remaining evolution is admitting *untrusted* source safely:
building a customer's code in a disposable sandbox so the digest checkpoints become verified
rather than advisory, at which point the staff admission gate can relax. That trust model is the
[self-serve deploy design note](https://github.com/substrat-run/substrat/blob/main/docs/design/self-serve-deploy.md).
