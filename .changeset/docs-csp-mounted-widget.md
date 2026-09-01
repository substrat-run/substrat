---
'@substrat-run/docs': patch
---

The docs CSP names the desk a page mounts the support widget on, so the widget on
`/guide/support` loads again. The site-wide embed is a `<script>` in the built HTML,
which the policy was derived from; the per-page `<Ticket0Widget>` appends its script
from JavaScript after mount, so nothing about `ticket0.substrat.net` reached the build
and the browser blocked it on production only. The desks are now read out of the
markdown, and the origin guard covers them too.
