---
'@substrat-run/control-plane-api': patch
---

Add a staff-only, paged and resumable pass that heals every legacy preview still pinned to its vertical's serving script: it carries the data off the serving script into the preview's bound version, binds that version, then clears the pin (#1724).

A scope reap, a tenant reap and the bulk `adopt-serving` now refuse a body that is not valid JSON (400) or carries a key they do not know, instead of reading it as the defaults and running the act. An empty body is unchanged.
