---
'@substrat-run/control-plane': patch
---

A seeded preview's sign-in picker accepts the pick again: its page no longer sends `no-referrer`, which made the browser post `Origin: null` and the picker refuse every person.
