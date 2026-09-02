---
'create-substrat': patch
---

A symptom → fix table in `AGENTS.md`, for the failures that point somewhere other than
their cause.

Six of them, each of which has cost someone a day: a Zod error naming nothing you wrote
(two copies of Zod — import `z` from `@substrat-run/contracts`), a `pkill` that takes down
every other Substrat project on the machine, a green local run that is red in CI because
the build output was warm, a green test suite over an app whose HTTP layer nobody drove, a
permission still denied after the role was widened because the scope keeps the projection
it was provisioned with, and an install that dies compiling `better-sqlite3` because an
`onlyBuiltDependencies` entry makes pnpm run a `node-gyp rebuild` that 13.x does not need.

The table lands in the always-on rules file, so it reaches every scaffolded project and —
through `lint:agent-rules` — the published copy at
[substrat.net/guide/agent-rules](https://substrat.net/guide/agent-rules) that an agent can
read before it has scaffolded anything.
