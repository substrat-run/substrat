---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

Sweep passes leave a durable record (#1232, tier 1 of the signals plan). A new
directory table, `_substrat_sweep_runs`, holds one row per unit outcome per
pass — each connection swept, failed, or skipped ("bound but no sweeper" is now
a stored fact, not an absence), and each schedule fired, failed, or skipped —
dimension-stamped per #1231 and retention-bounded at 14 days, pruned on write.
`ScheduleRunReport` gains an additive `runs` list (both adapters' drivers fill
it) because the counters alone cannot say WHICH schedule fired.
`HostAdmin.recordSweepRun`/`listSweepRuns` follow the ops-failures shape:
fire-and-forget writes, access-logged reads, ULID cursor, newest-first.
`runPlatformSweep` takes an optional `recordSweepRun` seam; unset, a pass
records nothing, exactly as before.

Stated plainly rather than left as a silent hole: schedule rows cover
directory-backed sweeps (self-host, dev). A HOSTED vertical's schedules run in
its own scope sweeper with no control plane in reach, so its schedule facts are
not in this table yet — that is the deferred CP-less half of #1232, and until it
lands the dashboard view reads connector health fleet-wide but schedule health
only where the platform sweep itself runs the schedules.
