---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
---

A declared route may answer more than one success status. It lists them in `statuses` (for example `[200, 202]`), a plain return answers the first, and a handler picks another by returning `answered(status, body)`. `mountRoutes` refuses a status the route does not list, and the OpenAPI document lists each status.
