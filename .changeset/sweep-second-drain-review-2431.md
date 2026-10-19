---
"@substrat-run/kernel": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/control-plane": patch
---

Fixes to the same-pass second drain (#2431):

- **No intent is tried twice in one pass.** `drainPlatformRequestsFn` now takes options. The sweep always passes them, and on the second drain of a scope it passes `skip`: the ids the first drain reported as `attempted`. `drainScopePlatformRequests` takes the same two as options. It leaves skipped intents alone, so they are neither run nor settled, and it fills `attempted` with the ids it dispatches. Before, an intent a first drain left pending was tried again by the second drain, spending two of its 100 attempts in one pass.
- **Totals count each intent once.** A second drain now reports only new intents, so its `drained`, `done`, `failed` and `pending` add to the first drain's. Only `unsettleable`, which every listing reports in full, is replaced.
- **`unreachable` again counts scopes no drain reached.** A second drain that reached no deployment changes no count. It lands in `errors`, saying that what the schedules enqueued waits for the next pass. `tallyPlatformDrain` is the one place a drain's answer is read, and it filters the per-scope unsettleable list only for a second drain.
- **Purge-horizon runs report their requests.** On Cloudflare, they report the deliveries their events route to the platform, as an invoke's tail does. On the node host, they report what each purge enqueued.
- **The supplied scope sweeper is quiet on routine passes.** It again logs only a pass that failed. A pass whose schedules merely enqueued platform requests is routine, and its count stays in the pass report.
