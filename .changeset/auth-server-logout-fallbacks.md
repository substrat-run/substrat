---
'@substrat-run/demo-auth-server': patch
---

Signing out with no recognisable client keeps the confirmation page, and a refused confirmation or a failed upstream lookup falls back to the page it replaced instead of an error.
