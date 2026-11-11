---
'@substrat-run/connector-fortnox': patch
---

`FortnoxMock` answers supplier-invoice writes the way a Fortnox sandbox did: `bookkeep` on a booked or cancelled invoice is refused, and with `requireAttest` a company books only attested invoices and locks them against edits.
