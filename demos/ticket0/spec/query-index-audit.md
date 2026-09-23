# Reaper and assistant-health index checkpoint (#1554)

This is a bounded audit of `reap-abandoned`, `assistant-health`, and existing
`list-conversations` coverage. It is not the broader desk-wide read/search inventory.
Measured with better-sqlite3 on an adapter-provisioned scope, including the kernel's
list indexes and ticket0 migrations 0001–0014. The regression fixture has 2,000
conversations and 20,000 turns, with public replies, contact replies, and internal
notes. The health window includes 2,000 turns; 500 drafts remain waiting.
The same production SQL is imported by the handler and the planner tests.

## Measured verdict

| Read | Before 0015 | After 0015 |
| --- | --- | --- |
| Reaper conversation candidates | Kernel `conversation_state_updated_at` seek on `state=? AND updated_at<?`; no sort | Same existing seek; no new conversation index |
| Reaper drafted-turn exclusion | `ticket0_ai_turns_by_conversation` seek on `conversation_id=?`, then outcome filter | Covering `ticket0_ai_turns_conversation_outcome` seek on both equality keys |
| Health window counts | `SCAN ticket0_ai_turns` | Covering `ticket0_ai_turns_created_outcome` seek on `created_at>?` |
| Recent failures | `SCAN t` and temporary ORDER BY tree | `ticket0_ai_turns_outcome_created` outcome seek in requested order |
| Waiting drafts / count | `SCAN t`; page also needs temporary ORDER BY tree | `ticket0_ai_turns_outcome_created` outcome seek; no page sort |
| Waiting draft's public desk reply | Kernel message `visibility_created_at` seek on visibility/time, filtering conversation afterwards | Partial `ticket0_messages_desk_reply` seek on `conversation_id=? AND created_at>?` |

These new seeks hold both without statistics and after `ANALYZE` in the fixture.
The message result is why the already-shipped public-message index alone is not
sufficient here: its final key is `id`, not `created_at`. Keep that existing index;
round-robin's separate lookup uses its order. The health count still reads every
turn in its time window, and waitingTotal still evaluates all drafted candidates.
An index does not make those exact aggregates constant-time.

Kernel list coverage already exists for all three conversation sorts (`updated_at`,
`created_at`, `priority`) and five filters (`state`, `assignee`, `channel`, `priority`,
`contact_id`). All fifteen single-filter/sort combinations use existing indexes
without a temporary sort in the provisioned fixture. The unfiltered updated-time
walk also uses its existing ordering index. The default inbox is different: its
four-state `IN` filter uses a state index plus temporary sort without statistics;
after `ANALYZE`, this fixture chooses the existing ordered updated-time walk.
This is a statistics/distribution-dependent plan, not a missing index declaration.
No new list index or general kernel change is proposed. Combined filters, search,
and the broader desk inventory remain separate measurement work.

## CHECKPOINT

Append-only migration **0015, `index-reaper-and-assistant-health`** adds exactly:

```sql
CREATE INDEX ticket0_ai_turns_conversation_outcome
  ON ticket0_ai_turns (conversation_id, outcome);
CREATE INDEX ticket0_ai_turns_created_outcome
  ON ticket0_ai_turns (created_at, outcome);
CREATE INDEX ticket0_ai_turns_outcome_created
  ON ticket0_ai_turns (outcome, created_at, id);
CREATE INDEX ticket0_messages_desk_reply
  ON ticket0_messages (conversation_id, created_at)
  WHERE visibility = 'public' AND author_kind != 'contact';
```

All four indexes are nonunique. Existing rows are indexed during migration: this
costs build time and storage, and writes subsequently maintain three additional
B-trees per AI turn and one per qualifying public desk message. Changes to indexed
keys or partial-index membership also maintain those trees. Production latency,
storage bytes, and rollout duration are unmeasured; query-plan improvements are
not a production benchmark.

A code revert does **not** remove applied indexes. Reversal requires a **new
append-only DROP INDEX migration** naming these four indexes; never rewrite 0015
or earlier journal history. The journal is the reviewed SQL source, and the existing
emitter renders `src/migrations.generated.ts`. No model/emitter extension is needed.
Human migration-diff approval is required before merge.

## Verification and choice

The regression suite provisions the real pre-0015 module, populates it, then
re-provisions with the current module twice. Every populated contact, conversation,
turn, and message row and every selected query result is preserved. Nonempty
expected counts pin both included and excluded fixture rows. For each new index,
the suite drops that index inside a rolled-back savepoint and proves the identical
positive planner assertion fails, with and without statistics.

**FORK CHOSEN:** these four measured gaps, with unchanged predicates and behavior.
The candidate partial reaper conversation index was rejected because the existing
kernel index already supplies its state/time range and order. A speculative
whole-desk index sweep was rejected because it adds write/storage cost without
measured benefit. Existing 0011 round-robin and 0012/0014 SLA indexes remain intact.
No published-package changeset: ticket0 is private. Part of #1554; leave it open.
