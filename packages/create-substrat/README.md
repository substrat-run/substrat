# create-substrat

Scaffold a [Substrat](https://substrat.net) vertical.

```sh
npm create substrat <dir>
npm create substrat .        # scaffold into the current directory
```

**Full documentation: https://substrat.net/reference/create-substrat**

## What you get

A project that installs and runs, plus an **instruction layer** so your AI editor already
knows the rules and the build flow:

- `src/` — `manifest.ts`, `migrations.ts`, `module.ts`, `provision.ts`, `seed.ts`, a Node
  `server.ts` for local work, and a `worker.ts` that mounts the platform surface via
  [`@substrat-run/vertical-host`](https://npmjs.com/package/@substrat-run/vertical-host).
- `test/scenario.test.ts` — the scenario test the build flow grows.
- `AGENTS.md` + `.substrat/playbook.md` — the rules and the build flow, read by Claude Code,
  Cursor, and opencode alike; each gets its own command stub.
- Generated `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`,
  including the `substrat` block that `substrat push` reads — so you never author wrangler
  config.

The scaffolder writes the skeleton; **the agent writes the vertical**, guided by the playbook.

```sh
cd <dir> && pnpm install
# then, in your AI editor:
#   Claude Code:       /substrat
#   Cursor / opencode: the new-vertical command
```

## Don't add `zod`

Substrat is on Zod 4, and Zod schemas do not compose across copies or majors — mixing two
makes `z.object({ facility: entityRef })` fail at runtime with `expected a Zod schema`,
pointing nowhere near the cause. Import `z` from contracts instead, and never install zod:

```ts
import { z, entityRef, money } from '@substrat-run/contracts';
```

## Dependency-free by design

Node built-ins only, no build step. It can never break at install time and damage the name it
exists to protect.

## Note on the name

`substrat` on npm is an **unrelated** package — an HTML5 build system published in 2013.
Substrat's own packages are all under the
[`@substrat-run`](https://www.npmjs.com/org/substrat-run) scope. Never `npm install substrat`.

---

[Docs](https://substrat.net) · [Repo](https://github.com/substrat-run/substrat) · Apache-2.0
