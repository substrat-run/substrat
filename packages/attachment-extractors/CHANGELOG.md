# @substrat-run/attachment-extractors

## 0.2.3

### Patch Changes

- Updated dependencies [6a81de3]
- Updated dependencies [c78098a]
- Updated dependencies [65305a1]
- Updated dependencies [c56bb34]
  - @substrat-run/kernel@0.142.0

## 0.2.2

### Patch Changes

- Updated dependencies [48be1e6]
- Updated dependencies [6a05977]
  - @substrat-run/kernel@0.141.0

## 0.2.1

### Patch Changes

- Updated dependencies [35dc72e]
- Updated dependencies [32df62b]
- Updated dependencies [6154fd9]
- Updated dependencies [6d49012]
- Updated dependencies [55e6241]
- Updated dependencies [13a2067]
- Updated dependencies [7b15101]
- Updated dependencies [72f8e92]
- Updated dependencies [d42bb2b]
- Updated dependencies [e5bd928]
- Updated dependencies [b180d3e]
- Updated dependencies [07388df]
- Updated dependencies [ae80b0d]
- Updated dependencies [a1f40e5]
- Updated dependencies [0e3d406]
- Updated dependencies [5405401]
- Updated dependencies [655141a]
- Updated dependencies [f1290ea]
- Updated dependencies [ced5130]
  - @substrat-run/kernel@0.140.0

## 0.2.0

### Minor Changes

- d62f6fb: Attachment content search now reads PDFs, reaches attachments uploaded before extraction existed, and lets a host tighten its bounds (#1575).

  - `pdfExtractor` joins `defaultAttachmentExtractors()`, so a host already constructed with them reads PDFs with no change. It reads the text each page draws, in page order, through a font's `ToUnicode` map or its encoding (WinAnsi, MacRoman, Standard, `/Differences`). It handles classic and stream cross-references, incremental updates and object streams, and falls back to scanning for objects when the cross-reference data is unusable. It decodes Flate (with PNG predictors), LZW, ASCIIHex, ASCII85 and RunLength, with no dependency. It is written for hostile input:

    - one stream decoding past 8 MiB fails the file, and all of a file's streams stop together at `maxInflatedBytes`;
    - the cross-reference chain is followed through at most 64 sections and refused when it loops, and at most 200 000 objects are declared;
    - arrays and dictionaries, the page tree, form XObjects and object streams are each depth-bounded and cycle-checked;
    - every loop is paced against the kernel's time budget.

    An encrypted PDF records `failed` with that reason, and a scanned one, which has no text layer, records `empty`.

  - **Backfill.** An attachment uploaded before its scope had extraction has no text row, so it was never searchable. The job driver (`runDueJobs`) now starts a one-shot kernel job, `attachment-text-backfill`, in every scope that holds attachments. It queues extraction for those with no text row, `ATTACHMENT_TEXT_BACKFILL_BATCH` (200) per pass. Its run row marks the scope, so the scope is never walked again, and it never runs on a request path. The kernel exports `startAttachmentTextBackfill`, `queueAttachmentTextBackfill` and `attachmentTextBackfillJob`, which both adapters use, and `kernelJobFor`, the one place a kernel job is dispatched.
  - **`attachmentTextBounds`**, a new option on `SqliteScopeHost` and `CloudflareScopeHost`. It tightens the input ceiling, the text cap or the time budget, for example for a host whose CPU limit is under the 30 s default. `resolveAttachmentTextBounds` refuses, when the host is built, a bound that is not a positive integer or that raises a default.
  - `attachmentTextContractSuite` now takes `(options?) => fixture`, with `attachmentExtractors` and `attachmentTextBounds` in the options. Its fixture also provides `forgetAttachmentText(tenantId, scopeId)`, which returns a scope to its state before extraction. The suite holds both adapters to the bounds, the backfill, the PDF fixtures and a set of hostile PDFs (`hostilePdfs()`).
  - A scaffolded project's pinned `@substrat-run/attachment-extractors` moves with this release, so its uploads read PDFs too.

### Patch Changes

- aa159b9: The PDF extractor holds memory to a budget, as it already held time to one (#1575). One extraction may keep at most twice its inflate budget plus 4 MiB, which is 36 MiB at the defaults. Each allocation that grows with the input is charged before it is made: cached decoded streams, a page's joined content, parsed objects, cross-reference entries, CMap entries and font decoders. A font decoder is charged what it was measured to hold, so a document with thousands of fonts still reads in full. If reading pages would go past the budget, the text read so far is kept and marked truncated; going past it earlier fails the file with that reason. A CMap `bfrange` is now stored as one entry, and each destination is computed when its code is looked up, instead of one string per code. Where definitions overlap, the later one still wins for every code it names, as before. A CMap is no longer cut off at 131 072 codes. Its definitions are bounded by the memory budget instead, so a code defined many times still takes its last definition. A ToUnicode CMap shared by several fonts is parsed once.
- Updated dependencies [d62f6fb]
- Updated dependencies [98492af]
- Updated dependencies [2a505df]
- Updated dependencies [ec25a00]
- Updated dependencies [4a14c92]
- Updated dependencies [d55b4cd]
- Updated dependencies [48bf765]
  - @substrat-run/kernel@0.139.0

## 0.1.4

### Patch Changes

- Updated dependencies [d5739ca]
- Updated dependencies [50ce5e0]
- Updated dependencies [59972cb]
- Updated dependencies [6476e71]
- Updated dependencies [d08b9b1]
- Updated dependencies [f33b1c3]
- Updated dependencies [921dfa3]
  - @substrat-run/kernel@0.138.0

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
