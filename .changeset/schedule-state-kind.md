---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The platform sweep's gating state now records which KIND of unit each row is about, so a recurring schedule and a freshness expectation can no longer end up sharing one row.

The sweep keeps two kinds of bookkeeping per app: when each recurring operation last ran, and when each freshness expectation's verdict was last recorded. Both lived in one table, told apart only by the spelling of their key — a freshness row's key began with `freshness:`. Nothing enforced the other half of that: an operation name is any non-empty string, so an app declaring a schedule literally named `freshness:orders.placed` wrote into the row the freshness evaluator was using for `orders.placed`. The two then overwrote each other every pass — the schedule read the evaluator's last verdict as its own last run and skipped when it was due, and the freshness view reported a verdict that came from a schedule.

The row now says which it is, in a column, using the same two words — `schedule` and `freshness` — that the recorded sweep history already uses. Both are part of the key, so the two families cannot meet however they are named, and the writer states which kind it is writing rather than the reader guessing from the key.

Rows already recorded are migrated in place on the store's next wake, on both the self-hosted and the hosted store: each keeps its key and its recorded time and verdict exactly, and is filed under the kind its key already implied. Nothing is re-run and nothing is re-judged by the migration — a schedule does not fire early because of it, and a freshness verdict is not recomputed.

No application code changes to adopt it. The gating state is platform-owned and nothing user-facing reads it directly.
