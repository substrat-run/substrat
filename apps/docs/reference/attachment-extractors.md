# @substrat-run/attachment-extractors

The **file-format parsers** behind attachment content search. They turn an uploaded file into
plain text, and the kernel indexes that text.

## Why the kernel does not parse

The kernel indexes attachment text. It does not parse file formats. It owns everything that
happens to extracted text:

- the text table and its full-text index;
- the job that drives extraction;
- the outcome states (`pending`, `indexed`, `empty`, `unsupported`, `failed`);
- the output cap;
- the permission-gated search (see [Searching inside attachments](/concepts/reads#searching-inside-attachments)).

Every parser lives here, behind one seam, `AttachmentExtractor`. Neither the kernel nor an
adapter imports this package, and the repository's dependency lint refuses an import that
tries to.

Two reasons. Parsing is what would grow the kernel without bound: every format is a new
parser, and every parser fix would be a kernel release. And parsers are the riskiest code in
the feature. A zip reader is handed hostile input by design, and its inflate budget is a
security boundary. Parsing untrusted files belongs at the edge, not beside the permission
checker every vertical depends on.

## Use

Whoever constructs the host passes the extractors in:

```ts
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';

const host = new CloudflareScopeHost({
  /* … */
  attachmentExtractors: defaultAttachmentExtractors(),
});
```

A host given no extractor for a type records that type as `unsupported`, with the reason. So
"no extractors" is a valid configuration rather than a broken one: uploads still land and
stay searchable by filename, and their content is not indexed.

| Extractor | Reads |
|---|---|
| `textExtractor` | `text/*` other than HTML, and `.txt` `.md` `.csv` `.tsv` when the type says nothing |
| `htmlExtractor` | `text/html` and `application/xhtml+xml`, as the text a browser's parser puts in the rendered document. Each construct ends where a browser's HTML tokenizer ends it, so a `script` closes only at a complete `</script>`. Comments, `script`, `style`, `template` content and the other elements whose content a browser does not render are dropped, including an unclosed one cut off at the end of a file |
| `docxExtractor` | Word documents: the body, then footnotes, endnotes, headers and footers |
| `xlsxExtractor` | Spreadsheets: shared and inline strings, never a cell's number |
| `pptxExtractor` | Presentations: slides in order, then speaker notes |

The declared content type decides which extractor runs. The file extension is consulted only
when the type says nothing (`application/octet-stream`). There is no PDF extractor yet, and
nothing is OCR'd. A host can add its own extractor to the list, provided it meets the
`AttachmentExtractor` interface from `@substrat-run/kernel`.

### What the HTML extractor guarantees

It **never indexes text the HTML parser keeps out of the rendered document**: comments, `script`,
`style`, the other elements whose content a browser does not render, and everything inside a
`template`. Where it does not model how a browser parses, it indexes less instead of guessing.
It may **under-index** these contexts:

- **`select`**: nothing inside a select is indexed. Indexing resumes at the `</select>` a
  browser would act on. A tag at which a browser leaves the select early (`input`, `textarea`,
  a table tag, a nested `select`) ends indexing for the rest of the file.
- **Inline `svg` and `math`**: nothing inside is indexed. Indexing resumes after the closing
  tag only when the extractor is certain that is where a browser ends it, as for a typical
  icon. Otherwise, nothing after it is indexed either.
- **`frameset`**: nothing after one a browser honours is indexed.

These rules are checked against parse5, a browser-grade HTML parser, in the package's tests.

It follows the parser, not the renderer. It does not evaluate the `hidden` attribute, CSS (inline
or in a stylesheet) or interactive state such as a closed `<details>`, so text hidden that way
**is** indexed. That is never more than a searcher can read: attachment search is gated by the
same read permission as opening the file.

## Bounds

The bounds that protect the process doing the parsing live here:

- **`maxInputBytes`** (32 MiB): each extractor declares it to the kernel, which refuses a
  larger file on its recorded size before fetching a byte. The extractor checks it again on
  the bytes it is handed.
- **`maxInflatedBytes`** (16 MiB): a counter on the bytes the zip inflater actually produces,
  across every part of one file. An entry's declared size is never trusted, because a zip bomb
  is exactly a file that lies about it.

Every parser here is a single forward scan over a capped input, so its worst case is bounded
by the code, not the file. Text decodes at most 2 MiB. HTML decodes at most 8 MiB and scans
it once. An office file inflates at most 16 MiB and scans each part once.

The bounds that protect the scope are the kernel's, and they apply to whatever an extractor
returns:

- the output cap of 512 KiB of text per attachment;
- a time budget;
- a check on the shape of the result.

An extractor that throws, answers nonsense or runs past the budget records `failed`, and the
job doesn't retry it.

The time budget is **cooperative**. When it runs out, the kernel aborts the `signal` it handed
the extractor, and discards anything the extractor answers afterwards, so a late answer is
never indexed. The bundled parsers check that signal, and yield to the event loop, between
zip entries and at least every 256 K units of work (the kernel's `EXTRACTION_STRIDE`: a
character scanned or decoded, a byte inflated). That holds inside a single long comment, tag
or run of text too, because every search through one is cut to that window, so they stop
within one stride. Code that never yields cannot be stopped from inside the same isolate. A
host that needs a hard deadline on an uncooperative extractor can run its extractors in a
separate worker.
