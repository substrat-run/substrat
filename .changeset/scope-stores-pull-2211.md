---
'@substrat-run/cli': patch
'@substrat-run/control-plane-client': patch
---

A full scope pull can carry scope stores, and `substrat scope restore` of a `.dump.json` sends them back. A masked pull sends an empty store list, because those tables cannot be pseudonymized. A restore body that omits `stores` leaves the live stores untouched.
