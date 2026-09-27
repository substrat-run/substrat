---
'@substrat-run/control-plane-api': minor
---

The tenant log read now includes `ctx.log` lines (#1746, #1747). They carry their own tenant, scope and invocation, so they are read directly with every filter applied in the query, and appear once even when their invocation is expanded too. A new `template` filter answers one pattern's lines. `/observability/tenant-log-patterns` groups a tenant's `ctx.log` lines by the template they were written from, giving each template's count, share, level split and a small histogram. Grouping is exact: a pattern is the lines one call site wrote. The Cloudflare reader answers it with one grouped calculations query plus a total. A reader without it answers 501.
