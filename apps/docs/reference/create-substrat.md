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

**The vertical skeleton** — `src/manifest.ts`, `migrations.ts`, `module.ts`, `provision.ts`,
`seed.ts`, a Node `server.ts` for local work, a `worker.ts` that mounts the platform contract
through [`@substrat-run/vertical-host`](/reference/vertical-host), and
`test/scenario.test.ts`.

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
and the Node dev server (`src/server.ts`) on `:8873`. The issuer is a real OpenID Connect
provider whose only shortcut is that `/authorize` lists the people in `src/personas.ts`
instead of asking for a password; the dev server is an ordinary relying party against
whatever `OIDC_ISSUER` names (`http://localhost:8879` by default). Open
`http://localhost:8873/api/auth/login`, pick a name, and you are signed in through the same
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

## Dependency-free by design

Node built-ins only, no build step, no runtime dependencies — so the initializer can never
break at install time.

::: warning `substrat` on npm is not Substrat
It is an unrelated HTML5 build system published in 2013. Substrat's packages are all under the
[`@substrat-run`](https://www.npmjs.com/org/substrat-run) scope. Never `npm install substrat`.
:::
