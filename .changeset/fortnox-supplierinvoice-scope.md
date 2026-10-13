---
'@substrat-run/connector-fortnox': patch
---

The platform's Fortnox Connect flow now asks for the `supplierinvoice` scope alongside `bookkeeping` and `companyinformation`. The connector does not choose scopes (its caller passes them in); this release only documents the new default and has its mock return it, and it has no supplier invoice code yet. A company connected before this has to go through Connect again before the new scope applies, and the integration must have the Supplier Invoice permission enabled in the Fortnox Developer Portal.
