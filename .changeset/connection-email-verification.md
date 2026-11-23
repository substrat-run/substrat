---
'@substrat-run/demo-auth-server': minor
'@substrat-run/demo-auth-server-app': minor
---

"Require email verification" is now a setting of the Username-Password connection, saved on the connection from its Settings tab, rather than the issuer-wide `REQUIRE_EMAIL_VERIFICATION` environment setting. An issuer that set the environment setting keeps its behaviour: it is read until the connection has a value of its own, and the Settings tab says when that is happening. The environment setting is deprecated.
