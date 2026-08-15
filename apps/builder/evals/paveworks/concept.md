# Paveworks — paving jobs to invoices

Status: **frozen eval fixture** (builder-studio.md §9.6). Approved as-is; every decision
below is final. Where this document is silent, follow platform defaults and record the
assumption — do not ask.

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

- Work orders, time entries, material lines: the work-order engine.
- Invoice drafts, immutable-after-export: the invoicing engine.
- Ours: the job vocabulary, the site address, the hourly rate, the glue that turns
  reported lines into invoice lines, the screens.

## 4. Who is denied what

- **The crew never sees invoices or amounts.** Reporting hours is not seeing money.
- Accounting reads jobs but cannot open or complete them.
- Nothing crosses tenants; the second tenant in the seed exists to prove it.

## 5. Money & sign-off

One hourly rate per tenant (a plain setting row, decimal string SEK); material passes
through at reported cost. The invoice is created from a completed job's reported lines —
time at the hourly rate, material at cost. Creating the invoice is accounting's
sign-off.

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
- `paveworks_settings`: one row per tenant — the hourly rate.

## 8. The scenario the test replays

Happy path: foreman opens a job (Asfalt & Söner, "Storgatan resurfacing"), crew reports
6h and 2 tons of asphalt, foreman completes it, accounting issues the invoice and the
invoice lines match the reported lines priced at the tenant's hourly rate. Denials:
crew calling the invoice operation is denied; invoicing an uncompleted job is refused;
a Beläggarna principal reading an Asfalt & Söner job gets nothing.

## 9. Operation vocabulary (frozen)

The vertical's operations, by exact name:

- `paveworks/open-job` — open a job (foreman; composes work-order creation)
- `paveworks/complete-job` — mark done (foreman; completes the work order)
- `paveworks/issue-invoice` — create the invoice from a completed job's reported lines
  (accounting)

Reads for the screens may use whatever the platform's conventions prefer; the three
names above are the frozen mutation surface.

## 10. Out of scope

Payments, reminders, exports to accounting systems, scheduling, customer portal.
