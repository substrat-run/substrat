---
'@substrat-run/vertical-auth': minor
---

Add a principal-wide identity-directory unbind that removes every subject binding in a scope and returns the removed subjects, plus a places helper that reports each removed subject absent. Member removal no longer needs a bounded scan of unrelated logins to prove it revoked access.
