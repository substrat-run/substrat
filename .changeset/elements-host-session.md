---
'@substrat-run/elements': minor
---

`session-url=""` on `<sub-user-menu>` and `<sub-avatar>` reads nothing, for a host that sets `session` itself: React sets that property only after the element is connected, so the default URL used to be asked first.
