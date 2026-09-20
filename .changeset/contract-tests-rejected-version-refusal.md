---
'@substrat-run/contract-tests': patch
---

The scope-host suite pins `admitVersion`'s refusal of a rejected version by the error CODE it declares (`conflict`), via the existing `expectRefusal(promise, code)` helper, rather than by matching `/was rejected/` in the message (#113 phase 5). The message is now free to change; the type is what cannot.
