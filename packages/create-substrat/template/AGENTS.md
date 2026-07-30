# Building on Substrat — agent instructions

This project is a **Substrat vertical**: a multi-tenant business app built on the
Substrat kernel and its engines. This file is the always-on constitution — the rules
that hold no matter what you touch. It is read by every AI tool (Claude Code, Cursor,
opencode); do not duplicate it into tool-specific config.

The full build flow — interview, coverage map, scaffold, run, checkpoints — is a
**playbook**, not always-on context. Invoke it when you start or extend a vertical:

- **Claude Code**: `/substrat`
- **Cursor / opencode**: the `new-vertical` command, or read [`.substrat/playbook.md`](.substrat/playbook.md)

Read the playbook before scaffolding. This file is what a session already mid-build
must never violate.

## The mental model

Three layers. You only own the third.

1. **Kernel — free, always.** Tenancy (one scope = one isolated database; there is no
   cross-tenant API), permissions (roles, grants, and a proof path for every decision),
   events + audit (every mutation emits a kernel-stamped event you cannot mislabel),
   migrations (journaled per module, applied lazily per scope).
2. **Engines — compose or feed.** Headless, own invariants that cannot be violated
   (state machines that can't skip states, append-only entries). You either **compose**
   an engine (import it; its in-scope functions run in *your* transaction) or **feed** it
   (emit a fat event; it consumes — no import). Engines never import each other. Read an
   engine's real surface from `node_modules/@substrat-run/engine-*/dist/index.d.ts` —
   never guess at it.
3. **Your vertical — everything a user touches.** Vocabulary, price list, extra fields,
   roles, screens. If your core noun isn't something an engine already owns, this is most
   of the app — a normal, supported outcome.

## Project layout

The linter and tests expect this shape. `manifest`/`migrations`/`module` are **module
code** (the rules below bind them); `seed`/`server` are **harness** (exempt).

```
src/manifest.ts        moduleManifest.parse({…}) + PERM consts   ← module code
src/migrations.ts      the SqlMigration[]                         ← module code
src/module.ts          imports both; operations + registration    ← module code
src/seed.ts            host, tenants, roles, grants, seed world    ← harness
src/server.ts          thin wrapper, one route per operation       ← harness
test/scenario.test.ts  the scenario — including the denials
```

## The rules (non-negotiable)

**Module code** = everything reachable from a `ModuleRegistration` (operations,
consumers). Rules 1–4 are enforced mechanically by `boundary-lint`.

1. **Data access is `ctx.sql` only.** Never import `better-sqlite3`, an adapter, or
   `node:*` in module code.
2. **No `fetch` / network in module code.** It would hold the scope's transaction open on
   a third party. The sanctioned path is a **connector**: emit a fat event, register a
   handler that runs outside the transaction. An integration is never impossible because
   of this rule — it has an answer.
3. **Never write `_substrat_*` tables.** Reads are fine (timelines are projections);
   writes forge the audit spine.
4. **Another module's tables are private.** Never `SELECT` from `workorder_*` etc. — use
   the engine's exported in-scope functions. This is the rule with no runtime equivalent:
   the shortcut *works* and silently welds you to an engine's private schema forever. Need
   extra data on an engine entity? Add **your own side table keyed by the engine's id** —
   never a column upstream.
5. **Every operation checks a permission first.** `assertAllowed(await ctx.check(PERM))`
   is the first line.
6. **Every mutation emits a fat event** — a consumer must never need a cross-module read.
7. **Never fork an engine.** Extend by composition. If you must fork, the engine drew its
   line wrong — that's design feedback, not a coding problem.
8. **IDs are `ulid()`. Money is strings** via `@substrat-run/contracts` helpers
   (`moneyOf`, `mulMoney`, `addDecimal`, `compareDecimal`) — never floats.
9. **Web-standard APIs always** — `globalThis.crypto`, `TextEncoder`, `URL`. Never
   hand-roll a hash to dodge an import ban.
10. **Parse, don't trust.** Zod at every boundary — but import `z` from
    `@substrat-run/contracts`, **never from `zod`**. Zod schemas don't compose across
    copies or majors; composing a contracts schema into one built from a separate `zod`
    fails at *runtime* (`expected a Zod schema`) with an error pointing nowhere near the
    cause.

## Declare every link edge

`entityRelations` in the manifest must declare every edge you traverse — both your own
(`bike → customer`) and the ones an engine makes on your behalf (`workorder → bike`). The
adapter **rejects** a `ctx.link` for an undeclared edge, so a missing one fails loudly.
This is also what lets a portal permission-walk reach the owner.

## The gates — run them, believe them

```sh
npm test                        # the scenario, including the denials
npx @substrat-run/boundary-lint # the layer rules (1–4)
npm run typecheck
```

`boundary-lint` exits non-zero if it *couldn't do its job* (no module code found, no
engines resolvable) — a pass that checked nothing is worse than no linter. Never wave that
through; fix the setup until it can see your code.

A green scenario test does **not** mean the app works: the test calls operations directly
and never exercises `server.ts`, its routes, or the principal picker. Before calling a
vertical done, boot the server and drive the real flow over HTTP as two personas — one who
should succeed and one who should be denied — and confirm the denial arrives as a denial
(not a generic error).

## Two human checkpoints — you may never self-approve

Present these and stop:

1. **Migration diff** — every new `SqlMigration`, verbatim. Migrations are append-only
   forever once shipped, so this is the last cheap moment to change your mind.
2. **Permission diff** — a table: key → description → which roles hold it → why. Walk the
   reviewer through it in their own vocabulary until they can answer *who can now see the
   money, and who can see other tenants' data?* A permission diff nobody understands is
   theater — it reproduces the exact failure Substrat exists to prevent.
