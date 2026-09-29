---
'@substrat-run/vertical-host': patch
---

Calls through the MCP endpoint are now walked for field coverage too, by the same walk and under the same switch as a mounted route, so a field that only an MCP client reads no longer looks unread. Each tool call also resets the invocation record's `outputFields` with the rest of its per-call state, so one call's report cannot ride another's line. The switch stays off unless the platform arms it, and unarmed nothing about a tool call changes.
