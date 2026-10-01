---
'@substrat-run/vertical-auth': patch
---

Keep session cookies host-only on every configured platform base domain, even when a delivered cookie domain requests a parent shared by other tenants. Expire old domain cookies and invalidate sessions issued under the old policy.
