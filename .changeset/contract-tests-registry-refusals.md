---
'@substrat-run/contract-tests': patch
---

The scope-host suite pins the registry's owner, auto-admission and not-admitted refusals by the error CODE they declare (`conflict`), via the existing `expectRefusal(promise, code)` helper, rather than by matching `/owned by/`, `/auto-admitted.*staff admit/` or `/…, not admitted/` in the message (#113 phase 5). The two `owned by` assertions keep a message match beside the code, only for which owner the sentence names. The message is otherwise free to change; the type is what cannot.
