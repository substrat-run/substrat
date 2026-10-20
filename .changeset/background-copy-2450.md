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
- **Resumable copy.** `transferScope` is now `beginTransfer` plus `transferStep` over a JSON `TransferState`, so a copy can stop and resume in another request or isolate. The in-request path runs the same steps to the end, unchanged. Each paged call (`exportScopePage`, `stageScopePage`, `discardStagedScope`) runs under a 60 s deadline (`PAGE_CALL_DEADLINE_MS`), and one that stalls is aborted and answered `504`.
- **The job.** `advanceCopyJob` is one step of a background copy:
  - it renews the lease;
  - it moves pages for a bounded time;
  - a refusal fails the job, a transient fault backs off and retries, and a job past six hours fails (one whose steps were lost is failed so by the next call that reads it, `copyJobAt`);
  - a job that fails discards its stage, and its record keeps naming it;
  - a copy torn part way is staged again, even when it now fits one page;
  - the step, and the wait before a retry, each stay inside a quarter of the move's lease.

  `defineCopyJobDO` (adapter-cloudflare) runs those steps one per alarm and keeps a finished job for the route to read. A cancel or forget that lands during a step stops it (`CopyJobStep.stopped`: no further page, no new stage) and waits for it before it acts. Its `claim` hands a done job to one caller at a time, and `threwRetryMs` sets the wait after a step that threw. An object of the class under another name keeps a mark instead (`markNewest`: the newest order it was given while held, dropped by alarm once its hold runs out). `memoryCopyJobs` is the same, in memory, for tests.
- **The preview route.** With the new `copyJobs` option and a caller that sends `async: true`, `POST /verticals/:slug/previews` copies the first page in the request.
  - A fork or carry that needs more answers `202` with its progress and `Retry-After`, and the same call, repeated, finishes the preview once the job is done. Only the call that claims the done job finishes it; another call answers `202` meanwhile. The preview's deadline (`ttlHours`) counts from the latest call, as every create's does: the calls during a copy keep it alive, and the finish applies it again. A carry's finish keeps the job until its bind is over, and a finish that fails, however it fails, settles the job's move and discards the stage it would have loaded. A fork, like a carry, refuses (`412`) a source that was carried to another script and wiped while it was read.
  - A refresh, a delete or a newer push stops a job still copying and settles its move. A newer push waits for a claimed job to be finished. A refresh is held to the same rule as any create: it never stops a newer push's live copy.
  - A call that follows a `202` naming its own version sends `poll: true`. A poll continues that copy and never starts one: it answers `202` while the copy runs, finishes it once it is done, answers the preview again if it already serves the poll's version, and otherwise refuses with `409` (the copy failed, a newer push or a refresh replaced it, or the preview was deleted). Only a new create starts a copy over.
  - Of two pushes to one preview, the newer is the one the registry recorded later, whatever its id. A create for an older version is refused (`409`, superseded) while a newer push's job is copying or being finished, and for 15 minutes after that push's last call, a poll included (`CopyJobs.markNewest`, kept per preview tag), so an older push never reaps or forks while a newer one replaces its copy. A newer push's job that failed, was cancelled or was left unfinished past its lease holds nothing off. After that, an older version is taken like any other create.
  - A copy's failure is answered with the status a refusal had, and with `409` naming the fault when the copy met a 5xx (its deadline, an end it could not reach, a load or a bind that failed while the job was finished): never a status a client retries as a gateway's. The fault still lands an ops-failure row.
  - A caller that does not send `async` is answered as before. While a job copies, that caller gets a `409` saying the copy is in progress.
- **The CLI.** `substrat preview create` sends `async: true`, prints the copy's progress while it waits (up to six hours), and sends `--refresh` on its first call only. It sends `poll: true` after a `202` naming its own version. A poll that fails as a gateway or the network fails, or with a `500` that names no reason (the platform's generic internal error, Cloudflare's redacted fault), is polled again, up to ten in a row; a refusal ends the wait with its reason.

The hosted control plane binds the job object as `COPY_JOBS` (class `ScopeCopyJobDO`, wrangler migration `v4`). A rebind or adopt of a live scope still copies in its request.
