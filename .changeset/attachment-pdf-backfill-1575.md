---
'@substrat-run/attachment-extractors': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'create-substrat': patch
---

Attachment content search now reads PDFs, reaches attachments uploaded before extraction existed, and lets a host tighten its bounds (#1575).

- `pdfExtractor` joins `defaultAttachmentExtractors()`, so a host already constructed with them reads PDFs with no change. It reads the text each page draws, in page order, through a font's `ToUnicode` map or its encoding (WinAnsi, MacRoman, Standard, `/Differences`). It handles classic and stream cross-references, incremental updates and object streams, and falls back to scanning for objects when the cross-reference data is unusable. It decodes Flate (with PNG predictors), LZW, ASCIIHex, ASCII85 and RunLength, with no dependency. It is written for hostile input:
  - one stream decoding past 8 MiB fails the file, and all of a file's streams stop together at `maxInflatedBytes`;
  - the cross-reference chain is followed through at most 64 sections and refused when it loops, and at most 200 000 objects are declared;
  - arrays and dictionaries, the page tree, form XObjects and object streams are each depth-bounded and cycle-checked;
  - every loop is paced against the kernel's time budget.

  An encrypted PDF records `failed` with that reason, and a scanned one, which has no text layer, records `empty`.
- **Backfill.** An attachment uploaded before its scope had extraction has no text row, so it was never searchable. The job driver (`runDueJobs`) now starts a one-shot kernel job, `attachment-text-backfill`, in every scope that holds attachments. It queues extraction for those with no text row, `ATTACHMENT_TEXT_BACKFILL_BATCH` (200) per pass. Its run row marks the scope, so the scope is never walked again, and it never runs on a request path. The kernel exports `startAttachmentTextBackfill`, `queueAttachmentTextBackfill` and `attachmentTextBackfillJob`, which both adapters use.
- **`attachmentTextBounds`**, a new option on `SqliteScopeHost` and `CloudflareScopeHost`. It tightens the input ceiling, the text cap or the time budget, for example for a host whose CPU limit is under the 30 s default. `resolveAttachmentTextBounds` refuses, when the host is built, a bound that is not a positive integer or that raises a default.
- `attachmentTextContractSuite` now takes `(options?) => fixture`, with `attachmentExtractors` and `attachmentTextBounds` in the options. Its fixture also provides `forgetAttachmentText(tenantId, scopeId)`, which returns a scope to its state before extraction. The suite holds both adapters to the bounds, the backfill, the PDF fixtures and a set of hostile PDFs (`hostilePdfs()`).
- A scaffolded project's pinned `@substrat-run/attachment-extractors` moves with this release, so its uploads read PDFs too.
