# create-substrat

The initializer — scaffolds a vertical that installs, runs, and already carries the rules your
AI editor needs.

```sh
npm create substrat <dir>
npm create substrat .        # scaffold into the current directory
```

[Getting started](/guide/getting-started) builds the smallest real thing by hand, package by
package, to show what the pieces are. This is the other entry point: the full project shape in
one command, for when you want to build an actual vertical rather than learn the layers.

## What it writes

**The vertical skeleton** — a working bike shop, laid out the way the linter and tests expect:

```
src/entities.ts        defineEntities — what exists
src/operations.ts      defineOperations — the declared surface (input, output, permission, http)
src/manifest.ts        the module manifest + permission and env constants
src/migrations.ts      the append-only SqlMigration[] journal
src/module.ts          the handler bodies, bound to the declaration
src/provision.ts       MODULES, ROLES, grant shapes — what `substrat push` reads
src/seed.ts            a world to develop against
src/personas.ts        the local dev cast, read by the dev issuer and the seed
src/routes.ts          the HTTP API, DERIVED from the operations — it holds no table
src/server.ts          the Node dev server (SQLite adapter, OIDC against the dev issuer)
src/worker.ts          the deployable Cloudflare worker
src/config-do.ts       the per-instance config store (Cloudflare only)
test/scenario.test.ts  the scenario, including the denials
test/entities.test.ts  the entity registry held to the tables its migrations create
```

`src/operations.ts` is where an operation is declared; `src/module.ts` holds only its body.
`src/routes.ts` derives every *operation* route from the `http` each operation declares, through
`mountOperations` from [`@substrat-run/vertical-host`](/reference/vertical-host), and both
`server.ts` and `worker.ts` mount that one derivation — so a new operation route is a declaration
on its operation, never a handler added to one entrypoint. Two kinds of route stay hand-written
and are meant to: the generic `POST /api/invoke` transport `routes.ts` registers above the
derived table, which keeps an operation that declares no `http` of its own reachable on both
hosts; and each entrypoint's own auth-shaped routes, which answer "who am I on THIS host" and
cannot be shared — `/api/auth/*` and `/api/me` in `server.ts`, `/api/me` in `worker.ts`. The permission keys `defineOperations`
takes are the same array `src/provision.ts` hands `definePermissions({ …, keys })`, which throws
at module load when those keys and `MODULES` disagree. [Agent rules](/guide/agent-rules) is
the same layout, emitted from the `AGENTS.md` the scaffolder writes.

**The instruction layer** — `AGENTS.md` (the rules) and `.substrat/playbook.md` (the build
flow), plus a command stub per tool so Claude Code, Cursor and opencode all read the *same*
two files. This is the point of the scaffolder: the skeleton is small, but an agent that
already knows the [three-layer rule](/guide/architecture) and the
[module-code rules](/concepts/modules) is what makes the next hour productive.

**The generated configs** — `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
and a project `README.md`. The `package.json` carries the `substrat` block that
[`substrat push`](/reference/cli) reads — the permission surface it diffs at the promotion
checkpoint, and the runtime needs it derives deploy config from. You never author wrangler
config.

## Then the agent builds

```sh
cd <dir> && pnpm install
```

Open the project in your AI editor and start the flow — `/substrat` in Claude Code, the
`new-vertical` command in Cursor or opencode. See [building for AI agents](/guide/ai-agents)
for what that loop looks like and why the rules live in the repo rather than in a prompt.

## Signing in locally

```sh
pnpm dev
```

starts **two processes**: [`@substrat-run/dev-issuer`](/reference/dev-issuer) on `:8879`
and the Node dev server (`src/server.ts`) on `:8891`. The issuer is a real OpenID Connect
provider whose only shortcut is that `/authorize` lists the people in `src/personas.ts`
instead of asking for a password; the dev server is an ordinary relying party against
whatever `OIDC_ISSUER` names (`http://localhost:8879` by default). Open
`http://localhost:8891/api/auth/login`, pick a name, and you are signed in through the same
round-trip a deployment runs — the seed links each persona's `sub` to a principal in the
identity directory, so the vertical never learns who you are from anything but a verified
token. There is no dev header and no dev auth branch: pointing the project at Auth0,
Keycloak or your own issuer is a change of `OIDC_ISSUER`, not of code. A script that needs
to act as someone mints a bearer at the issuer instead —
`curl -XPOST localhost:8879/dev/token -d '{"sub":"dev|greta"}'`.

The **worker** is the honest half of that story. `src/worker.ts` — what
[`substrat push`](/reference/cli) deploys — ships **no auth**: every `/api/*` request is
`401` until you wire its `authenticatedPrincipal` seam. Nothing in it resolves a caller in
any environment, so there is nothing to accidentally deploy; a hosted instance whose
`substrat:auth` issuer is configured answers with a 401 body that names this exact
function. The shape to fill in is the one `server.ts` already has: verify the request
against the issuer with [`@substrat-run/vertical-auth`](/reference/vertical-auth)'s
`oidcRpAuthProvider`, then map the subject to a `PrincipalId` per scope — locally through
`host.admin`, hosted through the per-tenant `IdentityDO`, which also brings the owner-claim
and invite flows a fresh install needs.

The worker's **first** registration is the invocation log, and it must stay first:

```ts
app.use('*', invocationLog<Env>({
  routerSecret: (env) => env.ROUTER_SECRET,
  allowUnsigned: (env) => env.ALLOW_DEV_NODE === 'true',
}));
```

[`invocationLog`](/reference/kernel#trusting-the-edges) from `@substrat-run/kernel` writes one
line per *routed* invocation, stamped with the tenant and scope the router asserted. An
invocation whose assertion it cannot accept — an un-routed local request, a missing, malformed or
unverifiable one — emits no line at all, deliberately: a line with no tenant is one nothing may
show a tenant, and inventing one is the only way this could leak. So an empty local log is the
contract working, not a fault to chase. Cloudflare keys
observability on the worker script, and one script serves every tenant that installed the
vertical, so this line is the only thing that files your invocations under the tenant they
served — without it the app's Observability page stays empty and says nothing about why. It
must come before every route because Hono runs handlers in registration order and stops at the
one that answers, so a route registered above it is never logged. On the deployed path the stamp
is taken from the *verified* router assertion (`routerSecret`), never from the header — the same
verification the vertical's own `nodeFor` does, with the same secret, and a failed one writes
nothing. `allowUnsigned` is the local-only exception to that, and the two knobs must be given the
same answers here as in `nodeFor`: it accepts the `x-substrat-*` headers unverified so an
un-routed dev instance still logs, which anywhere a secret is configured would make the tenant a
caller-controlled claim again. Keep it bound to `ALLOW_DEV_NODE`, and keep `ALLOW_DEV_NODE` out of
production. `pnpm lint:invocation-log` refuses a missing, late or secretless mount.

## Dependency-free by design

Node built-ins only, no build step, no runtime dependencies — so the initializer can never
break at install time.

::: warning `substrat` on npm is not Substrat
It is an unrelated HTML5 build system published in 2013. Substrat's packages are all under the
[`@substrat-run`](https://www.npmjs.com/org/substrat-run) scope. Never `npm install substrat`.
:::
