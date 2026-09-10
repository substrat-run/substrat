# Paveworks II — paving jobs to invoices

Status: **frozen eval fixture** (builder-studio.md §9.6). Approved as-is; every decision
below is final. Where this document is silent, follow platform defaults and record the
assumption — do not ask.

Supersedes the `paveworks` fixture (#723): same domain, same shape, but the four places
the older concept could not be satisfied as written — material with no price source, a
required per-scope rate with no way to write it, an unpinned invoice total, and an
invoice-creating operation the invoicing engine deliberately offers no way to build —
are closed here. `paveworks` stays frozen for historical comparability; new sweeps
should read this one as the paving fixture.

## 1. What we're building & who uses it

A paving contractor's back office: the foreman opens jobs and marks them complete; the
crew reports hours and material against them; accounting signs off the invoice basis a
finished job produced. This is the two-engine composition proof: work orders on one
side, invoicing on the other, glued only by this vertical.

## 2. The thing that moves through the system

The **job**. Lifecycle: opened → in progress → completed → invoiced. Completing the job
is what produces the invoice basis — the completion carries the priced lines — and that
basis is untouched by hand afterwards. A job wraps exactly one work order.

## 3. What already exists vs. what's ours

- Work orders, time entries, material lines: the work-order engine. A reported material
  line carries an article and a quantity and **no price** — pricing material is this
  vertical's job, not the engine's. Completing a work order is what carries the final
  billable lines out.
- Invoice drafts, immutable-after-export: the invoicing engine. It is composed **by
  event**: it builds the basis from the completion event and is the only writer of its
  rows, so this vertical never creates, edits or reads-by-SQL an invoice.
- Ours: the job vocabulary, the site address, the hourly rate, the material price list,
  the glue that prices reported lines before completion, the screens.

## 4. Who is denied what

- **The crew never sees invoices or amounts.** Reporting hours is not seeing money, and
  the material price list is an amount.
- Accounting reads jobs but cannot open or complete them.
- Nothing crosses tenants; the second tenant in the seed exists to prove it.

## 5. Money & sign-off

One hourly rate per scope (a plain setting row, decimal string SEK). Material is billed
from **this vertical's own per-article price list** — the reported quantity times the
article's unit price, in the same currency as the rate.

Pricing happens **at completion**: `paveworks2/complete-job` prices the reported lines —
time at the hourly rate, material at its listed price — and hands them to the work-order
engine as the completion's billable lines. The invoicing engine builds the basis from
that completion event; nothing in this vertical writes an invoice row.

An article reported against a job but absent from the price list is a **refusal of the
completion**, not a zero line: a basis must not come into existence with material
silently priced at nothing.

Accounting's sign-off is **exporting** that basis — the invoicing engine's own
`invoicing/export`, mounted at this vertical's URL. Export is one-way, and the basis is
immutable after it.

## 6. The cast, roles, tenancy

Tenant = the contractor; one scope per depot. Two tenants in the seed world:
**Asfalt & Söner AB** and **Beläggarna i Väst AB** — the second exists to be attacked.

Roles (frozen vocabulary — use these exact keys):

- `foreman` — holds `job:manage`, `job:read` (plus needed engine permissions to open,
  assign, and complete work).
- `crew` — holds `job:read` and the engine permissions to report time/material. Never
  anything invoice-shaped.
- `accounting` — holds `job:read` plus the invoicing engine's `invoicing:read` and
  `invoicing:export`. Never `job:manage`, and never anything that writes a job.

Cast: one of each role per tenant.

## 7. The data we'll store

- `paveworks_jobs`, keyed by the work order's id: site address, description, status
  timestamps, and the invoice basis's id once one exists (nullable) — learned by
  consuming the invoicing engine's own event into this table, never by reading the
  engine's rows.
- `paveworks_settings`: one row per scope — the hourly rate, a decimal string, and its
  currency (`SEK`).
- `paveworks_prices`: the material price list, keyed by article — unit (`ton`, `st`, …)
  and unit price as a decimal string, in the same currency as the rate.

Both `paveworks_settings` and `paveworks_prices` are **provisioned when the scope is
seeded**, not written by an operation. That is deliberate: it keeps §9's mutation
surface at exactly two vertical names while still giving §5 a real per-scope rate and a
real price source. Changing a rate or a price is out of scope for this fixture (§10).

## 8. The scenario the test replays

The seed world gives Asfalt & Söner an hourly rate of `800.00` SEK and one priced
article, `asphalt-abt11`, at `1000.00` SEK per ton.

Happy path: foreman opens a job (Asfalt & Söner, "Storgatan resurfacing"), crew reports
6h of time and 2 ton of `asphalt-abt11`, foreman completes it — which prices both lines
and produces the basis — and accounting exports that basis. The basis then holds exactly
two lines and this arithmetic:

- time: 6 × 800.00 = **4800**
- material: 2 × 1000.00 = **2000**
- invoice total: **6800**

Assert those as the platform's decimal helpers produce them — exact decimal strings with
trailing zeros stripped, so the total is the string `6800`, never `6800.00` and never a
number. Currency is `SEK` on every line and on the total.

Denials that must hold: crew calling the export is denied; a job that is not completed
has no basis to export; completing a job whose reported material names an article with
no price row is refused; exporting a basis that is already exported is refused; and a
Beläggarna principal reading an Asfalt & Söner job gets nothing.

## 9. Operation vocabulary (frozen)

The vertical's own operations, by exact name:

- `paveworks2/open-job` — open a job (foreman; composes work-order creation)
- `paveworks2/complete-job` — price the reported lines and complete the work order
  (foreman)

Accounting's sign-off is the invoicing engine's `invoicing/export`, mounted at this
vertical's URL. This vertical adds **no** operation of its own for it: invoicing is
composed by event and exposes no in-scope write, so a vertical-owned "issue invoice"
could only be built by bypassing the engine. Those three names — two vertical, one
mounted — are the frozen mutation surface. Reads for the screens may use whatever the
platform's conventions prefer. Nothing writes the rate or the price list — see §7.

## 10. Out of scope

Payments, reminders, exports to accounting systems, scheduling, customer portal, and
any operation that edits the hourly rate or the material price list.
