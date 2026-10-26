---
"@substrat-run/kernel": minor
---

Connector sweeps can now set a provider poll interval. The platform still checks declared connection landings every pass, while a connection awaiting its next poll keeps its previous sweep outcome. Planima polls every two hours; providers without an interval keep the existing cadence.
