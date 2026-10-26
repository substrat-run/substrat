---
'@substrat-run/dashboard': minor
'@substrat-run/dashboard-web': minor
---

Importing data into an app (Data › Export & import) is now for a team owner or admin. A restore
replaces the app's data and its permission state, so it is an admin power, held through a new key,
`dashboard:restore-app-data`. A member keeps Export and is refused with a 403 on Import, before the
safety copy is taken. Existing teams get the key on their owners' and admins' next visit.
