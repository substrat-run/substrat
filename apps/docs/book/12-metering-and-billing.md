---
description: "A vertical metering and invoicing its own customers, and the platform metering a tenant: what is counted, what is priced, and what (like storage) is not counted yet."
---

# 12. Metering and billing

Two different subjects share these words, and mixing them up leads to wrong designs in both
directions:

- **A vertical billing *its* customers.** A support desk charging for AI answers, or a
  field-service firm invoicing hours and parts. That is domain logic, so it belongs in
  engines and verticals.
- **The platform billing a *tenant* for using Substrat.** Apps installed, engines licensed,
  models called, storage held. That is platform logic, so it belongs in the control plane.

They share one principle, and it is the thread through this chapter: **count exactly, price
separately, and never let a price change a count.**

## Part one: a vertical meters its own customers

### Quantities, not prices

The metering engine records *how much*. It has no currency, no rate, no plan, and no idea
what anything costs. That line is drawn deliberately. One customer rounds differently, another
offers a volume discount, a third changes price mid-month. None of those decisions can be
wrong for *every* vertical, so by chapter 7's test none of them belongs in an engine. What
would be wrong for every vertical is losing a unit or counting one twice, so that is what the
engine owns.

A **meter** has a key, a unit, and a kind:

- a **counter** sums what is recorded (tokens used, messages sent);
- a **gauge** records a level and takes the maximum within a window, carrying the last level
  forward into windows where nothing was recorded (seats, stored documents).

A meter's kind and unit are **frozen** once set. A counter that later became a gauge would
reinterpret every entry already written.

### Recording, and the invariants that make it safe

```ts
// inside the vertical's own operation, in the same transaction as the work
recordUsage(ctx, {
  meter: 'ai.tokens.output',
  qty: String(outputTokens),
  subject: { entityType: 'conversation', entityId: conversationId },
  dedupeKey: `${turnId}:out`,
});
```

The engine is composed **by call** (chapter 7), and that choice matters here more than
anywhere. The usage entry commits in the same transaction as the work it measures. There is
no gap in which an answer was delivered and its tokens were not recorded, or the tokens were
recorded for an answer that rolled back.

What the engine refuses:

- **A replay with the same dedupe key** returns the original entry, marked as deduplicated,
  and emits nothing. **The same key with a different quantity** throws. That is not a
  replay but two different claims about one event, and one of them is wrong.
- **An entry dated inside a closed period** throws. Once a period is closed, its numbers
  cannot change underneath an invoice built from them.
- **An entry dated more than five minutes in the future** throws. The close horizon only moves
  forward, so an entry dated past a close that has not happened yet could end up counted by no
  period at all.
- **A negative gauge**, or an entry against an inactive meter, throws.

### Closing a period

`closePeriod` totals every meter over a window and freezes the result as **period lines**.
Closes are monotonic: a new period may not overlap one already closed. It emits
`metering.period-closed` with the lines in the payload, fat as chapter 5 requires, so a
consumer never has to read back. **Nothing schedules a close.** When a period ends is a business
decision (calendar month, contract anniversary, on demand), so it belongs to the vertical.

### Where the price comes in

The vertical holds the rate card, in its own table, with its own permission. The support-desk
reference vertical stores rates per meter with an effective date, and prices usage for display
by joining each entry to the rate in force when it was recorded. A rate change next month does
not reprice last month.

### Handing it to invoicing

Invoicing is the other half, and it is composed **by event**. A vertical or engine emits a
billable event, and the invoicing engine consumes it into the customer's single open **billing
basis**: the set of lines a real invoice will be issued from. Today it consumes three events:
a completed work order, a placed commerce order paid by invoice, and a closed timesheet period.

Each line copies its price from the event payload at write time, so last month's work is never
billed at today's price. A basis holds one currency, checked on every write. Once exported it is
**immutable**, which is why invoicing has no in-scope exports (chapter 5): nothing may call in
halfway through and change a basis the accounts already hold.

Two gaps are worth stating plainly:

- **Metering does not feed invoicing yet.** Invoicing does not consume `metering.period-closed`.
  The intended shape is for the vertical to price the closed lines with its own rate card and
  emit them as a billable event. On the invoicing side that is an additive new consumed event,
  designed and not built.
- **Nothing consumes the export event.** No accounting connector takes an exported basis today.
  The one accounting connector that exists reads bookkeeping *from* the ledger and has no write
  path.

## Part two: the platform meters a tenant

### Meter, don't bill

The platform's rule is **count everything exactly, store no bill**. Usage is recorded as
facts. Prices and margins are applied when someone reads, and nothing stores a computed
charge. So a pricing change never requires a data migration, and a count is never tangled
with a number that was a commercial decision.

The commercial design names four meters. Here is the state of each:

| Meter | Counts | State |
|---|---|---|
| **1. Base fee** | active tenants and active scopes | counted, live |
| **2. Engine licensing** | entitlements, grouped by key and plan, with expired ones counted apart | counted, live |
| **3. Usage** | platform-provided model calls, with tokens and list price | **counted**, and priced when read |
| | event history retained | measurable in the lake, and nothing reads it yet |
| | storage, API calls | **not counted** |
| **4. Network transactions** | orders flowing between tenants | not countable, because that flow does not exist |

Meters 1 and 2 are folds over the directory, computed on read and never stored. Operators see
them, and model usage, in the console's **Meters** view, with a per-tenant card on each tenant.

### Entitlements: the licence, not the enforcement

An entitlement is a row naming a tenant and a key, optionally with a plan, a quota and an
expiry. The kernel enforces **presence and expiry**: a module whose key the tenant does not
hold is not registered, so its operations do not resolve (chapter 3). `plan` and `quota` are
**expression only**. A module can read them through `ctx.entitlement(key)` and act on them,
but **nothing in the platform enforces a quota**.

### Model usage, end to end

Platform-provided models are the one part of usage that is complete from call to price:

1. A vertical calls a model through the **model host**. That happens *around* an operation, never
   inside one, because a model call is a multi-second network round trip (chapter 4).
2. The host resolves the provider with platform-held credentials, makes the call, and builds a
   **usage line**: token counts, the list price computed on the platform's side from a generated
   rate card, and five attribution keys (tenant, scope, vertical, version, operation).
3. The vertical records that line through its own operation, which raises it as a platform
   intent, atomically with whatever the answer changed.
4. The platform drain checks that the line's tenant, scope and vertical match the scope it was
   drained from, so a vertical cannot bill a model call to someone else, and writes it to the
   directory. The write is idempotent on the request id and kept for 400 days.
5. When staff read the summary, a margin is applied, 20% unless configured otherwise. Nothing
   stores the result.

Two numbers exist, and both are correct. The platform's list price plus margin is what the
platform charges the tenant. The vertical's own rate card is what the tenant charges *its*
customers. Reconciling them is the tenant's business.

One known hole: a vertical that holds the models binding can call it directly, outside the
model host, and that call is not metered.

### Storage: the honest answer

**Nothing measures storage used by a scope or a tenant today.**

Here is what exists nearby, and why none of it is the answer:

- The Durable Object SQL API reports a database's size. Nothing collects it. Reading it means
  waking each scope, and no sweep phase does that yet.
- Attachment rows record their own byte size. Nothing sums them, and attachment bytes live in a
  blob store rather than in the scope.
- **The lake's `bytes` column** (chapter 11) records every event's serialized size as shipped.
  Summed per tenant after dedupe, it is exact, and it is the only per-tenant volume measure the
  platform has. But it measures **event history volume**, not database size. It excludes a
  scope's current rows, its indexes, its attachments, and every row an update overwrote. It is a
  defensible basis for billing history retention, and it is not a storage meter.

So a storage line on an invoice needs one of two things built: a sweep phase that collects each
scope's database size into the directory next to the other meters, or a decision that
event-history bytes are the unit being sold.

### Requests are not billable either

The router's per-request datapoints (chapter 10) are sampled. They are good enough to draw a
chart and not good enough to put on an invoice. And a read emits no event, so the spine cannot
count API calls either. That is why "API calls" sits uncounted next to storage.

### What a tenant sees

The dashboard has a **Billing** page, and today it is a placeholder, marked as not yet enabled.
No payment provider is integrated, no invoice is generated, and nothing takes payment. The
platform counts, and the operator bills from those counts outside the product.

## The shape, once more

In both halves the count is exact, deduplicated, and written in the same transaction or intent
as the thing it counts. The price is applied later, by whoever owns the commercial decision:
the vertical for its customers, the platform for its tenants. What is missing is also the same
in both halves: the hand-off from a closed count to a document someone pays.

---

**Next:** [Operating it →](/book/13-operating-it)
