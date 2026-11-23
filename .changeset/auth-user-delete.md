---
'@substrat-run/demo-auth-server': patch
'@substrat-run/demo-auth-server-app': patch
---

Deleting a user works again for anyone who had signed in to an app: it no longer fails halfway, and their sessions, tokens and consents end at once. Both Remove buttons ask first.
