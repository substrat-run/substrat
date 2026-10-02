---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

Attachments are now searchable by their content. Each upload queues a text extraction job in the same transaction as the upload, so an extraction failure can never fail the upload. The job reads plain text, Markdown, CSV and other `text/*` files, HTML, DOCX, XLSX and PPTX, and adds no dependency: the zip reader uses the web-standard `DecompressionStream`. PDF is not extracted yet, and nothing is OCR'd. Every attachment records its extraction state (`pending`, `indexed`, `empty`, `unsupported` or `failed`, with the reason), which module code reads with `readAttachmentText(ctx, attachmentId)`.

`ScopeAttachments.search(term, { limit })` returns matching attachments newest first. Every hit passes the check `open` makes, the target's `readPermission` on the owning entity, before the limit is applied, so an attachment the caller cannot open neither appears nor takes a slot. Search returns no count, score or snippet.

Extracted text is capped at 512 KiB per attachment, and a zip may inflate to at most 16 MiB. Removing an attachment removes its text. Scope dumps carry no extracted text: a restore or fork re-queues extraction for the attachments it brings back. The scope sweeper's `runJobs` option drives the extraction job, and no deployment has to register it.
