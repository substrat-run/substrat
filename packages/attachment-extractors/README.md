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

There is no PDF extractor yet, and nothing is OCR'd.

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
