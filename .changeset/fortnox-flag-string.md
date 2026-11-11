---
'@substrat-run/connector-fortnox': patch
---

A supplier invoice flag Fortnox sends as `"true"`, `"false"` or `""` is read as a boolean instead of failing the invoice landing.
