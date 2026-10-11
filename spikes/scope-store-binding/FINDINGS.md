# Findings: a scope store reached across scripts

Run locally on Windows, 12 October 2026. `node run.mjs` (miniflare 4.20260730.0, workerd)
passed 21 assertions. `node python/probe.mjs` (`uv run pywrangler dev`, Python 3.12.10,
workers-py 1.17.7) passed 4. Neither run used a Cloudflare account or a dispatch namespace.

## What ran

`src/store.mjs` exports `CounterStore`, a Durable Object with SQLite. Callers address it
with `idFromName("<tenant>/<vertical>/<scope>/<binding>")` through a
`durable_object_namespace` binding whose `scriptName` is another worker. The body is
`{ operation, input }`. The response is `{ result }` or `{ error: { code, status, body } }`.

## Shown

1. **The cross-script binding reaches the object.** `vertical-a` holds no `CounterStore`
   class. Its binding names `store-a`. An `increment` returned `{ result: { count: 1 } }`,
   and the next `read` of the same name returned the same count.
2. **The envelope distinguishes a result from an error.** `op=nope` came back
   `404 { error: { code: "not_found" } }` with no `result`.
3. **Two scopes do not share an object.** After incrementing `…/scope-1/GRAPH`,
   `…/scope-2/GRAPH` on the same script read `0`.
4. **A shared script does not isolate verticals.** `leaky` and `vertical-b-shared` both
   bind `shared-store`. `leaky` incremented the name `tenant-1/vertical-b/scope-1/GRAPH`.
   `vertical-b-shared` then read `1` for that same name. The name is chosen by whoever
   holds the binding. Nothing in the platform checked that the name's vertical is the
   caller.
5. **One script per vertical does isolate them.** The same name, incremented through
   `vertical-a` (bound to `store-a`), read `0` through `vertical-b` (bound to `store-b`).
   `idFromName` is per script. This is the countermeasure that needs no shared secret.
6. **A signature over the addressed name refuses a caller who does not hold the key.**
   `signed-store` checks `HMAC-SHA256(key, x-store-name)` and is bound to `platform`
   (has the key) and `leaky-signed` (does not). `leaky-signed` got
   `403 { error.body.reason: "signature" }`. A valid signature for one name, replayed
   against another name, got the same refusal. `platform` incremented and was admitted.
   The object cannot read its own `idFromName`, so the signed string is a header the
   caller sets. A caller who holds the key can sign any name. The key has to live in
   platform code, not in the vertical.
7. **Reserved operations.** `vertical-a` (`REFUSE_RESERVED=1`) got `403 reason: "reserved"`
   for `substrat.size`, and the counter did not move. `platform` (the flag unset) called
   `substrat.size` (a positive `databaseSize`), `substrat.export` (the counter row),
   `substrat.wipe` (the next read was `0`) and, on the namespace directly,
   `substrat.import` (the counter became `7`).
8. **Eviction.** After `dispose()` and a new miniflare on the same `durableObjectsPersist`
   directory, the incremented object read `1` and the wiped object read `0`. The class
   has no module-level state; both facts came back from SQLite.
9. **Python.** The same envelope on a Python Durable Object, class `CounterStore`,
   `new_sqlite_classes`, answered `increment`, `read`, a second scope at `0`, and
   `substrat.size` via `ctx.storage.sql.databaseSize`. This was one script binding its
   own class, not a cross-script binding. `uv sync` on Python 3.15 failed: `pyjson5`
   2.0.1 has no wheel there and needs MSVC to build. Python 3.12 has the wheel.

## Not shown

- A real Workers for Platforms dispatch namespace. Local miniflare accepts `scriptName`
  between workers it was given. Whether a user-worker upload may bind a Durable Object
  namespace whose `script_name` and `dispatch_namespace` point at a platform script is a
  question for an account that has Workers for Platforms. The upload API documents the
  fields (`script_name`, `dispatch_namespace` on a `durable_object_namespace` binding).
  This run does not show that a dispatch upload accepts them, or what a user worker can
  then do with the binding.
- Isolate sharing. One platform script per kind would let objects of different tenants
  and verticals share a 128 MB isolate. Not exercised.
- Jurisdiction, metering, snapshot and reap. The reserved operations answered; nothing
  here calls them from the scope lifecycle.
