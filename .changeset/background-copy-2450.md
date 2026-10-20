---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
'@substrat-run/docs': patch
---

A preview whose data takes more than one page to copy now copies in the background, so `substrat preview create` no longer has to fit the whole copy into one request (#2450, step 2).

- **Lease renewal.** `HostAdmin.renewScopeScriptCopy` renews every entry of a copy move's lease at once, or none. It only acts while each entry is still pending, unclaimed and inside its lease, which is exactly what a confirming bind requires, so a lease a sweep could be acting on is never revived. Both adapters run the same `COPY_MOVE_RENEW_SQL`.
- **Resumable copy.** `transferScope` is now `beginTransfer` plus `transferStep` over a JSON `TransferState`, so a copy can stop and resume in another request or isolate. The in-request path runs the same steps to the end, unchanged.
- **The job.** `advanceCopyJob` is one step of a background copy:
  - it renews the lease;
  - it moves pages for a bounded time;
  - a refusal fails the job, a transient fault backs off and retries, and a job past six hours fails;
  - the step, and the wait before a retry, each stay inside a quarter of the move's lease.

  `defineCopyJobDO` (adapter-cloudflare) runs those steps one per alarm, keeps a finished job for the route to read, and lets a cancel, a forget, or a forget and a new start that lands during a step win. Its `claim` hands a done job to one caller at a time. `memoryCopyJobs` is the same, in memory, for tests.
- **The preview route.** With the new `copyJobs` option and a caller that sends `async: true`, `POST /verticals/:slug/previews` copies the first page in the request.
  - A fork or carry that needs more answers `202` with its progress and `Retry-After`, and the same call, repeated, finishes the preview once the job is done. Only the call that claims the done job finishes it; another call answers `202` meanwhile.
  - A refresh, a delete or a newer push stops a job still copying and settles its move. A newer push waits for a claimed job to be finished.
  - A caller that does not send `async` is answered as before. While a job copies, that caller gets a `409` saying the copy is in progress.
- **The CLI.** `substrat preview create` sends `async: true`, prints the copy's progress while it waits (up to six hours), and sends `--refresh` on its first call only.

The hosted control plane binds the job object as `COPY_JOBS` (class `ScopeCopyJobDO`, wrangler migration `v4`). A rebind or adopt of a live scope still copies in its request.
