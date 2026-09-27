---
'@substrat-run/control-plane-api': patch
---

The tenant log read shows each request once. Cloudflare's own record of an invocation is folded into Substrat's stamped line for the same request, and its CPU time, wall time and outcome move onto that row. A line the vertical wrote itself is never folded.
