---
'@substrat-run/connector-fortnox': patch
---

The Fortnox consent now asks for the `supplierinvoice` scope alongside `bookkeeping` and `companyinformation`, so a connection can read and approve supplier invoices. A company connected before this has to go through Connect again before the new scope applies, and the integration must have the Supplier Invoice permission enabled in the Fortnox Developer Portal.
