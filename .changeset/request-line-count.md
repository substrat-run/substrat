---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

Requests carry a line count. `InvokeOptions.onLogLines` reports how many `ctx.log` lines a call wrote under its invocation id, including the consumers its post-commit tail ran inline, and it reports them for a failed call too. Both scope hosts report it. The invocation line carries it as `logLines` (`null` when not recorded), and the tenant request reads return it.
