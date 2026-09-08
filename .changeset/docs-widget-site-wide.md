---
"@substrat-run/docs": patch
---

The ticket0 support widget is on every page of substrat.net, not only `/guide/support`. The site-wide `<head>` embed is on by default and aimed at the hosted desk; `TICKET0_API` points a local build at a local desk and `TICKET0_WIDGET=0` builds without one. The per-page `<Ticket0Widget>` component is gone — it would have doubled the bubble and, on leaving the support page, unmounted the site-wide one.
