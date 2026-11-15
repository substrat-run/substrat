---
'@substrat-run/connector-scrive': minor
---

connector-scrive: voiding a protocol or cancelling its signature requests now cancels the Scrive document, settles the dispatch row so the sweep stops polling it, never counts a signature on a cancelled request as recorded, and lets a new request on the same instance go out as a new document.
