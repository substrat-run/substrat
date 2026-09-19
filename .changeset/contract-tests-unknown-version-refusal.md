---
'@substrat-run/contract-tests': patch
---

The scope-host suite pins the `unknown version` refusal on all five registry verbs — `admitVersion`, `rejectVersion`, `promoteVersion`, `bindScopeVersion`, `versionManifest` — by the error CODE they declare, via the existing `expectRefusal(promise, code)` helper (#113 phase 5).

This is new coverage, not a moved assertion: the suite asserted on that message **zero** times before, so five throw sites per adapter were pinned by nothing at all and a regression to a bare `Error` at any of them was invisible. Each of the ten was broken in turn and the case fails on the adapter carrying the break every time.
