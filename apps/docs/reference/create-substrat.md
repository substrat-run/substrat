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

## Dependency-free by design

Node built-ins only, no build step, no runtime dependencies — so the initializer can never
break at install time.

::: warning `substrat` on npm is not Substrat
It is an unrelated HTML5 build system published in 2013. Substrat's packages are all under the
[`@substrat-run`](https://www.npmjs.com/org/substrat-run) scope. Never `npm install substrat`.
:::
