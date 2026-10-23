---
"@substrat-run/builder": patch
---

The builder studio answers its refusals as RFC 9457 problem documents, on the local server and the hosted worker alike, and an unexpected failure answers the same problem document (status 500, `error: 'internal error'`) instead of a plain-text page. A provider or turn failure the studio did not write a message for no longer shows its internal text; the cause goes to the server log.
