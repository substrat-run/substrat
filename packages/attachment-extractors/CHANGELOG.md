# @substrat-run/attachment-extractors

## 0.1.3

### Patch Changes

- Updated dependencies [7559e1a]
- Updated dependencies [21055d5]
- Updated dependencies [b641075]
- Updated dependencies [7adf5c7]
- Updated dependencies [1c411fc]
  - @substrat-run/kernel@0.137.0

## 0.1.2

### Patch Changes

- Updated dependencies [1af2d47]
- Updated dependencies [4fdad69]
- Updated dependencies [4964eb8]
- Updated dependencies [30c2cda]
- Updated dependencies [b9b3b82]
- Updated dependencies [3ed9e9d]
- Updated dependencies [cdf32ab]
- Updated dependencies [7418e7e]
- Updated dependencies [18069f9]
  - @substrat-run/kernel@0.136.0

## 0.1.1

### Patch Changes

- 8267b83: The HTML extractor now ends every construct where a browser's HTML tokenizer ends it. A `script` or `style` element closes only at a complete end tag of its own name, so a string such as `"</scripture>"` inside a script no longer ends it early and lets the rest of the script be indexed as text. Script escape rules, nested `template` content, a `>` inside a quoted attribute value and the ways a comment can end follow the tokenizer too. The content of `title`, `textarea`, `xmp` and `plaintext` is read as text, so markup written inside it (a `</template>`, a comment) is shown as written rather than acted on, and stays hidden inside a template. The extractor never indexes text the HTML parser keeps out of the rendered document. Where it does not model how a browser parses (inline SVG and MathML, `select`, a frameset it cannot prove ignored), it indexes nothing rather than guess, and may index less there. It follows the parser, not the renderer: text hidden by the `hidden` attribute, CSS or a closed `<details>` is indexed, which is never more than a searcher can read, since search is gated by the same permission as opening the file.

  The bundled parsers check the kernel's abort signal at least every `EXTRACTION_STRIDE` units of work, inside a single long comment, tag or run of text as well as between them, and yield with `setImmediate` where the runtime has it. The kernel exports `EXTRACTION_STRIDE` (256 Ki), the interval a cooperative extractor checks its signal at.

- Updated dependencies [8267b83]
- Updated dependencies [1dca2da]
- Updated dependencies [3328549]
- Updated dependencies [8c64633]
- Updated dependencies [5d41454]
  - @substrat-run/kernel@0.135.0

## 0.1.0

### Minor Changes

- 176fe60: Attachments are now searchable by their content. Each upload queues a text extraction job in the same transaction as the upload, so an extraction failure can never fail the upload. The kernel parses no file format itself (K-43). The new `@substrat-run/attachment-extractors` package holds the parsers, and a host is constructed with them (`attachmentExtractors: defaultAttachmentExtractors()`). They read plain text, Markdown, CSV and other `text/*` files, HTML, DOCX, XLSX and PPTX, with no dependency: the zip reader uses the web-standard `DecompressionStream`. PDF is not extracted yet, and nothing is OCR'd. A host given no extractor for a type records it as unsupported. Whatever an extractor returns, the kernel holds it to the output cap, a time budget and a valid shape. Every attachment records its extraction state (`pending`, `indexed`, `empty`, `unsupported` or `failed`, with the reason), which module code reads with `readAttachmentText(ctx, attachmentId)`.

  `ScopeAttachments.search(term, { limit })` returns matching attachments newest first. It decides which owners the caller may read before it looks at the term, using the check `open` makes (the target's `readPermission` on the owning entity), and matches only among them. An attachment the caller cannot open neither appears nor takes a slot. Search returns no count, score or snippet. A caller without scope-level read on a type has that type's owners checked one by one, up to 2,000. Past that, the search is refused with `forbidden` and the reason `attachment_search_too_many_owners`, whatever the term.

  `registerJob` now refuses a job under the kernel's own module id: the kernel runs that job itself.

  Extracted text is capped at 512 KiB per attachment, and the bundled zip reader inflates at most 16 MiB per file. Removing an attachment removes its text. Scope dumps carry no extracted text: a restore or fork re-queues extraction for the attachments it brings back. The scope sweeper's `runJobs` option drives the extraction job, and no deployment has to register it.

### Patch Changes

- Updated dependencies [176fe60]
- Updated dependencies [4347933]
- Updated dependencies [1addd27]
- Updated dependencies [560eec4]
  - @substrat-run/kernel@0.134.0
