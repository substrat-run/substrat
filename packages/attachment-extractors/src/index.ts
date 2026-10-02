/**
 * `@substrat-run/attachment-extractors` — the parsers behind the kernel's attachment
 * extractor seam (#1575, K-43).
 *
 * **The kernel indexes attachment text; it does not parse file formats** (K-43). It owns the
 * text table, its index, the job, the outcome states, the output cap and the gated search,
 * and defines one seam, `AttachmentExtractor`. Everything that reads a file FORMAT lives
 * here, and the kernel and the adapters never import this package (`lint:deps` refuses it):
 * whoever constructs the host passes `defaultAttachmentExtractors()` in, or a list of its
 * own. Untrusted-input parsing belongs at the edge, not beside the permission checker.
 *
 * Best-effort by content type, and explicit about what it does not do:
 *
 * - **text** (`text/*` other than HTML): decoded as the declared charset, UTF-8 otherwise.
 * - **html** (`text/html`, `application/xhtml+xml`): tags stripped; comments and `script` /
 *   `style` / `template` / `noscript` bodies dropped, an unclosed one through to the end;
 *   entities decoded.
 * - **docx / xlsx / pptx**: an OOXML file is a zip of XML parts, so this reads the zip's
 *   central directory, inflates only the parts that carry text, and keeps the text of
 *   their `t` elements. The inflate is the web-standard `DecompressionStream('deflate-raw')`,
 *   present in Node and workerd alike, so the whole format costs no dependency.
 * - **No PDF yet, and no OCR.** A host given no extractor for a type records `unsupported`
 *   with that reason — a legible outcome, never "indexed, no match".
 *
 * ## The bounds this package owns, and why
 *
 * The bounds that protect the PROCESS doing the parsing live here (K-43); the one that
 * protects the scope — the output cap — is the kernel's, enforced on whatever comes back.
 *
 * - `maxInputBytes` is declared on each extractor, so the kernel can refuse an oversized
 *   file on its RECORDED size before fetching a byte; each extractor checks it again.
 * - `maxInflatedBytes` is the zip-bomb cap: a counter on the bytes the inflater actually
 *   produces, across every part of one file. An entry's declared size is checked first as
 *   a cheap refusal, and never trusted, because a bomb is exactly a file that lies about it.
 *
 * A file that is not what it says, or breaks a bound, is answered `{ failed }` with a
 * content-free reason — never a throw, and never a quote of the file: the reason lands in
 * the scope, and the content it would quote is what the read gate protects.
 *
 * ## CPU, bounded by construction — and stoppable
 *
 * Every parser here is a LINEAR scan (no regular expression that can rescan from each
 * opener), over an input with a fixed cap, so the worst case is a property of the code rather
 * than of the file. Per format, at the default bounds:
 *
 * - **text**: one native decode of at most 4 × the kernel's output cap (2 MiB).
 * - **html**: one native decode of at most 16 × the output cap (8 MiB), one forward scan of
 *   it, one entity pass over what survives.
 * - **docx / xlsx / pptx**: the central directory (at most 20 000 entries), native inflate of
 *   at most `maxInflatedBytes` (16 MiB) in total, and one forward scan of each inflated part;
 *   parts stop being read once the text collected is twice the output cap.
 *
 * Each extractor honours the kernel's time budget cooperatively: it checks the `signal`, and
 * yields a turn of the event loop so the kernel's timer can fire, between zip entries and
 * every 256 KiB of inflate or scan progress — an aborted extraction answers
 * `{ failed: 'the extraction was aborted' }` within one such step.
 */
import type {
  AttachmentExtractor,
  AttachmentExtractorInput,
  AttachmentExtractorResult,
  ExtractionSignal,
} from '@substrat-run/kernel';

declare const TextDecoder: new (
  label?: string,
  options?: { fatal?: boolean; ignoreBOM?: boolean },
) => { decode(input?: Uint8Array): string };
// Web-standard and present in Node >= 18 and workerd; declared locally because the package
// builds without DOM typings, as the kernel declares `TextEncoder`.
declare const DecompressionStream: new (format: 'deflate-raw') => {
  readonly writable: {
    getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };
  };
  readonly readable: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
    };
  };
};

declare function setTimeout(fn: () => void, ms: number): unknown;

/** The bounds that protect the parsing process (K-43). */
export interface ExtractorBounds {
  /** Largest file an extractor will read, declared to the kernel and checked again here. */
  readonly maxInputBytes: number;
  /** Bytes the inflater may produce across every part of one file (the zip-bomb cap). */
  readonly maxInflatedBytes: number;
}

/**
 * The defaults. 16 MiB of inflated XML is far more than the text of any ordinary office
 * document, and small enough that decoding it fits a Worker's memory.
 */
export const DEFAULT_EXTRACTOR_BOUNDS: ExtractorBounds = {
  maxInputBytes: 32 * 1024 * 1024,
  maxInflatedBytes: 16 * 1024 * 1024,
};

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** `text/plain; charset=UTF-8` → `{ type: 'text/plain', charset: 'utf-8' }`. */
function parseContentType(contentType: string): { type: string; charset: string | null } {
  const [head, ...params] = contentType.split(';');
  let charset: string | null = null;
  for (const p of params) {
    const [k, v] = p.split('=');
    if (k?.trim().toLowerCase() === 'charset' && v) charset = v.trim().replace(/^"|"$/g, '').toLowerCase();
  }
  return { type: (head ?? '').trim().toLowerCase(), charset };
}

/**
 * Whether a file is this format: the declared type decides. The file name is consulted only
 * when the type says nothing (`application/octet-stream`, or absent), because a client that
 * knew better would have said so — and a name contradicting a specific type is not evidence
 * worth more than the type.
 */
function acceptsBy(types: (type: string) => boolean, extensions: readonly string[]) {
  return (contentType: string, filename: string): boolean => {
    const { type } = parseContentType(contentType);
    if (types(type)) return true;
    if (type !== '' && type !== 'application/octet-stream') return false;
    const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
    return ext !== undefined && extensions.includes(ext);
  };
}

/** Raised when a bound refuses the work. Distinct so the answer can say which bound. */
class ExtractionBoundExceeded extends Error {}

/** A file that is not what its type says, or is damaged. Carries a content-free reason. */
class MalformedInput extends Error {}

/** The kernel's budget ran out and aborted the signal: the extraction stops where it is. */
class ExtractionAborted extends Error {}

/**
 * How much work runs between two checks of the kernel's signal: 256 KiB of a parse's
 * progress, or of an entry's inflated output. Small enough that an abort is honoured within
 * a few milliseconds of parsing; large enough that the yields cost little.
 */
const STRIDE = 256 * 1024;

/** One turn of the event loop — a macrotask, so the kernel's timer can run before what follows. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Cooperation with the kernel's time budget (K-43): stop if the signal is aborted, and yield
 * a turn first so a timer that is due gets to abort it. Without the yield a long parse would
 * hold the thread and the timer would never run until it was over.
 */
async function checkpoint(signal: ExtractionSignal): Promise<void> {
  if (signal.aborted) throw new ExtractionAborted('the extraction was aborted');
  await nextTurn();
  if (signal.aborted) throw new ExtractionAborted('the extraction was aborted');
}

/** Decode bytes as text: a UTF-16 BOM wins, then a declared charset, then UTF-8. */
function decodeText(bytes: Uint8Array, charset: string | null): string {
  let label = charset ?? 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // An unknown label is the client's typo, not a reason to index nothing.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// -- HTML ----------------------------------------------------------------------------

/** The five entities XML itself defines — all an OOXML part may use by name. */
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The Latin-1 named entities, plus the XML five. Enough for prose in western languages. */
const NAMED_ENTITIES: Record<string, string> = (() => {
  const latin1 =
    'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn ' +
    'sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave ' +
    'Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
    'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN ' +
    'szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute ' +
    'icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml ' +
    'yacute thorn yuml';
  const map: Record<string, string> = { ...XML_ENTITIES };
  latin1.split(' ').forEach((name, i) => {
    map[name] = String.fromCharCode(0xa0 + i);
  });
  // A few typographic ones that turn up in pasted prose.
  Object.assign(map, {
    ndash: '–',
    mdash: '—',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    hellip: '…',
    euro: '€',
    bull: '•',
  });
  return map;
})();

/** `&amp;` `&#228;` `&#xE4;` → characters. An unknown name is left as written. */
function decodeEntities(text: string, named: Record<string, string>): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return named[ref] ?? whole;
  });
}

/** Elements whose start or end reads as a line break when the tags are stripped. */
const HTML_BLOCK = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'hr', 'title', 'dt', 'dd',
]);
/** Table cells: their boundary reads as a space, so neighbouring cells do not run together. */
const HTML_CELL = new Set(['td', 'th']);
/** Elements whose content is not text a reader sees, dropped with it. */
const HTML_RAW = new Set(['script', 'style', 'template', 'noscript']);

/** `<` starts a tag only before a letter, `/`, `!` or `?` — as a browser reads it. Else it is text. */
const startsTag = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 47 || code === 33 || code === 63;

/** The lower-cased element name of the tag whose body runs from `from` to `to`. */
function tagNameOf(s: string, from: number, to: number): string {
  let k = s[from] === '/' ? from + 1 : from;
  const start = k;
  while (k < to && /[A-Za-z0-9-]/.test(s[k]!)) k += 1;
  return s.slice(start, k).toLowerCase();
}

/**
 * The text a reader of the page would see — in ONE linear pass.
 *
 * A scanner rather than regular expressions, deliberately. `<[^>]*>` and `<!--[\s\S]*?-->` look
 * linear and are not: on a file of `<` with no `>` after it, or of `<!--` with no `-->`, every
 * opener rescans to the end, and an 8 MiB page of them is quadratic work no time budget can
 * cut short in time. Here every index moves forward only, so the work is bounded by the
 * input — and a pass this long checks the kernel's signal as it goes.
 *
 * Comments and `script`/`style`/`template`/`noscript` bodies are dropped, and an UNCLOSED one
 * runs to the end of the file: a browser treats everything after an unclosed `<script>` as
 * script, and a page cut off mid-script (the prefix decode makes that ordinary) must not
 * have its source indexed as prose. So does a tag cut off before its `>`.
 */
async function htmlText(html: string, signal: ExtractionSignal): Promise<string> {
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  let nextCheck = STRIDE;
  while (i < n) {
    if (i >= nextCheck) {
      await checkpoint(signal);
      nextCheck = i + STRIDE;
    }
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      out.push(' ');
      i = end + 3;
      continue;
    }
    if (!startsTag(html.charCodeAt(lt + 1))) {
      out.push('<');
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break;
    const name = tagNameOf(html, lt + 1, gt);
    if (html[lt + 1] !== '/' && HTML_RAW.has(name)) {
      // A literal search from here on: one pass, whether or not the closer exists.
      const closer = new RegExp(`</${name}`, 'gi');
      closer.lastIndex = gt + 1;
      const found = closer.exec(html);
      const end = found ? html.indexOf('>', found.index) : -1;
      if (end < 0) break;
      out.push(' ');
      i = end + 1;
      continue;
    }
    if (HTML_BLOCK.has(name)) out.push('\n');
    else if (HTML_CELL.has(name)) out.push(' ');
    i = gt + 1;
  }
  return decodeEntities(out.join(''), NAMED_ENTITIES);
}

// -- ZIP -----------------------------------------------------------------------------

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

/** More than any office file carries; past it the archive is something else. */
const MAX_ZIP_ENTRIES = 20_000;

/**
 * The central directory, read from the End Of Central Directory record backwards.
 *
 * ZIP64 is refused rather than half-read: an OOXML file needs it only past 4 GiB, which
 * is far beyond `maxInputBytes`, so meeting one means the file is not what it says.
 */
function zipEntries(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const minEocd = 22;
  if (zip.length < minEocd) throw new MalformedInput('not a zip archive');
  // The EOCD sits in the last 22 bytes plus at most a 65 535-byte comment.
  let eocd = -1;
  for (let i = zip.length - minEocd; i >= Math.max(0, zip.length - minEocd - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new MalformedInput('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new MalformedInput('zip64 archives are not read');
  }
  if (count > MAX_ZIP_ENTRIES) throw new ExtractionBoundExceeded(`the archive lists more than ${MAX_ZIP_ENTRIES} entries`);
  if (cdOffset + cdSize > zip.length) throw new MalformedInput('the zip central directory is out of range');
  const names = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > zip.length || view.getUint32(p, true) !== 0x02014b50) {
      throw new MalformedInput('the zip central directory is damaged');
    }
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    if (p + 46 + nameLength > zip.length) throw new MalformedInput('the zip central directory is damaged');
    entries.push({
      name: names.decode(zip.subarray(p + 46, p + 46 + nameLength)),
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      uncompressedSize: view.getUint32(p + 24, true),
      localHeaderOffset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** A per-file inflate budget, shared by every part one extraction reads. */
interface InflateBudget {
  remaining: number;
}

/**
 * One entry's bytes, inflated under the budget.
 *
 * The write is NOT awaited before reading: a `DecompressionStream` applies backpressure,
 * so awaiting the write of a chunk larger than its queue would wait for a reader that has
 * not started. The read loop counts what the inflater actually produces and cancels the
 * stream the moment the budget is spent.
 */
async function readEntry(
  zip: Uint8Array,
  entry: ZipEntry,
  budget: InflateBudget,
  signal: ExtractionSignal,
): Promise<Uint8Array> {
  if (entry.flags & 0x1) throw new MalformedInput('the archive is encrypted');
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const at = entry.localHeaderOffset;
  if (at + 30 > zip.length || view.getUint32(at, true) !== 0x04034b50) {
    throw new MalformedInput('a zip entry header is damaged');
  }
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new MalformedInput('a zip entry is out of range');
  const raw = zip.subarray(start, end);
  // The declared size is a cheap early refusal and nothing more — the counter below is the
  // guard, because a bomb is precisely an entry whose header lies.
  if (entry.uncompressedSize > budget.remaining) {
    throw new ExtractionBoundExceeded('the archive inflates past the extraction bound');
  }
  if (entry.method === 0) {
    budget.remaining -= raw.length;
    if (budget.remaining < 0) throw new ExtractionBoundExceeded('the archive inflates past the extraction bound');
    return raw;
  }
  if (entry.method !== 8) throw new MalformedInput('a zip entry uses an unsupported compression method');
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const writing = writer.write(raw).then(() => writer.close()).catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let nextCheck = STRIDE;
  try {
    for (;;) {
      let next: { done: boolean; value?: Uint8Array };
      try {
        next = await reader.read();
      } catch {
        throw new MalformedInput('a zip entry is not valid deflate data');
      }
      if (next.done) break;
      const chunk = next.value!;
      total += chunk.length;
      if (total > budget.remaining) {
        await reader.cancel().catch(() => {});
        throw new ExtractionBoundExceeded('the archive inflates past the extraction bound');
      }
      chunks.push(chunk);
      if (signal.aborted || total >= nextCheck) {
        nextCheck = total + STRIDE;
        try {
          await checkpoint(signal);
        } catch (err) {
          await reader.cancel().catch(() => {});
          throw err;
        }
      }
    }
  } finally {
    await writing;
  }
  budget.remaining -= total;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// -- OOXML ---------------------------------------------------------------------------

/** The index of the first `>` at or after `from` that is outside a quoted value, or -1. */
function tagEnd(s: string, from: number): number {
  let quote = 0;
  for (let k = from; k < s.length; k += 1) {
    const c = s.charCodeAt(k);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return k;
    }
  }
  return -1;
}

/** Whitespace, `/` or `>` ends an XML name. */
const endsName = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 62;

/**
 * Text out of an OOXML part: the content of every element whose LOCAL name is `t`.
 *
 * Matched by local name rather than prefix, because the prefix is the document's choice:
 * Word writes `w:t`, its text boxes `a:t`, its equations `m:t`, a spreadsheet's shared
 * strings a bare `t` — all of them text a person typed. `rPh` (phonetic guides in a
 * spreadsheet) is skipped whole, since its `t` repeats the cell it annotates. Paragraph-
 * like ends become newlines, so phrases do not run together across paragraphs.
 *
 * ONE linear pass, for the reason `htmlText` gives: a tokenizer regex with lazy `[\s\S]*?`
 * or an alternation over quoted values rescans to the end from every unclosed `<![CDATA[`,
 * `<!--` or quote, which a hostile part can repeat until the work is quadratic. Here every
 * index moves forward only; content after a construct that never closes is not text.
 */
async function ooxmlText(xml: string, signal: ExtractionSignal): Promise<string> {
  const out: string[] = [];
  const BREAK_AFTER = new Set(['p', 'si', 'row', 'tr']);
  const BREAK = new Set(['br', 'cr']);
  let inText = 0;
  let skip = 0;
  const emit = (text: string) => {
    if (inText > 0 && skip === 0) out.push(text);
  };
  const n = xml.length;
  let i = 0;
  let nextCheck = STRIDE;
  while (i < n) {
    if (i >= nextCheck) {
      await checkpoint(signal);
      nextCheck = i + STRIDE;
    }
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      emit(decodeEntities(xml.slice(i), XML_ENTITIES));
      break;
    }
    if (lt > i) emit(decodeEntities(xml.slice(i, lt), XML_ENTITIES));
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) break;
      emit(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    const gt = tagEnd(xml, lt + 1);
    if (gt < 0) break;
    i = gt + 1;
    if (xml[lt + 1] === '!') continue; // a declaration
    const closing = xml[lt + 1] === '/';
    const selfClosing = xml[gt - 1] === '/';
    const nameStart = closing ? lt + 2 : lt + 1;
    let nameEnd = nameStart;
    while (nameEnd < gt && !endsName(xml.charCodeAt(nameEnd))) nameEnd += 1;
    const qname = xml.slice(nameStart, nameEnd);
    const local = qname.slice(qname.indexOf(':') + 1);
    if (local === 'rPh') {
      if (!selfClosing) skip += closing ? -1 : 1;
      continue;
    }
    if (local === 't') {
      if (!selfClosing) inText += closing ? -1 : 1;
      continue;
    }
    if (local === 'tab' && selfClosing) out.push(' ');
    else if (BREAK.has(local) && (selfClosing || !closing)) out.push('\n');
    else if (BREAK_AFTER.has(local) && (closing || selfClosing)) out.push('\n');
  }
  return out.join('');
}

/** The parts of each format that carry text, in reading order — body first, so a cut keeps it. */
function ooxmlParts(extractor: 'docx' | 'xlsx' | 'pptx', entries: readonly ZipEntry[]): ZipEntry[] {
  const numbered = (re: RegExp) =>
    entries
      .map((e) => ({ e, n: re.exec(e.name) }))
      .filter((x): x is { e: ZipEntry; n: RegExpExecArray } => x.n !== null)
      .sort((a, b) => Number(a.n[1]) - Number(b.n[1]))
      .map((x) => x.e);
  const named = (name: string) => entries.filter((e) => e.name === name);
  switch (extractor) {
    case 'docx':
      return [
        ...named('word/document.xml'),
        ...named('word/footnotes.xml'),
        ...named('word/endnotes.xml'),
        ...numbered(/^word\/header(\d+)\.xml$/),
        ...numbered(/^word\/footer(\d+)\.xml$/),
      ];
    case 'xlsx':
      return [...named('xl/sharedStrings.xml'), ...numbered(/^xl\/worksheets\/sheet(\d+)\.xml$/)];
    case 'pptx':
      return [...numbered(/^ppt\/slides\/slide(\d+)\.xml$/), ...numbered(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/)];
  }
}

/** The part every file of the format has — its absence means the file is not that format. */
const REQUIRED_PART: Record<'docx' | 'xlsx' | 'pptx', RegExp> = {
  docx: /^word\/document\.xml$/,
  xlsx: /^xl\/workbook\.xml$/,
  pptx: /^ppt\/presentation\.xml$/,
};

async function ooxmlExtract(
  format: 'docx' | 'xlsx' | 'pptx',
  zip: Uint8Array,
  bounds: ExtractorBounds,
  maxTextBytes: number,
  signal: ExtractionSignal,
): Promise<{ text: string; truncated: boolean }> {
  const entries = zipEntries(zip);
  if (!entries.some((e) => REQUIRED_PART[format].test(e.name))) {
    throw new MalformedInput(`the archive is not a ${format} file`);
  }
  const budget: InflateBudget = { remaining: bounds.maxInflatedBytes };
  const decoder = new TextDecoder('utf-8');
  const pieces: string[] = [];
  // Stop reading parts once the collected text is safely past the kernel's output cap: the
  // rest could only be cut off again, and inflating it would spend the budget for nothing.
  // Twice the cap, because the kernel's normalizing can still shrink what was collected.
  let collected = 0;
  let stoppedEarly = false;
  for (const entry of ooxmlParts(format, entries)) {
    if (collected > maxTextBytes * 2) {
      stoppedEarly = true;
      break;
    }
    await checkpoint(signal);
    const text = await ooxmlText(decoder.decode(await readEntry(zip, entry, budget, signal)), signal);
    pieces.push(text, '\n');
    collected += text.length;
  }
  return { text: pieces.join(''), truncated: stoppedEarly };
}

/**
 * One extractor's `extract`: the input bound checked again (the kernel judged the recorded
 * size; this judges the bytes it was actually handed), and everything the FILE did turned
 * into a `failed` answer. A throw from anywhere else — an inflater the runtime lacks — is
 * left to the kernel, which records it as a failed extraction.
 */
function extractWith(
  bounds: ExtractorBounds,
  read: (input: AttachmentExtractorInput) => Promise<{ text: string; truncated: boolean }>,
): (input: AttachmentExtractorInput) => Promise<AttachmentExtractorResult> {
  return async (input) => {
    if (input.body.length > bounds.maxInputBytes) {
      return { failed: `the file is ${input.body.length} bytes, over the ${bounds.maxInputBytes}-byte input bound` };
    }
    try {
      return await read(input);
    } catch (err) {
      if (err instanceof MalformedInput || err instanceof ExtractionBoundExceeded || err instanceof ExtractionAborted) {
        return { failed: err.message };
      }
      throw err;
    }
  };
}

/**
 * Text and HTML decode only a PREFIX: the kernel keeps at most `maxTextBytes`, and markup or
 * padding shrinks by a few times. Decoding a 30 MB log to keep its first half-megabyte would
 * hold the whole file as a string for nothing.
 */
async function decodedPrefix(
  input: AttachmentExtractorInput,
  scanFactor: number,
  toText: (decoded: string, signal: ExtractionSignal) => string | Promise<string>,
): Promise<{ text: string; truncated: boolean }> {
  const scan = input.maxTextBytes * scanFactor;
  await checkpoint(input.signal);
  const decoded = decodeText(input.body.subarray(0, scan), parseContentType(input.contentType).charset);
  return { text: await toText(decoded, input.signal), truncated: input.body.length > scan };
}

/** `text/*` other than HTML — and `.txt`, `.md`, `.csv`, `.tsv` when the type says nothing. */
export function textExtractor(bounds: ExtractorBounds = DEFAULT_EXTRACTOR_BOUNDS): AttachmentExtractor {
  return {
    name: 'text',
    maxInputBytes: bounds.maxInputBytes,
    accepts: acceptsBy(
      (type) => type.startsWith('text/') && type !== 'text/html',
      ['txt', 'md', 'markdown', 'csv', 'tsv'],
    ),
    extract: extractWith(bounds, (input) => decodedPrefix(input, 4, (decoded) => decoded)),
  };
}

/** HTML and XHTML — the text a reader of the page would see. */
export function htmlExtractor(bounds: ExtractorBounds = DEFAULT_EXTRACTOR_BOUNDS): AttachmentExtractor {
  return {
    name: 'html',
    maxInputBytes: bounds.maxInputBytes,
    accepts: acceptsBy((type) => type === 'text/html' || type === 'application/xhtml+xml', ['html', 'htm']),
    extract: extractWith(bounds, (input) => decodedPrefix(input, 16, htmlText)),
  };
}

function ooxmlExtractor(format: 'docx' | 'xlsx' | 'pptx', mediaType: string, bounds: ExtractorBounds): AttachmentExtractor {
  return {
    name: format,
    maxInputBytes: bounds.maxInputBytes,
    accepts: acceptsBy((type) => type === mediaType, [format]),
    extract: extractWith(bounds, (input) => ooxmlExtract(format, input.body, bounds, input.maxTextBytes, input.signal)),
  };
}

/** Word documents: the body, then footnotes, endnotes, headers and footers. */
export const docxExtractor = (bounds: ExtractorBounds = DEFAULT_EXTRACTOR_BOUNDS) => ooxmlExtractor('docx', DOCX, bounds);
/** Spreadsheets: shared strings and inline strings — never a cell's number. */
export const xlsxExtractor = (bounds: ExtractorBounds = DEFAULT_EXTRACTOR_BOUNDS) => ooxmlExtractor('xlsx', XLSX, bounds);
/** Presentations: slides in order, then their speaker notes. */
export const pptxExtractor = (bounds: ExtractorBounds = DEFAULT_EXTRACTOR_BOUNDS) => ooxmlExtractor('pptx', PPTX, bounds);

/**
 * Every extractor this package has, in the order a host should try them — what a host is
 * constructed with when it has no list of its own:
 *
 *     new SqliteScopeHost({ dir, attachmentExtractors: defaultAttachmentExtractors() })
 */
export function defaultAttachmentExtractors(bounds: ExtractorBounds = DEFAULT_EXTRACTOR_BOUNDS): AttachmentExtractor[] {
  return [textExtractor(bounds), htmlExtractor(bounds), docxExtractor(bounds), xlsxExtractor(bounds), pptxExtractor(bounds)];
}
