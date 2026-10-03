---
"create-substrat": patch
---

A new project's worker and dev seed now construct their scope host with `attachmentExtractors: defaultAttachmentExtractors()`, and `@substrat-run/attachment-extractors` joins its dependencies. An attachment uploaded to a scaffolded vertical is therefore searchable by its text (plain text, Markdown, CSV, HTML, DOCX, XLSX, PPTX) instead of being recorded as `unsupported`.
