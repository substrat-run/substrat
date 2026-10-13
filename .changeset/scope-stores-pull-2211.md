---
'@substrat-run/cli': patch
'@substrat-run/control-plane-client': patch
---

`substrat scope restore` of a `.dump.json` sends the dump's scope stores back, and a full pull keeps a dump's `stores` where the host has them. A masked pull sends an empty store list, because those tables cannot be pseudonymized. A restore body that omits `stores` leaves the live stores untouched.
