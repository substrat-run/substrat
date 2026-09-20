---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A restore on the hosted store rebuilds the tables the dump did not carry

A restore replays only what its dump holds and then re-asserts the kernel spine, so a
module's own tables are dropped and not rebuilt by the restore itself — a dump captured
from a world that keeps part of the spine elsewhere, or a targeted repair supplying only
the tables being fixed, legitimately carries fewer tables than the scope has. Both stores
lean on the next migration pass to recreate them, and only one of them actually ran it.

The self-hosted store re-reads which migrations have been applied on every pass, so it
re-applied and the tables came back. The hosted store memoises the pass per live instance,
and nothing on the restore path cleared that memo: a scope still in memory went on
answering "migrations are done" over tables that had just been dropped. The next operation
touching one failed with a bare `no such table`, and kept failing until the scope was
evicted or a sweep forced a fresh attempt — neither of which a restore triggers, and
neither of which an operator would think to do, because the restore reported success.

A restore now forgets the memoised pass, exactly as the sweep's retry does, so the next
call re-runs it and rebuilds whatever the dump omitted. A dump that did carry its tables
re-applies nothing: the migration journal it brought is what the pass reads, and an
already-journaled version is skipped.

Nothing about what a restore writes changes — the same dump lands the same way — and
the self-hosted store is untouched, having never had this problem. The shared suite both
stores must pass now pins the agreement: restore a dump that omits a module's tables, and
the module works afterwards.
