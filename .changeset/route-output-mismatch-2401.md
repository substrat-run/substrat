---
'@substrat-run/vertical-host': patch
---

A declared route (`mountRoutes`) whose handler answers outside its declared output now throws `RouteOutputMismatch`, an `internal` error, instead of a plain `Error`. The taxonomy renders it as a `500` with no `detail`, so the schema's issues no longer reach the caller, and an app whose error handler fell back to `400` for an unclassified throw no longer tells the caller to look at what they sent. The route name and the issue paths (never a value, at most ten) ride on the error as `route` and `issuePaths`, for the app's own log.
