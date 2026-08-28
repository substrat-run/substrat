# @substrat-run/boundary-lint

The **Substrat layer rules, enforced mechanically** — the static analysis behind the
[three-layer rule](/concepts/modules) and the module-code rules, runnable in this monorepo
or against a standalone vertical. It ships a `substrat-boundary-lint` bin.

Every other guardrail in Substrat fails **loud**: branded IDs at compile time, Zod at the
boundary, `getScope` closed on a mismatched `(tenant, scope)`. The layer rules are the ones
that fail **silently** — a raw `SELECT` against an engine's private table returns the right
rows, the test passes, and nothing tells you the engine can now never ship a migration. This
linter is the only thing that can tell the shortcut from the sanctioned path.

```sh
npx @substrat-run/boundary-lint
```

## What it checks

**Module code** is everything reachable from a `ModuleRegistration` — operations and
consumers. Composition roots (`server.ts`, `seed.ts`, `worker.ts`, …) are harness and exempt,
and so are the Durable Object classes a hosted vertical ships by filename — `auth-do.ts`,
`config-do.ts` (the `*-do.ts` shape `create-substrat` scaffolds): they import `DurableObject`
from `cloudflare:workers` because the runtime requires the base class, not to reach the
ambient env.

| Rule | What it enforces |
|---|---|
| **R1** star topology | an engine never imports another `@substrat-run/engine-*` |
| **R2** no raw access | module code imports no `better-sqlite3`, no adapters, no `node:*`, no `cloudflare:workers` — data access is `ctx.sql` only. `cloudflare:workers` is banned for a sharper reason than the rest: it exports an **ambient `env`**, so one import hands module code every binding and secret the script declares, including its own `SCOPE` namespace — which reaches another scope's data, where `ctx.sql` cannot |
| **R3** no network | module code never calls `fetch()` or imports an HTTP client |
| **R4** spine is sacred | module code never *writes* `_substrat_*` tables (reads are fine — timelines are projections) |
| **R5** tables private | module code never references another module's tables in SQL |
| **R6** no clock | module code never reads the wall clock (`new Date()`, `Date.now()`) — the operation's instant is `ctx.now()` |
| **R7** no bare catch | module code never catches an engine error outside [`ctx.atomic`](/concepts/modules) — a `catch` around a raw engine call commits its partial writes (under-fires; see below) |

R7 allows the two shapes that do not swallow: `try`/`finally` with no `catch`, and a catch
that always rethrows (`catch (e) { log(e); throw e }`) — the operation still fails, so the
whole transaction rolls back either way.

::: warning R7 under-fires, on purpose
A rule that misfires on ordinary code gets suppressed wholesale, which is worse than not
having it — so where R7 cannot be sure, it stays quiet. **A clean run is not a proof that
no engine error is swallowed.** Three shapes it does not catch:

- an engine call moved into a **local helper** — R7 reads only the calls written inside the
  `try`;
- the **promise spelling**, `await completeWorkOrder(ctx, x).catch(() => null)` — the rule is
  the `catch` clause;
- an **unbraced** conditional rethrow as the catch's last statement,
  `catch (e) { if (rare) throw e; }` — read as an always-rethrow. Braced
  (`catch (e) { if (rare) { throw e } }`) is caught, because there the throw is not the
  catch's last top-level statement.

Widening any of these is a change to the linter with fixtures, not a change of character.
:::

Table ownership is **derived, never declared**: a table belongs to whichever module's
`CREATE TABLE` migration created it, and that SQL survives compilation into `dist/`, so
ownership resolves identically from a workspace checkout or from `node_modules` (keyed on the
npm package name). There is deliberately no manifest field for it — a second source of truth
would drift and wave a real violation through.

### The escape hatch

R5 and R6 have an explicit, reviewable opt-out — R5 for a one-time extraction handoff
(decision 27), R6 for code that must read the *real* clock (a JWT whose `exp` a remote
server judges):

```ts
// boundary-lint-allow R5 — one-time extraction handoff, removed after the cutover
const legacy = ctx.sql.query('SELECT * FROM workorder_time_entries');
// boundary-lint-end R5
```

There is no escape hatch for R1–R4, and deliberately none for R7: unlike a data handoff or
a real-clock JWT, there is no legitimate reason to swallow an engine error unprotected, so a
hatch would only ever be used to silence the rule.

## Running it

```sh
node tools/boundary-lint.mjs      # the monorepo entry point (what CI runs)
npx @substrat-run/boundary-lint   # a standalone vertical (zero config)
```

Both call the same code — the monorepo lints itself with the exact linter a from-scratch
vertical runs, so the rules can never drift between the two. Zero config in the two shapes
that matter (a standalone vertical with module code in `src/`; the monorepo's
`engines/*`/`demos/*`); otherwise a `boundary-lint.config.json` or a `substrat.boundaryLint`
key in `package.json` names the local packages and any third-party engines. It is also
usable programmatically via `lint()` / `formatViolations()`.

Exit codes are load-bearing: `0` clean, `1` violations, and **`2` the linter could not do
its job** — no module code found, or no engines resolved, so an R5 pass would trivially
succeed. A green light it had not earned is worse than no linter, so it fails loudly instead.

CI runs `node tools/boundary-lint.mjs` on every change (see the project's `Commands`), so a
boundary violation cannot merge.

## Versioning

`0.0.5`, Apache-2.0 — the same permissive license as [`@substrat-run/contracts`](/reference/contracts),
because the rules are part of the public module contract, not the proprietary runtime.
