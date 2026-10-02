---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/attachment-extractors': minor
---

Attachments are now searchable by their content. Each upload queues a text extraction job in the same transaction as the upload, so an extraction failure can never fail the upload. The kernel parses no file format itself (K-43). The new `@substrat-run/attachment-extractors` package holds the parsers, and a host is constructed with them (`attachmentExtractors: defaultAttachmentExtractors()`). They read plain text, Markdown, CSV and other `text/*` files, HTML, DOCX, XLSX and PPTX, with no dependency: the zip reader uses the web-standard `DecompressionStream`. PDF is not extracted yet, and nothing is OCR'd. A host given no extractor for a type records it as unsupported. Whatever an extractor returns, the kernel holds it to the output cap, a time budget and a valid shape. Every attachment records its extraction state (`pending`, `indexed`, `empty`, `unsupported` or `failed`, with the reason), which module code reads with `readAttachmentText(ctx, attachmentId)`.

`ScopeAttachments.search(term, { limit })` returns matching attachments newest first. It decides which owners the caller may read before it looks at the term, using the check `open` makes (the target's `readPermission` on the owning entity), and matches only among them. An attachment the caller cannot open neither appears nor takes a slot. Search returns no count, score or snippet. A caller without scope-level read on a type has that type's owners checked one by one, up to 2,000. Past that, the search is refused with `forbidden` and the reason `attachment_search_too_many_owners`, whatever the term.

`registerJob` now refuses a job under the kernel's own module id: the kernel runs that job itself.

Extracted text is capped at 512 KiB per attachment, and the bundled zip reader inflates at most 16 MiB per file. Removing an attachment removes its text. Scope dumps carry no extracted text: a restore or fork re-queues extraction for the attachments it brings back. The scope sweeper's `runJobs` option drives the extraction job, and no deployment has to register it.
