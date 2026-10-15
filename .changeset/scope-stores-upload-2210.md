---
'@substrat-run/contracts': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane': patch
---

A vertical that declares a scope store gets its store script uploaded first, as a Python worker whose entry checks the envelope (#2210). A kind with no published release is refused.
