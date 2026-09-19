---
'@substrat-run/contract-tests': patch
---

The scope-host suite asserts the `unknown vertical` refusals by the error CODE they declare, not by matching their message (#113 phase 5). A new `expectRefusal(promise, code)` helper reads `errorCodeOf` — the same reading the control plane's `mapError` does — so the suite and the problem document a transport renders agree by construction rather than by coincidence. A promise that resolves fails it too, so the assertion cannot pass by not throwing.
