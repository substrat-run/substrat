---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

Two `runDueJobs` calls on one scope at once no longer run the same job run's handler twice. A drive now claims each due run before its pass. The claim is one conditional write that holds only while the run is still due, and only its winner can go on. It then BEGINS the pass with a second conditional write, which holds while the claim still owns the lease with more than a quarter of it left. The drive invokes the handler if, and only if, that write succeeded. Every lease time is the store's clock as its statement runs, so a clock skew between the coordinator and the store moves no lease. The drive judges its own wait on its own monotonic clock.

The pass holds a lease, which every step boundary renews. A run whose pass stops reporting is due again when its lease expires, and the next drive takes it over. If that pass had begun, the takeover counts it as a failed attempt, so a pass that keeps dying ends the run `failed` instead of retrying forever. A claim that never began costs nothing. Writes from a pass that lost its lease are refused: its step records, its outcome, and its commit, which no longer drops the new holder's step ledger. A pass that finds its lease gone at a step boundary stops there.

A claim that does not begin in time starts nothing and costs no attempt. It releases the run after a backoff that doubles per consecutive miss, and the drive reports a warning naming the job, its lease and the delay it saw. After `JOB_ADMISSION_MISS_MAX` (10) misses in a row, the run fails with `JOB_LEASE_TOO_SHORT_NOTE` instead of being claimed forever.

`registerJob` takes an optional `{ leaseMs }`: how long a pass can go between two steps (default `JOB_LEASE_MS`, fifteen minutes; at least `JOB_LEASE_MIN_MS`, 100 ms). Two stretches are at-least-once by construction: a pass that outlasts its lease between two steps, and a BEGIN whose reply takes longer than a quarter of the lease. Either can let another drive take the run over while the first still runs. Size `leaseMs` to the longest gap between your steps. `JobDriveReport` gains `superseded`, the passes whose outcome was refused because the run was no longer theirs. `JobRun` gains `leaseOwner`, and while a pass holds a run, its `nextAttemptAt` is when the lease expires. `JobDriveReport` gains `warnings`, and `JobRun` gains `admissionMisses`. `_substrat_job_runs` gains three nullable columns, `lease_owner`, `lease_began_at` and `admission_misses`, added on the next wake of an existing scope.

On Cloudflare, a scope object running this version no longer hands a run to a coordinator from before leases, which would run it without claiming. During a deploy's overlap an old coordinator drives nothing, and the new one drives every run.
