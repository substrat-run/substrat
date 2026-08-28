---
'@substrat-run/demo-ticket0': patch
'@substrat-run/docs': patch
---

The ticket0 support widget on one docs page. `widget.js` now keeps one widget per page and exposes `window.ticket0.unmount()` for a host with a client-side router; the docs site mounts it at `/guide/support` through a `Ticket0Widget` theme component that tears it down on navigation.
