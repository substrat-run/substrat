---
'@substrat-run/demo-auth-server': patch
'@substrat-run/demo-auth-server-app': patch
---

Deleting a user works again for anyone who had signed in to an app: it no longer fails halfway. Their sessions, refresh tokens and consents end at once; an access token an API verifies by itself stays valid until it expires. Both Remove buttons ask first.
