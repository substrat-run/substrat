---
'@substrat-run/dashboard': minor
'@substrat-run/dashboard-web': minor
---

Importing data into an app (Data › Export & import) is now for a team owner or admin. **Team
members lose the ability to restore an app from a file**: they keep Export, and an Import from them
is refused with a 403 before the safety copy is taken. A restore replaces the app's data and its
permission state, so it is an admin power, held through a new key, `dashboard:restore-app-data`.
Existing teams' owner and admin roles get the key on their first request after the deploy, before
that request runs, so an admin's first Import already succeeds.
