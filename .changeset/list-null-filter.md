---
"@substrat-run/kernel": patch
"@substrat-run/contract-tests": patch
---

`ctx.page` reads a `null` filter as `IS NULL`. It used to compose `= NULL`, which is never true, so filtering a nullable column for "no value" answered an empty page.
