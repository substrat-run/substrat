---
id: K-43
date: 2026-10-02
layer: kernel
title: "The kernel indexes attachment text; it does not parse file formats"
status: accepted
aliases: []
tracking: ["#1575", "#1976"]
---

# K-43 — The kernel indexes attachment text; it does not parse file formats

**Content search over attachments is split at the text, not at the file: the kernel owns everything that happens to extracted text, and nothing that happens to a file format.** The kernel holds the text table and its FTS index under the dump-excluded `_substrat_search__` prefix, the removal and restore/fork lifecycle, the job that drives extraction, the outcome vocabulary (`pending`, `indexed`, `empty`, `unsupported`, `failed`, with a reason), the output cap that protects the scope row, and the permission-gated `ScopeAttachments.search`. It defines one seam, an **`AttachmentExtractor`**: a function from `(bytes, contentType)` to an extraction outcome. Every parser — plain text and HTML decoding, the zip reader and its inflate budget, DOCX/XLSX/PPTX, and later PDF and OCR — lives behind that seam in a separate **host-side package**, which the kernel never imports. Whoever constructs the host (the pure adapter's options, a worker's `ScopeDO` definition) passes the extractors in; adapters accept them and do not import them either. A host given no extractor for a type records `unsupported` with that reason, which is the legible state #1575 already requires, so "no extractors wired" is a valid configuration, not a broken one.

The extractor is **not an engine**. An engine is module code: it reaches data through `ctx.sql`, owns entities and invariants, checks a permission on every operation and emits on every mutation. An extractor has no entity, no permission and no event, and needs what module code may never have — every attachment's bytes, unchecked. It is infrastructure the kernel consumes, which is D-18's adapter bucket (the one that already names search backends): a pure function the host runs, which a vertical cannot supply.

## Why

#1575's case for the kernel is three reasons — a search across entities that no one module can write, an index no writer can desynchronise, and the per-entity read gate. All three are about the **index**. None of them is about parsing, and parsing is what would grow the kernel without bound: every format is a new parser, every parser fix a kernel release, and the format customers upload most (PDF) needs a parser of a size the kernel cannot plausibly carry. A seam that will have to be cut once PDF arrives is cheapest to cut while the only extractors are small.

The parsers are also the riskiest code in the feature — a zip reader exists to be handed hostile input, and its zip-bomb budget is a security boundary. Untrusted-input parsing belongs at the edge, not in the package beside the permission checker that every vertical depends on.

The split follows the bounds. The **output** cap (512 KiB of UTF-8, a quarter of a Durable Object row) protects the scope database, so the kernel enforces it on whatever an extractor returns, and an extractor that throws records `failed` rather than failing the job forever. The **input** and **inflate** caps protect the process doing the parsing, so they belong to the extractor package, and the kernel only asks the recorded size before fetching bytes.

What the kernel keeps is still the part only it can hold: text that leaves with its attachment by any delete path, never reaches a dump, and is only found through the same check `open` makes. That is the line D-1 and D-18 draw everywhere else — the kernel provides the guarantee, and the domain- or format-specific work plugs into it.
