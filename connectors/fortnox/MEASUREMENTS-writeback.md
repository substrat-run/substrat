# The supplier-invoice write-back, measured against Fortnox

What a real Fortnox answers to the write-back in [#2827](https://github.com/substrat-run/substrat/pull/2827),
which until now had only run against `FortnoxMock`. Produced by `pnpm fortnox:measure-writeback`
(`scripts/measure-writeback.mts`), which refuses any company whose organisation number is not the
sandbox marker `555555-5555`.

- **Company:** Fortnox sandbox, `CompanyName: "test"`, `OrganizationNumber: "555555-5555"`.
- **Date:** 2026-11-11. The run this report quotes is `WB-202611111439` (14:39 UTC), invoices
  **25–33**. Two earlier runs that day left invoices 13–18 (stopped before any measurement) and
  19–24 (the first measurements, before attest was understood). Invoice 21 was attested and booked
  by hand while working out the attest step. Invoices 1–12 were in the sandbox before this work
  started.
- **A second company configuration**, the same day: with the company's approval switched to "None"
  in the web UI, run `WB-202611111621`, invoices **43–51**, then switched back to "Simple approve"
  ([without approval](#without-approval)). A run in between, invoices 34–42, started before the switch
  and repeats the first.
- **Consent:** the credential's token carries
  `"scope":"bookkeeping companyinformation supplierinvoice supplier"`. It has no `archive` or
  `connectfile`, and no scope that admits `/supplierinvoicepayments` or `/settings/company`.

Every call below went through the real `FortnoxApi` method named, except those marked **direct**.
Those are calls #2827 has no method for: creating suppliers and invoices, cancelling, attesting,
the list filters, and payments. Error bodies are verbatim. A 200 that returns the whole invoice is
shortened to the fields that matter, and the script prints every body in full.

## The verdict

**#2827 works as designed in a company that does not require approval before booking, and its release
cannot work in one that does.** It depends on one company setting: Settings → Supplier invoices →
"Supplier invoice approval – General settings" → Approval management.

- **"None":** `bookkeep` books an invoice nobody approved. The block can be set and cleared before
  and after booking. The whole write-back runs as intended: hold, book, release, comment, receipt
  `done`, and a second pass writes nothing ([without approval](#without-approval)).
- **"Simple approve"** (how the sandbox was set): `bookkeep` refuses an invoice nobody approved
  (`2001109`). Once an invoice is approved, the API lets a `PUT` change only `OCR`, the invoice number
  and the due date, so `DisablePaymentFile` can be neither cleared nor set (`2003576`). An approved
  invoice is booked, stays blocked from payment, and gets no comment. The vertical receives `failed`
  for an invoice that is booked. Every repeat of the decision repeats the refused release.
- **The lock is the API's, not the invoice's.** In the web UI a person can clear the block on that
  same booked, approved invoice ([the web UI](#checked-in-the-web-ui)).
- **In an approval company the block is not what stops payment.** There an unbooked invoice cannot
  be selected for payment at all, and approval gates booking.

The write-back's behaviour is **unchanged** here. What it should do in an approval company is a design
decision. The options:
- skip the hold and the release there, since approval already gates payment;
- leave the release to a person;
- use Fortnox's approval calls (`approvalbookkeep`).

The first step is knowing which setting each customer's company has. The API answers
`approvalbookkeep` with `2001110` when approval is off, which a connector could read as "None".

## 1. The payment block (`DisablePaymentFile`)

| Step | Call | Answer |
|---|---|---|
| Set on unbooked A (25) | `PUT /supplierinvoices/25` `{"SupplierInvoice":{"DisablePaymentFile":true}}` | `200`, whole invoice back, `"DisablePaymentFile":true` |
| Read A back, diff of the whole object | `GET /supplierinvoices/25` | **only** `DisablePaymentFile: false → true` changed |
| Book A (not attested) | `PUT /supplierinvoices/25/bookkeep`, no body | `400 {"ErrorInformation":{"error":1,"message":"Fakturan måste vara attesterad.","code":2001109}}` |
| Attest A (**direct**) | `PUT /supplierinvoices/25/approvalbookkeep` | `200`, `"Booked":false`, `"DisablePaymentFile":true` |
| Book A | `PUT /supplierinvoices/25/bookkeep`, no body | `200`, `"Booked":true` |
| Read A after booking | `GET /supplierinvoices/25` | `"DisablePaymentFile":true`, still set. Changed: `Booked`, `Balance` (number → string), `Vouchers[0]` = `{"Number":6,"Year":1,"Series":"D","ReferenceType":"SUPPLIERINVOICE"}` |
| Clear on booked A | `PUT /supplierinvoices/25` `{"SupplierInvoice":{"DisablePaymentFile":false}}` | `400 {"ErrorInformation":{"error":1,"message":"Endast OCR, fakturanummer samt förfallodatum kan ändras på en attesterad leverantörsfaktura.","code":2003576}}` |
| Set on booked A, already set | `PUT … {"DisablePaymentFile":true}` | `200`, accepted, nothing changed |
| Set on C (27), attested and booked, never blocked | `PUT /supplierinvoices/27` `{"SupplierInvoice":{"DisablePaymentFile":true}}` | `400 … "code":2003576` (same message), `DisablePaymentFile` stays `false` |

- **Is the flag set on an unbooked invoice?** Yes, as long as it is not attested.
- **Did any other field change?** No. The `PUT` changed exactly the field it named, which is what
  #2827 assumes.
- **Is it still set after booking?** Yes.
- **Can it be cleared on a booked invoice?** **No**, here: refused with `2003576` because the invoice
  is attested, and in this company it must be attested to be booked.
- **Can it be set on an already-booked invoice?** **No**, for the same reason. Re-sending the value it
  already has is accepted.

## 2. `bookkeep`

All sent the way #2827 sends it, `PUT /supplierinvoices/{n}/bookkeep` with **no body**.

| Invoice | Answer |
|---|---|
| Any invoice nobody attested (A 25, E 29, F 30, B 26, D 28) | `400 {"ErrorInformation":{"error":1,"message":"Fakturan måste vara attesterad.","code":2001109}}` |
| B (26), no cost row. Attest first (**direct**) | `400 {"ErrorInformation":{"error":1,"message":"Leverantörsfaktura 26 balanserar inte.","code":2000755}}`. It cannot be attested, so it cannot be booked |
| C (27), already booked | `400 {"ErrorInformation":{"error":1,"message":"Leverantörsfakturan är redan bokförd.","code":2000417}}`. **An error, not a no-op.** The invoice is unchanged |
| D (28), cancelled. Attest first (**direct**) | `400 {"ErrorInformation":{"error":1,"message":"Ange minst två giltiga verifikationsrader.","code":2001111}}`. Then `bookkeep` again: `2001109` |
| An attested invoice | `200`, the whole invoice with `"Booked":true` |

- **Does `bookkeep` with no body work?** Yes: `200` once the invoice is attested.
- **An invoice that cannot be booked:** in an attest company the first answer is always `2001109`.
  The real reason (`2000755` doesn't balance, `2001111` no valid rows) comes from attest.
- **An already booked invoice:** `2000417`. #2827 reads `Booked` first and never sends it then. If
  the invoice were booked between that read and the write, the answer is a 4xx, and #2827 would
  hand the vertical `failed` for an invoice that is booked.

## 3. The comment log

| Call | Answer |
|---|---|
| `POST /supplierinvoices/25/commentlog` `{"SupplierInvoiceCommentLog":{"Comment":"Mätning 1: godkänd – åäö"}}` | `201 {"SupplierInvoiceCommentLog":{"Id":"7a35bb2a-318c-4b73-9ddd-0360bf57f7f5","Comment":"Mätning 1: godkänd – åäö","UserName":"Substrat","UserId":2,"CreatedAt":"2026-11-11 15:40:02.629265+01","PersistToInvoice":true}}` |
| a second comment, then `GET /supplierinvoices/25/commentlog` via `supplierInvoiceComments` | `["Mätning 1: godkänd – åäö","Mätning 2: andra kommentaren"]`: in order, and the Swedish letters intact |
| the invoice's own `CommentLog` (`GET /supplierinvoices/25`) | the same two entries, each with `Id`, `UserName`, `UserId`, `CreatedAt`, `PersistToInvoice` |
| 1000, 1001, 2000, 4000, 8000, 16000, 65536 characters | every one `201`, and read back unchanged, length for length |
| a comment on cancelled D (28), and on unbooked B (26) | `201` both |
| a comment on booked, attested A (25) | `201`. The log is not locked by attest |

- **Is it there, in order?** Yes.
- **Max length?** Not found. 65,536 characters were accepted and stored whole, so the limit is not
  1000.

## 4. Scopes

A client-credentials mint **can** be narrowed. `grant_type=client_credentials&scope=supplierinvoice`
answers `200 {"expires_in":3600,"token_type":"bearer","scope":"supplierinvoice"}`. A scope the
consent lacks is refused:
`400 {"error":"invalid_scope","error_description":"Requested scope is not consented for this tenant"}`.
With that `supplierinvoice`-only token, on E (29):

| Call | Answer |
|---|---|
| `supplierInvoice` (`GET /supplierinvoices/29`) | `200` |
| `setSupplierInvoicePaymentBlock(true)` | `200` |
| `bookSupplierInvoice`, before attest | `400 … "code":2001109` (attest, not scope) |
| `approvalbookkeep` (**direct**, same token) | `200` |
| `bookSupplierInvoice` | `200`, booked |
| `setSupplierInvoicePaymentBlock(false)` | `400 … "code":2003576` (attest, not scope) |
| `addSupplierInvoiceComment`, `supplierInvoiceComments` | `201`, `200` |
| `companyInformation` | `400 {"ErrorInformation":{"error":1,"message":"Har inte behörighet för scope.","code":2000663}}` |

- **Do `bookkeep` and `commentlog` work with `supplierinvoice` alone?** Yes, and so do the block
  and attest.
- **But the write-back as written needs `companyinformation` too.** The sweep reads
  `companyinformation` before it calls `writeback.read`, to tell the vertical which company it is
  answering for. With `supplierinvoice` alone that read is refused, and no write happens.

## 5. What `GET /supplierinvoices` lists

- **33 entries**, `{"@TotalResources":33,"@TotalPages":1,"@CurrentPage":1}`, every invoice in the
  sandbox, cancelled ones included. Each entry carries `@url, Balance, Booked, Cancel, CostCenter,
  Credit, Currency, CurrencyRate, CurrencyUnit, DueDate, ExternalInvoiceNumber,
  ExternalInvoiceSeries, GivenNumber, InvoiceDate, InvoiceNumber, Project, SupplierNumber,
  SupplierName, Total, AuthorizerName, Vouchers, FinalPayDate`. The list says `Cancel`, where the
  detail says `Cancelled`.
- **Can an invoice in the list have no cost account?** **Yes.** B (26), created with
  `"SupplierInvoiceRows":[]`, was accepted (`201`, with only Fortnox's own `TOT` 2440 and `VAT` 2641
  rows). It is in the list, and in `?filter=unbooked`. It is also what the landing receives.
- `?filter=unbooked`: 22 entries, B and the unattested ones among them. `?filter=cancelled`:
  `["10","16","22","28"]`. **`?filter=authorizepending`: `[]`**, although invoices 26, 30, 31, 32 and
  33 were then unbooked and not attested. So the filter does not mean "waiting for attest" in the
  sense `2001109` does.
- `supplierInvoicesModifiedSince("2026-11-10 14:40")`: invoices 13–33, every one changed that day.
- **Invoices in interpretation (tolkning), and received e-invoices: unanswered.** The sandbox has
  none of either, so the list cannot show whether they would appear.

## 6. Can an unbooked invoice be paid?

Not answered by the API. `POST /supplierinvoicepayments`
`{"SupplierInvoicePayment":{"InvoiceNumber":32,"Amount":125,"PaymentDate":"2026-11-11"}}` (**direct**)
answered `400 {"ErrorInformation":{"error":1,"message":"Har inte behörighet för scope.","code":2000663}}`
for unbooked H (32), and the same for unbooked, blocked I (33). The consent holds no scope that admits
payments. Registering a payment would in any case not be the payment file or bank-integration run
the question is about. That half is in [what a person has to check](#what-a-person-has-to-check).

## 7. The connector's write-back, end to end

`syncFortnoxSupplierInvoices` on a throwaway `SqliteScopeHost`, the way `test/sweep.test.ts` drives
it, with a hand-written `{ hold, decisions }` answer. Nothing was bound in any real install. Each
pass also landed the day's invoices through the binding's operation (`"landed":21` on the first).
Fortnox's real details parsed without a failure.

**G (31), attested before the board decides.** One answer:
`{ hold: [31], decisions: [{ book, release, comment }] }`.

| Pass | Writes, in order | Receipt | Pass result |
|---|---|---|---|
| 1 | `PUT /supplierinvoices/31` (hold) → `400 … 2003576`; `PUT /supplierinvoices/31/bookkeep` → `200`; `POST /supplierinvoices/31/commentlog` → `201` | `done` | threw `hold of supplier invoice 31: … attesterad leverantörsfaktura.` |
| 2, the same decision again | none | `done` | `{"landed":21,"held":0,"written":1,"pending":false}` |

The release was skipped, correctly: no hold of the binding's own was ever set. G ends booked, not
blocked, with the comment. **An attested invoice cannot be held at all**, and every pass that lists
it in `hold` fails the scope's row.

**F (30), not attested.** Pass 1 answers `{ hold: [30], decisions: [30] }`.

| Pass | Writes, in order | Receipt |
|---|---|---|
| 1 | `PUT /supplierinvoices/30` (hold) → `200`; `PUT /supplierinvoices/30/bookkeep` → `400 {"ErrorInformation":{"error":1,"message":"Fakturan måste vara attesterad.","code":2001109}}` | `failed`, `"Fortnox PUT /supplierinvoices/30/bookkeep failed: Fakturan måste vara attesterad."` |
| attested by hand (**direct**) | `PUT /supplierinvoices/30/approvalbookkeep` → `200` | |
| 2, the vertical answers the decision again | `PUT /supplierinvoices/30/bookkeep` → `200`; `PUT /supplierinvoices/30` (release) → `400 {"ErrorInformation":{"error":1,"message":"Endast OCR, fakturanummer samt förfallodatum kan ändras på en attesterad leverantörsfaktura.","code":2003576}}` | `failed`, the same message |
| 3, the same decision again | `PUT /supplierinvoices/30` (release) → `400 … 2003576` | `failed` |

F ends `"Booked":true`, `"DisablePaymentFile":true`, `CommentLog: []`.

- **Order: hold, then book, then release, then comment?** The order of attempts is confirmed:
  hold, book, release, comment. In this company the sequence never completes, because the release
  is refused and the comment comes after it.
- **Does a second pass write nothing?** For G, yes: zero writes. For F, no. Every pass that answers
  the decision again repeats the one refused release. Booking is not repeated.
- **What #2827 got right here:**
  - A refusal in Fortnox's words became a `failed` receipt at once.
  - An invoice that could not be booked stayed held.
  - Nothing was booked twice.
  - The block was never lifted for an invoice the binding did not block.

## Without approval

Run `WB-202611111621`, invoices 43–51, with Approval management set to "None". Every call is the
same as in the first run. What changed:

| Call | Answer |
|---|---|
| `bookkeep` on unbooked, blocked A (43), nobody approved | `200`, `"Booked":true`, `"DisablePaymentFile":true` |
| clear the block on booked A: `PUT /supplierinvoices/43` `{"SupplierInvoice":{"DisablePaymentFile":false}}` | **`200`, `"DisablePaymentFile":false`**. The diff of the whole invoice changed only that field |
| set it again on booked A, and on booked C (45), never blocked | `200` both |
| `approvalbookkeep`, any invoice | `400 {"ErrorInformation":{"error":1,"message":"Inställningen för enkel attest är avstängd.","code":2001110}}` |
| `bookkeep` on B (44), no cost row | `400 {"ErrorInformation":{"error":1,"message":"Leverantörsfaktura 44 balanserar inte.","code":2000755}}` |
| `bookkeep` on cancelled D (46) | `400 {"ErrorInformation":{"error":1,"message":"Leverantörsfakturan är makulerad och kan därför inte bokföras.","code":2000418}}` |
| `bookkeep` on booked C (45) | `400 … "code":2000417`, as before |
| `supplierinvoice`-only token, on E (47): block, `bookkeep`, release, comment | `200`, `200`, `200`, `201` |

So without approval, the real reason an invoice cannot be booked comes back from `bookkeep` itself.
The scope question gets a full answer: with `supplierinvoice` alone the whole write-back's writes
succeed (only the sweep's `companyinformation` read needs more).

End to end, `syncFortnoxSupplierInvoices` as before:

| Invoice, pass | Writes, in order | Receipt |
|---|---|---|
| G (49), pass 1: `{ hold: [49], decisions: [49] }` | `PUT /supplierinvoices/49` (hold) → `200`; `PUT …/49/bookkeep` → `200`; `PUT /supplierinvoices/49` (release) → `200`; `POST …/49/commentlog` → `201` | `done` |
| G, pass 2, the same decision again | none | `done` |
| F (48), pass 1: `{ hold: [48], decisions: [48] }` | hold `200`, book `200`, release `200`, comment `201` | `done` |
| F, passes 2 and 3, the same decision again | none | `done` |

G ends booked, not blocked, with the board's comment. Pass 1 reported `"held":1,"written":1`. **This
is #2827 doing what it was written to do, against a real Fortnox.**

## The approval path, measured

The approval path in the stacked follow-up was measured with "Simple approve" back on: run
`WB-202611111650`, invoices 61–69. In a company that requires approval, the write-back now lifts its
hold, approves the invoice and books it. The run in between, invoices 52–60, was made with "None".
It wrote what the earlier no-approval run did.

| Invoice, pass | Writes, in order | Receipt |
|---|---|---|
| F (66), pass 1: `{ hold: [66], decisions: [66] }` | hold `PUT /supplierinvoices/66` → `200`; `PUT …/66/bookkeep` → `400 … 2001109`; release `PUT /supplierinvoices/66` → `200`; `PUT …/66/approvalbookkeep` → `200`; `PUT …/66/bookkeep` → `200`; `POST …/66/commentlog` → `201` | `done` |
| F, pass 2, the same decision again | none | `done` |
| G (67), approved before the sweep saw it, pass 1 | hold `PUT /supplierinvoices/67` → `400 … 2003576`; `PUT …/67/bookkeep` → `200`; `POST …/67/commentlog` → `201` | `done`. The pass reports once that 67 "was approved in Fortnox before it could be held" |
| G, pass 2 | none, and the hold is not asked again | `done` |

F and G both end booked, not blocked, with the board's comment.

## Where `FortnoxMock` disagreed with Fortnox

| What the mock did | What Fortnox does | Change |
|---|---|---|
| `bookkeep` books any invoice that has no `cannotBook` | in a company that requires attest, `400 … 2001109` until `approvalbookkeep` | **Mock fixed:** `requireAttest` (off by default) and `attest(n)`, and `PUT …/approvalbookkeep` is served. **Connector:** #2827 never attests, so in such a company a decision books only after the company's own attest routine has run. A design decision, not made here |
| a `PUT` changes any field, on any invoice | on an attested invoice only `OCR`, `InvoiceNumber`, `DueDate` may change. Anything else is `400 … 2003576`, and re-sending a current value is accepted | **Mock fixed.** **Connector:** the release after booking cannot work in such a company, and nor can a hold of an attested invoice. Behaviour unchanged, by instruction. Two tests now pin what it does there |
| `bookkeep` on a cancelled invoice books it | `400 {"ErrorInformation":{"error":1,"message":"Leverantörsfakturan är makulerad och kan därför inte bokföras.","code":2000418}}` | **Mock fixed.** No connector change: a refusal in Fortnox's words is already `failed` at once |
| `bookkeep` on a booked invoice answers `200` | `400 {"ErrorInformation":{"error":1,"message":"Leverantörsfakturan är redan bokförd.","code":2000417}}` | **Mock fixed.** **Connector:** worth treating `2000417` as done rather than `failed`, for the read-then-book race. Not changed here |
| errors carry only `message` | `{"error":1,"message":…,"code":…}`: a numeric code a caller could branch on instead of Swedish text | **Mock:** the new answers carry the code |
| a comment-log entry is `{ Comment }` | `{ Id, Comment, UserName, UserId, CreatedAt, PersistToInvoice }`, in the `POST` answer and in `GET …/commentlog` | **Mock fixed.** No connector change: it reads `Comment` only |
| the test fixture's booked invoice carries `VoucherNumber: 44` | a booked invoice keeps `VoucherNumber`, `VoucherSeries` and `VoucherYear` `null`, and its voucher is in `Vouchers: [{"Number":6,"Year":1,"Series":"D","ReferenceType":"SUPPLIERINVOICE"}]` | **Connector, the landing, not the write-back:** `voucher` is `null` on every booked invoice it lands. It should read `Vouchers[]`. Not changed here. The landing's tests assert the fixture's shape, so the fixture moves with that fix |

The mock's default is a company with approval set to "None". That case is now measured, and the
existing write-back tests describe what the sandbox did there.

## Checked in the web UI

Checked the same day by a person's browser session in the sandbox. The company's UI is in English, so
labels are quoted in English. Nothing was changed, approved, booked or paid.

- **The approval setting.** Settings → Supplier invoices → "Supplier invoice approval – General
  settings": Approval management **"Simple approve"**, Payment approve **off**, Prioritise payment
  **off**. That is the rule behind `2001109`. On unbooked 32 and 33 the UI shows "The invoice must be
  approved." with **Post** greyed out.
- **An unbooked invoice cannot be paid here.** In **Payments out** (registering a payment by hand),
  unbooked 32 and 33 do not come up in the invoice search ("No results found."). Under the filter
  "Unpaid" they are not listed. Under "All" they are listed with no checkbox and cannot be selected,
  blocked or not. Every booked invoice can be selected (25, 27, 29, 30 and 31), so **booking is the
  gate for paying, in this company**.
- **The payment block does not stop a payment registered by hand.** Booked invoices 25, 29 and 30,
  blocked over the API, are selectable in Payments out like 27 and 31. The block is shown on the
  invoice as an ✗ with the tooltip "Payment file disabled": it is about payment files.
- **The payment-file view was not reached.** The Supplier invoices list and "Show list" open a setup
  wizard ("Get started with supplier invoices!") instead. Finishing it changes settings, so it was
  left alone. Whether a blocked invoice is missing from a payment file is still open.
- **The UI lifts a block the API cannot.** On booked, approved 25 the toolbar's **"Enable payment
  file"** answered "Payment file enabled.", the ✗ disappeared, and a reload showed it lifted. "Disable
  payment file" ("Payment file disabled.") then set it again, and 25 was left blocked as before. Over
  the API the same change is refused (`2003576`). So the lock is **a limit of the API, not a state of
  the invoice**: Fortnox lets a person clear the block after booking, and does not let an
  integration.

## What a person has to check

Still open, in the sandbox's web UI:

1. **The payment-file view**, once someone decides to finish the supplier-invoice setup wizard. Is
   blocked 33, 25, 29 or 30 missing from a payment file, where 32, 27 and 31 are not?
2. **Which scope admits `/supplierinvoicepayments`?** The current consent does not hold it.
