---
'@substrat-run/control-plane-api': patch
---

A Python store kind gets a Python twin of the platform's store entry, and it checks every call with the same verifier as the JavaScript entry. The upload ships that verifier beside the Python entry as an ES module. The entry's module names, the Python entry and the verifier included, are reserved, so a kind release may not ship a module under any of them (#2290).
