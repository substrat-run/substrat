# Demo Vertical — "Meridian" (HR, milestone 2 shape-breaker)

Status: draft v0.1 · Last updated: 2026-07-18

> Companion to the master plan §7.9 (non-goals — the payroll boundary), §5.1 (nested
> tenancy), §5.3 (GDPR in an immutable lake), and §3 (engines are *extracted, not
> designed*). Where Callout ([demos/callout](../../callout/spec/concept.md)) proves the engines
> compose, Meridian is the deliberate shape-breaker: a domain with **no ready-made engine**,
> chosen to prove the kernel isn't secretly field-service-shaped — the §8.2 role, HR edition.

## 1. What the demo must prove

1. **The kernel carries a domain that has no engine yet.** Vacation/absence, time
   reporting, and expenses are all *vertical code* here — proving the guarantees (tenancy,
   permissions, audit, GDPR) hold with zero engine support, and that the kernel's value
   isn't borrowed from the work-order state machine.
2. **Nested tenancy earns its keep across jurisdictions.** One company, two scopes (Sweden,
   Spain), with genuinely different statutory rules — the tree is load-bearing, not
   decoration.
3. **GDPR erasure is structural.** Erasing an employee crypto-shreds their PII while the
   pseudonymous facts (absence counts, ledger balances) survive for statutory retention —
   the HR-specific reason the kernel exists, performed on stage.
4. **Enforcement is structural, and visceral.** A cross-tenant read of *salaries* fails at
   the boundary. HR data makes the attack demo land harder than order data does.
5. **Protocol reuse generalizes.** Onboarding checklists are `engine-protocol` — the same
   engine Handlebar and Callout use — proving reuse across a third, non-field vertical.
6. **The payroll boundary is respected.** Variable pay leaves as an export, never a rebuilt
   payroll — the invoice basis pattern (§7.9: integrate deep-domain moats, don't rebuild).

## 2. Shape: a small multi-country company's HR OS

**Meridian** = the HR product skin. It runs the staff-facing surfaces (self-service portal,
manager approvals, HR admin) and the back-office (directory, absence ledger, expense
review) against one API. The demo firm is a ~30-person software company operating two legal
entities — a Swedish one and a Spanish one — the exact shape where the cheap single-country
PTO tools break and the mid-market suites are overkill.

The slice: **directory + vacation & absence + time reporting (to projects) + expenses +
onboarding**. Everything else HR (recruiting, performance, learning, benefits) is out of
scope — integrate or defer.

**Shift scheduling is a v1 non-goal**, called out because it's the crown jewel of tools like
[Skello](https://www.skello.io/en) that shift-based firms lean on. Meridian is HR-record-led
(salaried staff), not scheduling-led (deskless/rota staff); a rota maps to Substrat's
**deferred scheduling engine** (§6, with its double-booking and working-time invariants) and
is pulled forward only if a genuinely shift-based tenant needs it.

## 3. Tenancy setup

- Tenant = the company; scope = legal entity / country. Demo data: **two tenants**, so the
  attack demo has a victim.
  - **Nordljus AB** — scopes: `SE` (Stockholm), `ES` (Madrid). The multi-country subject.
  - **Solmark AB** — scope: `SE` only. The cross-tenant victim.
- Principals covering the acceptance list:
  - **HR admin** (tenant-level) — every employee, every scope, including salary.
  - **Manager** (scope role, Stockholm) — approves their team's leave and expenses; sees
    their team's absence, **not** salaries, **not** the Madrid employees.
  - **Employee** (entity-narrowed grant) — own records only: own balance, own requests, own
    expenses. The portal-walk principal.
  - **Payroll operator** (scope role) — reads the variable-pay export for one scope; no write.
  - **(attacker)** Solmark's HR admin — attempts to read Nordljus salaries and absence.

## 4. Decomposition (given today's engines)

| Capability | Layer | Demo scope |
|---|---|---|
| Employee records + directory | **Vertical** | side tables keyed by `employee` id; org chart falls out of the scope tree |
| **Vacation** & absence (types, balances, accrual, carryover, approval) | **Vertical now → `engine-absence` extraction target** (§3) | core; vacation is the headline type; the accrual ledger is the future engine's invariant surface (§5) |
| **Time reporting** — hours booked to a **project** (append-only) | **Vertical** (workorder's time-entry model is the reference pattern) | core; daily totals also satisfy ES *registro de jornada* |
| Projects (the vocabulary time books against) | **Vertical** | simple `hr_projects` table; an `EntityRef` a time entry points at |
| Expenses (submit → approve → categorize → export) | **Vertical + connector stub** | approval flow + Qonto/Fortnox export stubbed as a file |
| Onboarding / offboarding checklists | **Engine `engine-protocol`** | reuse: per-employee checklist instance, sign → immutable |
| Public-holiday calendars | **Vertical** (scope-attached data) | SE vs ES divergence, per scope |
| Documents (contracts, addenda) | **Kernel** (documents service) + BankID/Scrive connector | contract attached to `employee` ref; e-sign stubbed |
| Payroll | **Connector, deferred** | variable-pay export file per pay period (the invoice basis-equivalent) |
| Self-service portal | **Kernel** (portal role + app shell) | own records only |
| GDPR erasure | **Kernel machinery** | crypto-shred an employee; facts retained |
| Recruiting / performance / learning / benefits | **Out of scope** | integrate or defer — not foundation-shaped |

## 5. The domain: absence as the extraction target

There is no absence engine today, and that is the point. The vertical implements it as
plain module code now; the invariants below are the shape a future **`engine-absence`**
would freeze — extracted only when a *second* HR-shaped vertical forces it (exactly how the
bike shop forced `engine-protocol` out of Callout).

- **Tables (vertical):** `hr_employees`, `hr_absence_ledger` (append-only), `hr_leave_types`,
  `hr_projects`, `hr_time_entries` (append-only), `hr_expenses`, `hr_expense_lines`,
  `hr_holidays`.
- **Invariants the future engine would own:**
  - The **absence ledger is append-only** — an accrual, a booking, a correction, or a
    carryover is a new entry, never an edit. Balance is a fold over entries.
  - **Balance-as-of-date is a pure function** of the ledger — no stored mutable counter.
  - **No negative beyond policy** — a booking that would breach the leave type's floor is
    rejected by the invariant, not by UI.
  - **Every mutation emits a fat event**; **every operation checks a permission**.
  - **Approval is a state machine** — `requested → approved | rejected → (cancelled)` with
    no skips; only the booking of an *approved* request touches the ledger.
- **What stays vertical forever:** the *accrual formulas*, leave-type vocabulary, carryover
  caps, and per-country rules. The engine would own the ledger's integrity; the vertical
  owns what any particular jurisdiction decides (decision 26: behavior reshaped per scope,
  invariants shared).

Protocol reuse is the one engine beat: onboarding is `instantiateProtocol(ctx, { templateKey:
'onboarding-se' | 'onboarding-es', entity: employeeRef })` — sign freezes it, content hash
proves it, per-scope template content is vertical-owned.

**Two ledgers, one shape.** Vacation/absence and time reporting are *both* append-only entry
ledgers with the same invariant (a correction is a compensating entry, the current value is a
fold, every write emits an event). Absence entries move a **balance**; time entries book
**worked hours to a `project` `EntityRef`** and never affect a balance. That two independent
capabilities want the identical ledger discipline is the strongest signal that
`engine-absence` should generalize to an entry-ledger engine when the second consumer forces
it — the workorder engine already owns exactly this shape for order-bound time, which is why
its time-entry model is the reference pattern, not a candidate to fork onto. (Open question,
left for the second consumer: the generic append-only-entries-against-a-ref primitive smells
**kernel** — a contract like documents/timeline — while the accrual, approval state machine,
and balance floors are the **engine**.) Time reporting feeds three consumers:
**utilization/cost** reporting (hours per project), **ES *registro de jornada*** (daily
totals), and **overtime** on the payroll export (§7).

### 5.1 Meridian's dual role, and the constraint that makes it work

Meridian v1 is deliberately **both**: a standalone, sellable HR product *and* the reference
vertical that seeds `engine-absence` for the operational verticals. These don't conflict —
the reusable unit is the **engine**, not the vertical. Meridian is the HR-first *packaging*
(directory, self-service app, dashboard, GTM); the absence/time ledger discipline is what
extracts. Callout and the bike shop wanting vacation + HR-time — a field tech booking leave
in the *same app* they report work-order time — are the intended **consumer #2**, the trigger
that forces the extraction. Because every company has employees, that reuse is also the
strongest available proof of the plan's least-proven hypothesis (engine reuse, §3).

**The line that keeps "both" honest: the ledger binds to an opaque subject ref.** A future
`engine-absence` must key every entry off an opaque `(employee, id)` `EntityRef` the
*vertical* provides — it never owns an employee table, exactly as `engine-workorder` binds to
`facility`/`customer` refs it never dereferences. Meridian supplies that ref from
`hr_employees`; Callout supplies it from its own technicians. The **directory — who our
people are, their employment terms, country/scope — stays vertical-owned**; the engine owns
only the ledger's integrity over whatever subject it's handed. This line must be drawn now,
while the code is still vertical-first, or the engine can never compose into a vertical that
already has its own people. Corollary: Meridian-the-vertical stays thin (vocabulary, screens,
packaging); anything an operational vertical would also need goes through the engine seam,
never Meridian-specific code.

## 6. Country divergence — one invariant, two behaviors

The tenancy tree's payoff, made concrete. Same append-only ledger, different config per scope:

| | `SE` (Stockholm) | `ES` (Madrid) |
|---|---|---|
| Statutory vacation | 25 days; **saved days** carry up to 5 years | 30 calendar / 22 working days; own carryover rule |
| Absence types | *karensavdrag*, *sjuklön* (day 1–14 → Försäkringskassan), **VAB**, *föräldraledighet* | *baja* (IT/CC), permisos |
| Time reporting | hours → project; presence not mandatory | same entries **satisfy registro de jornada** (daily total) — legally required |
| Holidays | Swedish red-days calendar | national + Comunidad de Madrid + local |

All of it is scope-attached data and per-scope leave-type config — no code fork, no second
build. Flipping the demo principal from a Stockholm manager to a Madrid one changes the
rules they see because it changes the *scope*, not the binary.

## 7. The payroll boundary (the architectural showpiece)

The vertical owns leave, absence, overtime, and approved expenses. The payroll provider owns
gross-to-net, tax, and filings. Between them: a **variable-pay export per pay period** —
approved absence, attendance overtime, and reimbursable expenses, per scope, as one file
through a connector stub. This is Callout's Fortnox-export beat, re-cast for HR, and it
performs the §7.9 discipline: *payroll is a deep-domain moat — integrate it, never rebuild
it.* SE and ES export to different providers behind the same connector seam.

## 8. The GDPR beat (HR-specific)

Erase an employee: their PII (name, personnummer / DNI, contact, contract PDF) is
crypto-shredded per §5.3; the pseudonymous facts — absence-day counts, ledger balances,
attendance totals needed for statutory retention — remain, keyed to a pseudonymous subject
id. Show the directory row gone, the aggregate absence report unchanged. Nobody sells this
in HR at SME price points; it is a kernel default here, not a feature the vertical built.

## 9. The demo script (~12 min)

1. **(3 min) Business flow** — employee at Nordljus SE requests 5 vacation days → manager
   approves → ledger books it, balance drops → the same employee logs 8h to a project (daily
   total satisfies *registro de jornada*) → onboarding checklist for a new Madrid hire,
   signed and frozen → an expense submitted, approved, and queued for export.
2. **(3 min) Two countries** — view-as the Madrid manager: different statutory days, ES
   holidays, `registro de jornada` present; view-as Stockholm: saved-days balance, VAB as a
   type. Same code, different scope.
3. **(2 min) Permission tree** — view-as an employee (own balance only, no colleague's
   salary), view-as a manager (team absence, no salaries, no Madrid). `explain` shows *why*.
4. **(2 min) The attack** — Solmark's admin tries to read Nordljus salaries: forged scope
   id, direct SQL, cross-tenant stub request. Lint catches what it can; the boundary rejects
   the rest at runtime, audited.
5. **(2 min) Erasure & exit** — crypto-shred an employee, show facts survive; then
   `substrat dev` the same data on plain SQLite and open it in a browser — escrow, shown.

## 10. Build order

1. Meridian vertical skeleton: manifest, migrations (`hr_*` tables incl. `hr_projects`),
   roles from vertical permission keys, seed the two tenants + four+one principals.
2. Vacation/absence: append-only ledger, accrual + booking + carryover as compensating
   entries, balance-as-of-date fold, approval state machine, fat events — the extraction
   candidate.
3. Time reporting (hours → project, append-only) + expenses (approval + export stub).
4. Protocol wiring: onboarding templates per scope, `instantiateProtocol` from a vertical op.
5. Country config: per-scope leave types + holiday calendars; the payroll-export connector stub.
6. Scenario test + the attack script + view-as. GDPR erasure path.

Deferred deliberately: `engine-absence` extraction (waits for a second HR vertical),
documents/e-sign real connectors, recruiting/performance/learning, Cloudflare adapter (demo
runs pure-SQLite).

## 11. Definition of done

The scenario test replays headlessly on the pure adapter: happy path (request → approve →
book → balance), **denials hold** (employee can't read a colleague's salary; Stockholm
manager can't see Madrid; cross-tenant attacker gets `unknown scope` / `permission denied`),
per-scope rules differ from the same code, the absence ledger refuses a skip and refuses an
over-floor booking, an approved expense lands in the export, and the erasure path shreds PII
while the aggregate absence report is byte-identical before and after. All contract tests
green; runs under 15 minutes on a laptop with no network.
