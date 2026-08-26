# @substrat-run/boundary-lint

The Substrat layer rules, enforced mechanically — in this monorepo or in a standalone vertical.

```sh
npx @substrat-run/boundary-lint
```

**Full documentation: https://substrat.net/reference/boundary-lint**

## Why this exists

Every other guardrail in Substrat fails **loud**. Branded IDs fail at compile time. Zod
fails at the boundary. `getScope` fails closed on a mismatched `(tenant, scope)` pair. A
work order cannot skip from `planned` to `closed`.

The layer rules are the ones that fail **silently**:

```ts
// The correct path — the engine's data through the engine's stable surface.
const lines = getReportedLines(ctx, orderId);

// The shortcut. Same rows. Test passes. Demo is green. Nothing fails.
const lines = ctx.sql.query('SELECT * FROM workorder_time_entries WHERE order_id = ?', [orderId]);
```

The second one works. That is the problem. It silently makes an engine's private column
layout part of your vertical's contract, so the engine can never ship a migration again
without breaking a vertical it has never heard of — which voids the promise the whole
model rests on: engines evolve additively, verticals extend by composition and never fork.

R5 has no runtime equivalent. At runtime the two lines are identical. Static analysis is
the only thing that can tell them apart, which is why this is a linter and not a check.

## The rules

| Rule | What it enforces |
|---|---|
| **R1** star topology | an engine never imports another `@substrat-run/engine-*` |
| **R2** no raw access | module code imports no `better-sqlite3`, no adapters, no `node:*` — data access is `ctx.sql` only |
| **R3** no network | module code never calls `fetch()` or imports an HTTP client |
| **R4** spine is sacred | module code never *writes* `_substrat_*` tables (reads are fine — timelines are projections) |
| **R5** tables private | module code never references another module's tables in SQL |
| **R6** no clock | module code never reads the wall clock (`new Date()`, `Date.now()`) — the operation's instant is `ctx.now()` |
| **R7** no bare catch | module code never catches an engine error outside `ctx.atomic` — a `catch` around a raw engine call commits its partial writes (under-fires; see below) |

**Module code** is everything reachable from a `ModuleRegistration` — operations and
consumers. Composition roots (`server.ts`, `seed.ts`, `worker.ts`, …) are harness, and are
exempt; they legitimately touch node, the adapter, and the network.

## Table ownership is derived, never declared

A table is owned by whichever module's `CREATE TABLE` created it. That fact ships inside
the published package — the migration SQL survives compilation into `dist/index.js`
verbatim — so ownership resolves identically from a workspace checkout or from
`node_modules`.

There is deliberately **no manifest field** declaring tables. It would be a second source
of truth, and second sources of truth drift: a manifest claiming `workorder_orders` while
the migration creates `workorder_orders_v2` would make the linter wave through a real
violation. The migration is the source of truth for what a table *is*, so it stays the
source of truth for who *owns* it.

Ownership keys on the **npm package name**, so a workspace link and an installed
dependency are the same owner.

## Configuration

Zero config in the two shapes that matter:

- **A standalone vertical** — module code in `src/`, engines in
  `node_modules/@substrat-run/engine-*`.
- **The Substrat monorepo** — `engines/<e>/src` and `demos/<d>/src`.

Otherwise, `boundary-lint.config.json` (or a `substrat.boundaryLint` key in
`package.json`):

```jsonc
{
  // Local module code: linted, and owns the tables its migrations create.
  "packages": [{ "name": "@acme/bike-shop", "src": "src", "harness": ["server.ts", "seed.ts"] }],
  // Ownership-only sources. Defaults to every installed @substrat-run/engine-*.
  // Add third-party engines here.
  "externals": ["node_modules/@acme/engine-thing"]
}
```

## Engine errors and `ctx.atomic` (R7)

An engine in-scope function is a plain call composed inside your operation's transaction, so
it has no boundary of its own. A bare `catch` around one leaves you holding its partial
writes — the rows its invariants were protecting — and commits them. `ctx.atomic` is the
boundary:

```ts
try {
  await ctx.atomic(() => completeWorkOrder(ctx, { orderId, billable }));
} catch {
  // the engine's rows, events, links, grants and platform intents are all gone;
  // your own writes survive, and it still commits once
}
```

`try`/`finally` with no `catch` is fine, and so is a catch that always rethrows
(`catch (e) { log(e); throw e }`): the operation still fails, so the whole transaction
rolls back either way.

### What R7 does not catch

A rule that misfires on ordinary code gets suppressed wholesale, which is worse than not
having it — so where R7 cannot be sure, it stays quiet. **A clean run is not a proof that no
engine error is swallowed.** Three shapes it does not flag:

```ts
// 1. The call moved into a local helper — R7 reads only the calls written in the `try`.
function finish(ctx, id) { return completeWorkOrder(ctx, { orderId: id }); }
try { await finish(ctx, id); } catch { /* not flagged */ }

// 2. The promise spelling — the rule is the `catch` CLAUSE.
await completeWorkOrder(ctx, { orderId }).catch(() => null);   // not flagged

// 3. An UNBRACED conditional rethrow as the catch's last statement.
try { await completeWorkOrder(ctx, { orderId }); }
catch (e) { if (rare) throw e; }        // not flagged — the throw is the last top-level statement

try { await completeWorkOrder(ctx, { orderId }); }
catch (e) { if (rare) { throw e } }     // flagged — braced, so the throw is not that statement
```

Widening any of these is a change to the linter with fixtures, not a change of character.

## The escape hatch

A one-time extraction handoff (decision 27) opts out of R5 explicitly, in a block a
reviewer can see:

```ts
// boundary-lint-allow R5 — one-time extraction handoff, removed after the cutover
const legacy = ctx.sql.query('SELECT * FROM workorder_time_entries');
// boundary-lint-end R5
```

R6 has the same block for code that must read the real clock. There is no escape hatch for
R1–R4, and deliberately none for R7 — there is no legitimate reason to swallow an engine
error unprotected, so a hatch would only ever silence the rule.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | the layer rules hold |
| `1` | violations found |
| `2` | **the linter could not do its job** |

Exit `2` matters more than it looks. R5 depends on knowing which module owns which table;
if no module code is found, or no engines resolve, every R5 check would trivially pass and
the linter would print a green light it had not earned. A pass that checked nothing is
worse than no linter at all, because an agent then trusts it. So it fails loudly instead.

## Flags

```
--root <dir>   project root (default: cwd)
--verbose      print what is being linted and where ownership came from
```

`--verbose` is the fastest way to confirm the ownership map is populated:

```
boundary-lint: linting
  · @acme/bike-shop  (/app/src)
boundary-lint: table ownership from
  · @substrat-run/engine-workorder  (/app/node_modules/@substrat-run/engine-workorder)
```

## Programmatic use

```ts
import { lint, formatViolations } from '@substrat-run/boundary-lint';

const violations = lint(process.cwd());
if (violations.length) console.error(formatViolations(violations));
```
