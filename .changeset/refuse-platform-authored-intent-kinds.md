---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
---

`ctx.requestPlatform` refuses the platform-authored `sweep-runs` intent kind, so module code can no longer forge its own schedule and freshness verdicts. The scope sweeper's own enqueue path is unchanged.
