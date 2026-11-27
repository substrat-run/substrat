---
"@substrat-run/connector-fortnox": minor
---

A supplier-invoice landing now carries the invoice's accrual (periodisering). Fortnox books a periodised invoice on the accrual account and keeps the cost account, the period and the cadence in `GET /3/supplierinvoiceaccruals/{n}`, so a reader of the rows alone saw an interim account and never the cost it stands for. Each invoice now costs two reads (its rows and its accrual; a 404 is `accrual: null`), so a pass lands at most 100 changed invoices instead of 200. If Fortnox refuses the accrual reads, the invoices land without the field, no more accruals are asked for that pass, and the sweep's row says why. The field is `accrual` on `fortnoxSupplierInvoicePage`: accounts, dates, `period` as Fortnox's own word, `times`, `total`, `vatIncluded`, `description` and Fortnox's accrual rows. `FortnoxMock` answers `supplierinvoiceaccruals/{n}` from an entry's `accrual`, and `accrualsRefused` makes it refuse.
