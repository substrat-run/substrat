---
'@substrat-run/dashboard': minor
'@substrat-run/dashboard-web': minor
---

Rewinding an app to a migration bookmark now requires `dashboard:provision-app`. A viewer's
rewind request is refused with 403, and the Deployments tab hides Back out for viewers.
Owners, admins, and members retain rewind access.
