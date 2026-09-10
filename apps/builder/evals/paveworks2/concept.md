# Paveworks II — paving jobs to invoices

Status: **frozen eval fixture** (builder-studio.md §9.6). Approved as-is; every decision
below is final. Where this document is silent, follow platform defaults and record the
assumption — do not ask.

Supersedes the `paveworks` fixture (#723): same domain, same shape, but the three places
the older concept could not be satisfied as written — material with no price source, a
required per-scope rate with no way to write it, and an unpinned invoice total — are
closed here. `paveworks` stays frozen for historical comparability; new sweeps should
read this one as the paving fixture.

## 1. What we're building & who uses it

A paving contractor's back office: the foreman opens jobs and marks them complete; the
crew reports hours and material against them; accounting turns finished jobs into
invoices. This is the two-engine composition proof: work orders on one side, invoicing
on the other, glued only by this vertical.

## 2. The thing that moves through the system

The **job**. Lifecycle: opened → in progress → completed → invoiced. A job cannot be
invoiced before it is completed; a completed job's reported lines are the invoice basis,
untouched by hand. A job wraps exactly one work order.

## 3. What already exists vs. what's ours

- Work orders, time entries, material lines: the work-order engine. A reported material
  line carries an article and a quantity and **no price** — pricing material is this
  vertical's job, not the engine's.
- Invoice drafts, immutable-after-export: the invoicing engine.
- Ours: the job vocabulary, the site address, the hourly rate, the material price list,
  the glue that turns reported lines into invoice lines, the screens.

## 4. Who is denied what

- **The crew never sees invoices or amounts.** Reporting hours is not seeing money, and
  the material price list is an amount.
- Accounting reads jobs but cannot open or complete them.
- Nothing crosses tenants; the second tenant in the seed exists to prove it.

## 5. Money & sign-off

One hourly rate per scope (a plain setting row, decimal string SEK). Material is billed
from **this vertical's own per-article price list** — the reported quantity times the
article's unit price, in the same currency as the rate. The invoice is created from a
completed job's reported lines: time at the hourly rate, material at its listed price.
Creating the invoice is accounting's sign-off.

An article reported against a job but absent from the price list is a **refusal**, not a
zero line: the invoice must not be issuable with material silently priced at nothing.

## 6. The cast, roles, tenancy

Tenant = the contractor; one scope per depot. Two tenants in the seed world:
**Asfalt & Söner AB** and **Beläggarna i Väst AB** — the second exists to be attacked.

Roles (frozen vocabulary — use these exact keys):

- `foreman` — holds `job:manage`, `job:read` (plus needed engine permissions to open,
  assign, and complete work).
- `crew` — holds `job:read` and the engine permissions to report time/material. Never
  anything invoice-shaped.
- `accounting` — holds `job:read`, `invoice:issue` (plus the engine permissions needed
  to read reported lines and create invoices). Never `job:manage`.

Cast: one of each role per tenant.

## 7. The data we'll store

- `paveworks_jobs`, keyed by the work order's id: site address, description, status
  timestamps, invoice id once issued (nullable).
- `paveworks_settings`: one row per scope — the hourly rate, a decimal string, and its
  currency (`SEK`).
- `paveworks_prices`: the material price list, keyed by article — unit (`ton`, `st`, …)
  and unit price as a decimal string, in the same currency as the rate.

Both `paveworks_settings` and `paveworks_prices` are **provisioned when the scope is
seeded**, not written by an operation. That is deliberate: it keeps §9's mutation
surface at exactly three names while still giving §5 a real per-scope rate and a real
price source. Changing a rate or a price is out of scope for this fixture (§10).

## 8. The scenario the test replays

The seed world gives Asfalt & Söner an hourly rate of `800.00` SEK and one priced
article, `asphalt-abt11`, at `1000.00` SEK per ton.

Happy path: foreman opens a job (Asfalt & Söner, "Storgatan resurfacing"), crew reports
6h of time and 2 ton of `asphalt-abt11`, foreman completes it, accounting issues the
invoice. The invoice then holds exactly two lines and this arithmetic:

- time: 6 × 800.00 = **4800**
- material: 2 × 1000.00 = **2000**
- invoice total: **6800**

Assert those as the platform's decimal helpers produce them — exact decimal strings with
trailing zeros stripped, so the total is the string `6800`, never `6800.00` and never a
number. Currency is `SEK` on every line and on the total.

Denials that must hold: crew calling the invoice operation is denied; invoicing an
uncompleted job is refused; issuing an invoice for a job whose reported material names
an article with no price row is refused; a Beläggarna principal reading an Asfalt &
Söner job gets nothing.

## 9. Operation vocabulary (frozen)

The vertical's operations, by exact name:

- `paveworks2/open-job` — open a job (foreman; composes work-order creation)
- `paveworks2/complete-job` — mark done (foreman; completes the work order)
- `paveworks2/issue-invoice` — create the invoice from a completed job's reported lines
  (accounting)

Reads for the screens may use whatever the platform's conventions prefer; the three
names above are the frozen mutation surface. Nothing writes the rate or the price list
— see §7.

## 10. Out of scope

Payments, reminders, exports to accounting systems, scheduling, customer portal, and
any operation that edits the hourly rate or the material price list.
