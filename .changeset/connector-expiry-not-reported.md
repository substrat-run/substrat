---
'@substrat-run/connector-scrive': patch
'@substrat-run/connector-fortnox': patch
'@substrat-run/connector-planima': patch
---

Document why no connector records `Connection.expiresAt`: Scrive (OAuth1 personal access credentials), Fortnox (`client_credentials`, 1h access tokens) and Planima (a static token) have no refresh credential with a horizon, so "not reported" is the true answer. Comments and tests only; no behaviour change.
