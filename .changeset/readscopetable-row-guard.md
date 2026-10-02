---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
---

`readScopeTable` refuses a page bound SQLite would misread: a limit that is not a positive integer, and an offset that is not a non-negative integer, including `NaN` and non-finite values, are refused as `validation_failed` instead of reaching `LIMIT` / `OFFSET`. A large valid limit is still clamped to the page maximum. The kernel exports `assertRowOffset` beside `assertRowLimit`.
