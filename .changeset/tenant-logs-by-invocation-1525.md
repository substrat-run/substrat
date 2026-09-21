---
'@substrat-run/control-plane-api': patch
---

`GET /observability/tenant-logs` takes an optional `invocationId`, and answers with only the log lines of that one call.

The id is the one the platform stamps on a call's log line and on every event the call recorded, so a caller holding an event can now ask for what the same request *wrote*, beside what it recorded. It narrows within the caller's own tenant and never past it: an id that belongs to another tenant matches nothing here. A value that is not a ULID is refused with a `400`, and leaving the parameter out is the read it always was.
