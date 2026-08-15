---
"@substrat-run/builder": patch
"@substrat-run/builder-workspace": minor
---

Truncated turns continue instead of burning the repair budget, and the skills absorb the lessons from the first real studio build.

**Continuation passes on step-ceiling truncation.** A pass that ends `truncated`
was cut mid-work — that is "not done yet", not "done but broken", but the hosts
gated the half-finished tree anyway: the gates went red on incompleteness, and
the whole `MAX_GATE_REPAIRS` budget was spent on mere continuation under a
misleading "fix the failures" framing (observed: a scaffold converging over
initial + 2 repairs, then stalling red until the builder typed "continue").
All three hosts (local server, hosted DO, dev CLI) now drive `runToCompletion`:
while a pass ends truncated, re-prompt with `continuationPrompt` — "pick up
exactly where you left off, do not start over" — BEFORE the gates run. The cap
(`MAX_CONTINUATIONS = 2`) is per turn and shared across the first pass and
repair passes; both policy pieces live in gates.ts beside `MAX_GATE_REPAIRS`
so the hosts cannot drift. Worst case is now 5 model runs per turn (1 + 2
continuations + 2 repairs), and the repair budget is reserved for genuine
breakage.

**iterate.md: four scenario pitfalls from the run's gate-repair rounds.**
Principal ids are `ulid()`-minted (the kernel Zod-validates the actor — a
readable `usr-admin-001` fails deep in the first `ctx.emit`); every checked
permission is granted to a role in the same edit; JOIN columns are qualified
from the start; and denial semantics — op-level `assertAllowed` throws, only a
portal proof-walk returns a filtered list — decide what the attacker step
asserts.

**The HTTP layer joins the oracle.** The scenario test bypasses server.ts, so
the model shipped an oracle-shaped stub: per-request `:memory:` host, hardcoded
tenant/scope, an unused cast loader, and `node:http` hand-wired to `app.fetch`.
scaffold.md now mandates the Callout shape — `routes.ts` exporting
`mountApi(app, resolveStub)` with one explicit route per operation, server.ts
as boot-only harness (host built once on `.data/`, cast loaded at boot,
`@hono/node-server`) — and iterate.md specifies `test/server.test.ts`: drive
the mounted app via `app.request()`, assert the 401/403 mapping and that a
second request sees the first one's write. The suite gate runs every test
file, so the smoke test is gate-enforced with no new gate machinery.

**The interview asks about screens, and knows when it's done.** No question
covered what each persona looks at, the concept template had no place to
record it, and scaffold.md only built `app/` "when the concept wants a UI" —
so silence propagated to no UI. New interview question 6 (screens per
persona), new concept section 8 (one line per persona; "API-only" valid but
explicit), and `app/` is built whenever the Screens section names one. A new
readiness rule stops the concept from being proposed while any checklist item
is open: anything the model would have to invent is its next question, with
the converse guard (never re-ask, never over-drill, 2–4 rounds typical).
