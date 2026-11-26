---
id: K-73
date: 2026-11-26
layer: kernel
title: "The platform's own bookkeeping reads are recorded as one access-log row per pass"
status: accepted
aliases: []
amends: ["K-24"]
tracking: ["#3326"]
---

# K-73 — The platform's own bookkeeping reads are recorded as one access-log row per pass

**The reads the platform makes for its own bookkeeping, as its sweep actor during a scheduled pass, are recorded as ONE access-log row for the pass, not one row per read.** The row names the sweep actor, the method `summarizedReads`, no tenant or scope, and in its parameters the pass's window, the count of reads per method, and how many distinct tenants and scopes they named; its result count is the total across them. A host folds a read into the summary only for the actor the summary was opened for (`HostAdmin.summarizeAccess`, `flushAccessSummary`), so a person's read, a delegated read and a read in the same isolate by anyone else are recorded exactly as K-24 says. A summary nests, and its row is written when the outermost closes, however the pass ends. This amends K-24's **"All reads, not a curated subset"** for that one actor: the fact that platform code read tenant records, and how widely, stays on the record; which record, read by read, does not.

This is the exception [K-70 (tenants × time data leaves the objects)](./K-070-data-that-grows-with-tenants-times-time-leaves-the-sqlite-objects-each-object-keeps-a-bounded-recent-window.md) left to the owner, taken in its middle form: not "write no row" for the platform's reads, but one row a pass.

## Why

**K-24 is about who looked at tenant data, and the access log had become the platform looking at itself.** The scheduled pass reads the directory through the audited seam about 720 times a pass on the hosted fleet: scope records (57%), tenants (17%), undrained events (15%), versions (3%) (#3326, measured 2026-11-10). That was about 95% of the log's inflow, at about seven directory row writes per access row (the insert and two indexes, the drain stamp, the delete), roughly 0.4 M rows written a day, and it made capturing the access log into the lake (K-70) cost about 140K more a day.

**One row a pass keeps what an auditor needs from those reads.** The question an incident asks of the platform's own reads is whether automated code touched tenant records, when, and how broadly — answerable from the counts and the window. A per-read row for a scope record the pass reads every fifteen minutes answers nothing more, and buried the reads people made among it. Writing no row at all (K-70's first form) would have made a misused sweep actor invisible in the log; this keeps it visible at about 1/700th of the cost.

**Scoped to the actor, not to the code path.** The summary is opened for an actor by the code that owns the pass, and only that actor's reads are folded in, so nothing about a person's read changes and no caller can quietly summarize someone else's.

## Not covered

Reads the control plane makes as the sweep actor outside a scheduled pass (the `/internal` drain and reconcile kicks) are still one row each: they are request-scoped and few.
