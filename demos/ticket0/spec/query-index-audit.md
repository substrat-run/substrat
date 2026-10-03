# Reaper and assistant-health index checkpoint (#1554)

This is a bounded audit of `reap-abandoned`, `assistant-health`, and existing
`list-conversations` coverage. The desk-wide inventory is the second part,
[migration 0023](#the-desk-wide-inventory-0023).
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

# The desk-wide inventory (0023)

The first pass indexed what it was asked about. This one asks the desk itself. The whole
ticket0 node suite (744 tests) ran with the driver's `prepare` recorded, and every statement
whose call site is in `demos/ticket0/src` (237 distinct) was EXPLAINed against a provisioned
current-version scope. The 61 that plan a `SCAN` of a ticket0 table or a temporary B-tree are
below, each with a verdict. A grep of `src` for probes the suite never runs found only
unique-index lookups.

The platform never runs `ANALYZE` (`packages/kernel/src/vertical-events.ts`), so the plan
without statistics is the production plan. Timings are a laptop's: node's, on a 30 000
conversation desk with 180 000 messages and 120 000 notifications, unless they say workerd.

## Indexed by 0023

| Read | Before | After |
| --- | --- | --- |
| `list-conversations` count (every inbox load), unfiltered or with `state`, `channel`, `priority`, `assignee` or `queue` | Seeks one single-column kernel index, then reads every row the desk (or that channel, priority or agent) ever had: 3–5 ms | Covering seek over the live rows on `ticket0_conversations_queue_filters`: 0.01–0.02 ms |
| `my-notifications`, both pages | Walks every notification in id order until 51 are the caller's. A person with few walks the table: 10 ms | `ticket0_notifications_by_principal` |
| Suspend (the spam filter's, at the door), discard, merge: a conversation's notifications | `SCAN ticket0_notifications`, 4–11 ms, once per conversation, so N times in a bulk discard | `ticket0_notifications_by_conversation` |
| `widget-session` (the rail), merge, discard: a conversation's sessions | Scan plus a sort | `ticket0_widget_sessions_by_conversation`, in the read's order |
| Discard, merge: a conversation's delivery records | `SCAN ticket0_mail_deliveries`, a row per mail ever | `ticket0_mail_deliveries_by_conversation` |
| Threading an inbound reply by `In-Reply-To` | `SCAN ticket0_messages`, the largest table: 12 ms per inbound reply | Partial `ticket0_messages_by_email_message_id`: 0.003 ms |
| `list-participants` (every conversation opened), discard, merge: followers | Full scan of the follow ledger's primary key | `ticket0_conversation_follows_by_conversation` |

`list-suspended` gets no index. The partial index 0021 built for it already exists, but the
planner picked the kernel's `quarantine` index and sorted the whole queue on every page. It is
pinned with `INDEXED BY` now.

The inbox count is one five-column index rather than one per filter combination. The kernel
derives one index per (filter, sort) pair and leaves combinations to a hand-written index
(`list-index.ts`). With the queue and the state set leading, every combined count is a covering
seek over the live rows. Two of them, priority and assignee, go back to their own kernel index
once statistics exist, which the platform never collects. The tests record that rather than
assert it away.

## Measured, and left alone

| Read | Why no index |
| --- | --- |
| `list-conversations` pages | Unmoved by 0023, and asserted unmoved: each keeps walking its kernel ordering index. Walked **ascending**, the default inbox passes every closed conversation before the first live one (~3 ms at 30 000). The operation declares `order: 'desc'`, but neither the route nor `ctx.page` applies that, so a caller that names no order gets ascending. No index shortens the walk, because the planner keeps the plan that needs no sort. That is a host/kernel defect, reported separately |
| `search-conversations`, `search-contacts` | An infix `LIKE` cannot use a B-tree. A rare term reads every conversation and its message text: 44 ms at 180 000 messages. The remedy is a `searchables` FTS index, a model change |
| Desk metrics (`desk-metrics`, `usage-summary`) | Whole-window aggregates. Half the statements sum over every row by design, at ~1.3 ms each at 30 000 |
| Signup confirm/unsubscribe by token | ~0.3–0.9 ms at 10 000 signups; one row written per signup |
| Per-conversation sorts: participants, a conversation's AI turns, a contact by address | Bounded by one conversation or one person |
| Small tables: block rules, agent profiles, behaviour runs, saved replies, KB sources, tag counts | Rows per desk, not per conversation |
| `wake-snoozed` sort, `list-pending-outbound` sort | Bounded by the snoozed set and the undelivered set |

## CHECKPOINT

Append-only migration **0023, `index-desk-reads`**, adds exactly these seven nonunique indexes:

```sql
CREATE INDEX ticket0_conversations_queue_filters
  ON ticket0_conversations (quarantine, state, channel, priority, assignee);
CREATE INDEX ticket0_notifications_by_principal ON ticket0_notifications (principal, id);
CREATE INDEX ticket0_notifications_by_conversation ON ticket0_notifications (conversation_id);
CREATE INDEX ticket0_widget_sessions_by_conversation ON ticket0_widget_sessions (conversation_id, started_at, id);
CREATE INDEX ticket0_mail_deliveries_by_conversation ON ticket0_mail_deliveries (conversation_id);
CREATE INDEX ticket0_messages_by_email_message_id ON ticket0_messages (email_message_id)
  WHERE email_message_id IS NOT NULL;
CREATE INDEX ticket0_conversation_follows_by_conversation ON ticket0_conversation_follows (conversation_id, principal);
```

**Write cost.** Each insert maintains one more B-tree on each table above, and two on
notifications. On workerd, inserting notifications (the most-written table here: one per
recipient per event) went from 4.0–4.5 to 6.0–6.5 µs a row over three runs, timing the 2 000
inserts alone. The probe requires every insert to land before its rollback. The conversation index holds no
`updated_at`, so the touch every message makes is not taxed. It is maintained on a change of
queue, state, priority or assignee. The message index is partial, so only a mail with a
Message-ID pays for it.

**Migration cost.** On workerd, 0023 over 30 000 conversations, 90 000 messages, 90 000
notifications, 30 000 delivery records, 15 000 sessions and 10 000 follows took 93–107 ms
over seven runs. It
runs inside the first request a desk serves after the deploy.

A code revert does **not** remove applied indexes. Reversal needs a new append-only
`DROP INDEX` migration naming them. Never rewrite 0023 or earlier.

## Verification

- `test/desk-read-shapes.ts` holds each read as literal SQL with the index its plan must name.
  `test/desk-fixture.ts` is the desk both suites populate, at 3 000 and 30 000 conversations.
- `test/desk-read-indexes.test.ts` does four things:
  - drives the handlers and fails if any shape is not a statement they sent;
  - upgrades a populated 0022 desk twice, and checks every row and read result is preserved;
  - checks each shape seeks its index, with and without statistics, and that dropping the
    index inside a rolled-back savepoint makes the identical assertion fail;
  - checks the inbox pages plan exactly as before, and that unpinning `list-suspended`
    brings its sort back.
- `test/workerd/sweeper.test.ts` runs the same shapes on a Durable Object after 0023 on the
  large desk, with the timing and write cost above.
