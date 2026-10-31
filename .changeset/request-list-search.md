---
'@substrat-run/control-plane-api': minor
---

The tenant request list takes a free-text `search` (operation, path, request id, or `POST /path`); the request histogram and facet counts refuse it with a `validation_failed` problem whose `reason` is `search_not_counted`.
