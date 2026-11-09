---
'@substrat-run/demo-auth-server': patch
---

Sign-out skips the confirmation page only for a request that names its client. An authorize link fetched by anything other than a page load no longer starts an upstream sign-in, and a failure starting one falls back to the login screen.
