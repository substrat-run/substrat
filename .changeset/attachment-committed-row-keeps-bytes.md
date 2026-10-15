---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
---

An attachment whose row has committed keeps its bytes. Previously, a failure after the commit (the consumer drain that delivers `attachment.added`, or on the Cloudflare host a call to the scope that rejects without an answer) reached the upload as a refusal, and the refusal deleted the stored bytes. That left an attachment row pointing at nothing and, for an upload link, a spent link. Now a drain fault after the commit is logged and the upload answers with its record; the event stays queued, and the next drain in the scope delivers it. The Cloudflare host deletes the bytes only when the scope answered a refusal. When the call fails without an answer, it keeps the bytes and rethrows, because the row may have committed.
