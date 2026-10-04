---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

Two `runDueJobs` calls on one scope at once no longer run the same job run's handler twice. A drive now claims each due run before its pass. The claim is one conditional write that holds only while the run is still due, and only its winner invokes the handler. The pass holds a lease, which every step boundary renews. A run whose pass stops reporting is due again when its lease expires. The next drive then takes it over and counts the silent pass as a failed attempt, so a pass that keeps dying ends the run `failed` instead of retrying forever. Writes from a pass that lost its lease are refused: its step records, its outcome, and its commit, which no longer drops the new holder's step ledger. A pass that finds its lease gone at a step boundary stops there. A claim whose answer comes back with less than a quarter of its lease left starts no pass and releases the run.

`registerJob` takes an optional `{ leaseMs }`: how long a pass can go between two steps (default `JOB_LEASE_MS`, fifteen minutes; at least `JOB_LEASE_MIN_MS`, 100 ms). A pass that outlasts its lease between two steps can be taken over while it still runs, so that stretch is at-least-once: size `leaseMs` to the longest gap between your steps. `JobDriveReport` gains `superseded`, the passes whose outcome was refused because the run was no longer theirs. `JobRun` gains `leaseOwner`, and while a pass holds a run, its `nextAttemptAt` is when the lease expires. `_substrat_job_runs` gains a nullable `lease_owner` column, added on the next wake of an existing scope.

On Cloudflare, a scope object running this version no longer hands a run to a coordinator from before leases, which would run it without claiming. During a deploy's overlap an old coordinator drives nothing, and the new one drives every run.
