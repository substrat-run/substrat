---
'@substrat-run/demo-auth-server': patch
---

Signing out of an application ends the session and returns to the application straight away, with no "Confirm logout" page and no "The logout confirmation is invalid or expired" error. An application narrowed to a single redirect-based upstream (Microsoft, Google, a generic OIDC provider), with password sign-in off, now sends a signed-out visitor from `/oauth2/authorize` straight to that upstream, with no login screen in between.
