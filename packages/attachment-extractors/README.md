# @substrat-run/attachment-extractors

The file-format parsers behind [Substrat](https://github.com/substrat-run/substrat)'s attachment
content search. They turn an uploaded file into plain text for the kernel to index.

**How content search works: https://substrat.net/concepts/reads#searching-inside-attachments**

## Why it is a separate package

The kernel indexes attachment text. It does not parse file formats (decision K-43). It owns
the text table and its full-text index, the extraction job, the outcome states, the output
cap and the permission-gated search, and defines one seam: `AttachmentExtractor`. Every
parser lives here, and neither the kernel nor an adapter imports this package. Whoever
constructs the host passes the extractors in.

A zip reader is handed hostile input by design, and its inflate budget is a security
boundary. Parsing untrusted files belongs at the edge, not beside the permission checker.

## Use

```ts
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';

const host = new SqliteScopeHost({ dir, attachmentExtractors: defaultAttachmentExtractors() });
```

A host with no extractor for a type records `unsupported`, with the reason. That makes "no
extractors" a valid configuration, not a broken one.

| Extractor | Reads |
|---|---|
| `textExtractor` | `text/*` other than HTML, and `.txt` `.md` `.csv` `.tsv` when the type says nothing |
| `htmlExtractor` | `text/html`, `application/xhtml+xml`: the visible text, each construct ended where a browser's tokenizer ends it; script, style, template content and comments dropped |
| `docxExtractor` | Word documents: the body, then footnotes, endnotes, headers and footers |
| `xlsxExtractor` | Spreadsheets: shared and inline strings, never a cell's number |
| `pptxExtractor` | Presentations: slides in order, then speaker notes |
| `pdfExtractor` | PDF: the text each page draws, in page order. Written for hostile input: decompression, the cross-reference chain, object counts and every kind of nesting are bounded, and an encrypted file is refused with that reason |

Nothing is OCR'd: a scanned PDF has no text layer and records `empty`.

## Structured spreadsheets

`readSpreadsheet({ body, filename, contentType, signal?, delimiter? })` is a host-facing
reader for CSV, TSV and XLSX import/diff tools. It returns `{ sheets, formulaCells }`, where
each sheet has a name and rows shaped `{ number, cells }`. Row numbers are one-based and
preserve gaps; missing XLSX cells are `null`. Values stay strings so `001`, large identifiers
and decimal spelling survive. Headers remain the first row; no header names or field mapping
are guessed. Quoted CSV separators, doubled quotes, embedded newlines, BOMs and explicit
charsets are supported. `delimiter: ';'` supports regional CSV; the default is comma for CSV
and tab for TSV.

This differs from the XLSX search extractor, which indexes words only. The structured reader
retains numeric cells, resolves shared strings and workbook worksheet relationships, and
uses cached formula results without evaluating them. `formulaCells > 0` warns a tool that
those values may be stale or absent. XLSX display styles, date serials, merged cells and
formulas are not interpreted. An error cell refuses the workbook. `.xls`, macros, external
worksheet relationships and XML declarations are unsupported.

It refuses files over 10 MiB, inflated XML over 16 MiB, and workbooks exceeding
`SPREADSHEET_LIMITS`: 32 sheets, 10,000 stored rows, 256 columns, 100,000 cells (including
sparse padding), 32,768 characters per cell or 2 Mi characters across cell values. Shared
string text is bounded too. It never returns a silently truncated import. Pass an abort
signal for the host's time budget; errors carry content-free reasons. The host still applies
domain validation and permissions before importing any row.

The HTML extractor **never indexes text the HTML parser keeps out of the rendered document**:
comments, `script`, `style`, the other elements whose content a browser does not render, and
`template` content. Where it does not model how a browser parses, it **under-indexes** rather
than guess. It indexes nothing inside a `select` or an inline `svg` or `math`, and nothing after
a `frameset` unless it can prove a browser ignores it (and an honoured frameset discards the
body, so what was read in it is dropped too). After such a context it resumes only where it is certain a browser ends
it, and otherwise indexes nothing more of the file. Its tests hold this against parse5, a
browser-grade HTML parser.

It follows the parser, not the renderer. It does not evaluate the `hidden` attribute, CSS or
interactive state (a closed `<details>`), so text those hide **is** indexed. That is never more
than a searcher can read: search is gated by the same read permission as opening the file.

## Bounds

The bounds that protect the parsing process live here. `maxInputBytes` (32 MiB) is declared to
the kernel, so an oversized file is refused before a byte is fetched. `maxInflatedBytes`
(16 MiB) caps what a zip may inflate to, across every part of one file. The bound that protects
the scope, 512 KiB of text per attachment, is the kernel's, and it applies to whatever an
extractor returns.

Every parser is a single forward scan over a capped input, so its CPU is bounded by the code
rather than the file. The kernel's time budget is cooperative. The parsers check the `signal`
they are handed and yield between zip entries and at least every `EXTRACTION_STRIDE` (the
kernel's, 256 K) units of work — every search included, so a single long comment or tag is
no exception — and an aborted extraction stops within one stride.

## License

AGPL-3.0-only.
