---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
---

Subject access (D-74), the door: `POST /tenants/:t/scopes/:s/subjects/:id/access` returns one person's package (their events and records, other people masked, recipients marked not available) with an HTML page, and records a `subjectAccess` admin row holding counts and the request's reference. A team's owner or admin runs it from a new Personal data section of the app's Data tab, behind `dashboard:subject-access`, and Audit shows it under their name.
