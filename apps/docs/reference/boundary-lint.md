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
consumers. Composition roots (`server.ts`, `seed.ts`, `worker.ts`, …) are harness and exempt.

| Rule | What it enforces |
|---|---|
| **R1** star topology | an engine never imports another `@substrat-run/engine-*` |
| **R2** no raw access | module code imports no `better-sqlite3`, no adapters, no `node:*` — data access is `ctx.sql` only |
| **R3** no network | module code never calls `fetch()` or imports an HTTP client |
| **R4** spine is sacred | module code never *writes* `_substrat_*` tables (reads are fine — timelines are projections) |
| **R5** tables private | module code never references another module's tables in SQL |

Table ownership is **derived, never declared**: a table belongs to whichever module's
`CREATE TABLE` migration created it, and that SQL survives compilation into `dist/`, so
ownership resolves identically from a workspace checkout or from `node_modules` (keyed on the
npm package name). There is deliberately no manifest field for it — a second source of truth
would drift and wave a real violation through.

### The escape hatch

R5 alone has an explicit, reviewable opt-out for a one-time extraction handoff (decision 27):

```ts
// boundary-lint-allow R5 — one-time extraction handoff, removed after the cutover
const legacy = ctx.sql.query('SELECT * FROM workorder_time_entries');
// boundary-lint-end R5
```

There is no escape hatch for R1–R4.

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
