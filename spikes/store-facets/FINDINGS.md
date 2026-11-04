# Findings

## Local workerd (2026-11-04)

`node run-local.mjs` ran on workerd 1.20260730.1 through Miniflare 4.20260730.0, on macOS arm64.
All 23 checks passed.

- **Loader binding.** A script with a SQLite-backed Durable Object and a `worker_loaders` binding
  starts. The binding is present.
- **Isolates.** JavaScript and Python behave the same:
  - two calls to one object, under one loader id, reach the same isolate;
  - two objects with ids of their own reach two isolates;
  - the control, two objects sharing one id, reach one.

  The loader id decides the isolate here.
- **Network.** With `globalOutbound: null`, `fetch()` and `connect()` throw in both runtimes. The
  error is "This worker is not permitted to access the internet via global functions like fetch().
  It must use capabilities (such as bindings in 'env') to talk to the outside world." The control,
  with the network inherited, reached `example.com`.
- **Env.**
  - The driver's env is empty in both runtimes.
  - A JavaScript facet *has* a `ctx.exports`, unlike the store entry's driver under
    `disable_ctx_exports` today. It names only the loaded worker's own export (`ProbeDriver`) and
    nothing of the supervisor's.
  - D-70's build should still decide whether to pass `disable_ctx_exports` in the loaded code's
    flags.
- **Storage.**
  - The facet sees its own table and not the supervisor's. The supervisor sees its own and not the
    facet's.
  - After `ctx.facets.abort`, the next call under a new loader id (new code, `v2`) runs over the
    same facet storage, with its row kept.
- **Cold start (Python probe, not the graph release).** About 1.0–1.1 s for the first call to a fresh
  object, which loads its isolate, and about 1 ms warm. The Python heap of that isolate was 24 MiB
  (25 165 824 bytes).

## What this does not show

The answers that decide D-70 come from [RUNBOOK.md](RUNBOOK.md) on a real dispatch namespace. This
run cannot show any of them:

- whether a dispatch-namespace script may bind a Worker Loader;
- how isolates are placed on the edge rather than on one local process;
- the graph release's cold start and memory;
- what is billed.

The first JavaScript call does not mark a cold start in the same way, because a JavaScript isolate
starts in milliseconds.

## Deployed

_Not yet run._ The person running the runbook pastes the blocks here and fills D-70's **Measured**
table from them.
