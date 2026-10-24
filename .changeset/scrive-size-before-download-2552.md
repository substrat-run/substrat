---
"@substrat-run/connector-scrive": patch
---

A sealed document too large to hold is no longer downloaded, and a reconcile no longer re-downloads it on every pass (#2552). The connector reads the response's `Content-Length` before the body and skips a file over `SCRIVE_MAX_DOWNLOAD_BYTES` (32 MiB, the most it holds in memory: one resident copy plus the upload path's own, about 64 MiB of a 128 MB isolate) without reading it. A response that declares no length is counted and cut off at that bound, and its body released; a declared length within the bound sizes the one buffer the body is read into. The reconcile reports the file as skipped ("larger than this connector downloads") and remembers the decision on the dispatch row (`sealedHeld`), and the activity view shows the sealed copy as not stored.

When a held file is looked at again: a callback or an explicit `reconcileScriveDispatch` clears the hold and tries again, as does a pass run with `honourHeld` once the provider's `mtime` differs. The passive sweep never looks at a held row, because every party is recorded and it skips such rows. A response without `mtime` stays held until a callback or an explicit reconcile. The marker goes when the file lands. Any other failure, including a download that times out, is not held and is retried on the next pass.

Streaming the provider's download straight through to the upload, which would lift the bound toward the platform's 95 MiB streamed-upload ceiling, is a later step. `ScriveApi.getMainFile` takes an optional byte bound and throws `ScriveFileTooLargeError` above it; `ScriveMock` gains `mtime`, `touch`, `setSealedFile`, `sealedBytesServed` and `sealedCancelled` for tests.
