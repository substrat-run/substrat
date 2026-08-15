# Fixline — appliance repair intake desk

Status: **frozen eval fixture** (builder-studio.md §9.6). Approved as-is; every decision
below is final. Where this document is silent, follow platform defaults and record the
assumption — do not ask.

## 1. What we're building & who uses it

A small appliance-repair firm's intake desk: office staff register repair tickets for
customers' machines (washing machines, fridges, ovens), set a price, and close the ticket
when the technician is done. Users are the office staff and the field technicians.

## 2. The thing that moves through the system

The **ticket**. Lifecycle: registered → priced → in progress → closed. A ticket cannot
close before it has a price, and a closed ticket is immutable. Time and material reported
against the ticket ride on the platform's work-order machinery — a ticket wraps exactly
one work order.

## 3. What already exists vs. what's ours

- Work orders, time entries, material lines: the work-order engine, as-is.
- Ours: the ticket vocabulary, the appliance details, the price, the screens.

## 4. Who is denied what

- **Technicians never see or set prices.** Pricing is office-only.
- Office and technicians see only their own firm's tickets — nothing across tenants,
  ever. The second tenant in the seed exists to prove that.

## 5. Money & sign-off

One fixed price per ticket, set by the office before work starts, stored as a decimal
string in SEK. No invoicing in v1 (deferred). Closing the ticket is the office's
sign-off; a close without a price must be refused.

## 6. The cast, roles, tenancy

Tenant = the repair firm; one scope per workshop. Two tenants in the seed world:
**Vitgods AB** (Stockholm) and **Kall & Klar AB** (Malmö) — the second exists to be
attacked in the scenario test.

Roles (frozen vocabulary — use these exact keys):

- `office` — holds `ticket:manage`, `ticket:price`, `ticket:read` (plus whatever
  engine permissions the compositions need).
- `technician` — holds `ticket:read` and the engine permissions needed to report
  time/material. Never `ticket:price`, never `ticket:manage`.

Cast: an office admin per tenant, one technician per tenant.

## 7. The data we'll store

One side table, `fixline_tickets`, keyed by the work order's id: appliance kind, make,
model, customer name, price (nullable until priced), status timestamps. No other tables.

## 8. The scenario the test replays

Happy path: office creates a ticket (Vitgods, a broken Bosch washer), prices it at
1200.00, technician reports 1.5h of time, office closes it. Denials that must hold:
the technician calling the pricing operation is denied; closing an unpriced ticket is
refused; a Kall & Klar principal reading a Vitgods ticket gets nothing.

## 9. Operation vocabulary (frozen)

The vertical's operations, by exact name:

- `fixline/create-ticket` — register a ticket (office; composes work-order creation)
- `fixline/price-ticket` — set the price (office only)
- `fixline/close-ticket` — close a priced ticket (office; completes the work order)

Reads for the screens may use whatever the platform's conventions prefer; the three
names above are the frozen mutation surface.

## 10. Out of scope

Invoicing, scheduling, customer portal, photos, notifications.
