---
'@substrat-run/demo-auth-server': patch
---

A client with domain routes no longer skips the login screen, which could send a person round the same upstream forever, and a refused logout confirmation leaves the page up instead of an error.
