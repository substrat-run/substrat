---
"@substrat-run/connector-fortnox": minor
---

A Fortnox supplier-invoice binding now lands supplier invoices, read-only: each sweep lands the invoices changed since the binding's `invoiceSync` cursor as one `fortnoxSupplierInvoicePage` (supplier, dates, total, booked and cancelled state, accounting rows), and moves the cursor only after the landing accepts the page. A binding's first pass reads the last 90 days. Nothing is written to Fortnox (#2715).
