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
 * - **html** (`text/html`, `application/xhtml+xml`): tags stripped, each construct ended where
 *   the HTML tokenizer ends it; comments, `script`, `style` and the other raw-text elements a
 *   browser hides, and `template` content, dropped — an unclosed one through to the end;
 *   entities decoded. **Its contract is conservative: it never indexes content a browser
 *   hides, and may under-index what it does not model** — inline SVG and MathML, `select`, a
 *   frameset — indexing nothing inside them, and nothing after one whose end it cannot be sure
 *   of (`htmlText` lists the rules).
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
 * - **text**: a decode of at most 4 × the kernel's output cap (2 MiB).
 * - **html**: a decode of at most 16 × the output cap (8 MiB), one forward scan of it, one
 *   entity pass over what survives.
 * - **docx / xlsx / pptx**: the central directory (at most 20 000 entries), inflate and decode
 *   of at most `maxInflatedBytes` (16 MiB) in total, and one forward scan of each inflated
 *   part; parts stop being read once the text collected is twice the output cap.
 *
 * Each extractor honours the kernel's time budget cooperatively (`Pace`): it checks the
 * `signal`, and yields a turn of the event loop so the kernel's timer can fire, between zip
 * entries and at least every `EXTRACTION_STRIDE` (the kernel's, 256 Ki) units of work. That
 * holds for every pass over the content — decoding, inflating, the zip directory, the entity
 * pass, and each search for a construct's end, a native `indexOf` included, which is cut to
 * the window left before the next check. An aborted extraction answers
 * `{ failed: 'the extraction was aborted' }` within one stride. The steps between two checks
 * that are NOT cut to a stride are copies (joining the text collected) and the name tests
 * over the zip directory, at most 20 000 names of at most 255 bytes each.
 */
import {
  EXTRACTION_STRIDE,
  type AttachmentExtractor,
  type AttachmentExtractorInput,
  type AttachmentExtractorResult,
  type ExtractionSignal,
} from '@substrat-run/kernel';

interface Decoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}
declare const TextDecoder: new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) => Decoder;
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

const runtime = globalThis as { setImmediate?: (fn: () => void) => unknown };

/**
 * One turn of the event loop, by the cheapest primitive that still lets a due timer — the
 * kernel's deadline — run before what follows. Every yield the parsers make comes through here.
 *
 * `setImmediate` where the runtime has it (Node, and workerd, which has it as a global): it goes
 * once round the loop, through the timers, without the 1 ms floor Node puts under
 * `setTimeout(…, 0)` — the floor that made pacing a large file cost more in waiting than in
 * parsing. `setTimeout(…, 0)` otherwise. Not `scheduler.yield()`: neither runtime has it, and
 * where it exists its continuation is scheduled AHEAD of other tasks, which is the opposite of
 * letting a timer in. Called through the global each time, never as a detached reference.
 */
const nextTurn: () => Promise<void> =
  typeof runtime.setImmediate === 'function'
    ? () => new Promise((resolve) => void runtime.setImmediate!(resolve))
    : () => new Promise((resolve) => setTimeout(resolve, 0));

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

/**
 * One extraction's pacing against the kernel's budget. Work is counted in units — a character
 * scanned or decoded, a byte inflated or decoded — and no step runs more than
 * `EXTRACTION_STRIDE` of them past the last `checkpoint`, give or take the few characters a
 * search must see whole (a needle's length, an entity's span). A native search goes through `find`,
 * which cuts it to the window left before the next check, and a hand-written loop through
 * `scan`; that is what makes "stops within one stride" true of an `indexOf` across a long run
 * of text, a comment or an unclosed tag, and not only of the loop around it.
 */
class Pace {
  private left = EXTRACTION_STRIDE;

  constructor(private readonly signal: ExtractionSignal) {}

  /** Units that may still run before the next check — positive once `turn` has returned. */
  get room(): number {
    return this.left;
  }

  charge(units: number): void {
    this.left -= units;
  }

  /** Stop if the signal is aborted; once a stride is spent, yield a turn and check again. */
  async turn(): Promise<void> {
    if (this.left > 0 && !this.signal.aborted) return;
    await checkpoint(this.signal);
    this.left = EXTRACTION_STRIDE;
  }

  /** `s.indexOf(needle, from)`, searched one window at a time. */
  async find(s: string, needle: string, from: number): Promise<number> {
    for (let at = from; at < s.length; ) {
      await this.turn();
      const end = Math.min(s.length, at + this.left);
      // Each window reaches a needle's length less one into the next, so a match that
      // straddles the edge is found whole — and found in exactly one window.
      const k = s.slice(at, end + needle.length - 1).indexOf(needle);
      if (k >= 0) {
        this.charge(k + needle.length);
        return at + k;
      }
      this.charge(end - at);
      at = end;
    }
    return -1;
  }

  /** Visit `s` from `from`; `step(c, k)` returns true to stop at `k`. The index stopped at, or -1. */
  async scan(s: string, from: number, step: (c: number, k: number) => boolean): Promise<number> {
    for (let k = from; k < s.length; ) {
      await this.turn();
      const start = k;
      const end = Math.min(s.length, k + this.left);
      for (; k < end; k += 1) {
        if (step(s.charCodeAt(k), k)) {
          this.charge(k + 1 - start);
          return k;
        }
      }
      this.charge(end - start);
    }
    return -1;
  }

  /** Bytes through `decoder` a window at a time; `stream` keeps a character cut by an edge whole. */
  async decode(decoder: Decoder, bytes: Uint8Array, out: string[]): Promise<void> {
    for (let at = 0; at < bytes.length; ) {
      await this.turn();
      const end = Math.min(bytes.length, at + this.left);
      out.push(decoder.decode(bytes.subarray(at, end), { stream: true }));
      this.charge(end - at);
      at = end;
    }
  }
}

/** Decode bytes as text: a UTF-16 BOM wins, then a declared charset, then UTF-8. */
async function decodeText(bytes: Uint8Array, charset: string | null, pace: Pace): Promise<string> {
  let label = charset ?? 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  let decoder: Decoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    // An unknown label is the client's typo, not a reason to index nothing.
    decoder = new TextDecoder('utf-8');
  }
  const out: string[] = [];
  await pace.decode(decoder, bytes, out);
  out.push(decoder.decode());
  return out.join('');
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

/**
 * How far before a window's edge the entity pass looks for an `&` to end the window at, so a
 * reference is not cut in two. Every named reference and `&#x10FFFF;` is shorter; a longer one
 * (only leading zeros make one) that straddles an edge is left as written.
 */
const ENTITY_SPAN = 32;

/**
 * `&amp;` `&#228;` `&#xE4;` → characters, a window at a time. An unknown name is left as
 * written. The pattern is linear — each `&` is tried once against the run that follows it.
 */
async function decodeEntities(text: string, named: Record<string, string>, pace: Pace): Promise<string> {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    await pace.turn();
    // At least two spans, however little room is left: a window that began at an `&` and was
    // shorter than its reference would cut it with no `&` behind the cut to back off to.
    let end = Math.min(text.length, at + Math.max(pace.room, 2 * ENTITY_SPAN));
    if (end < text.length) {
      const edge = end - ENTITY_SPAN;
      const amp = text.slice(edge, end).lastIndexOf('&');
      if (amp >= 0) end = edge + amp;
    }
    out.push(
      text.slice(at, end).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, ref: string) => {
        if (ref[0] === '#') {
          const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return named[ref] ?? whole;
      }),
    );
    pace.charge(end - at);
    at = end;
  }
  return out.join('');
}

/** Elements whose start or end reads as a line break when the tags are stripped. */
const HTML_BLOCK = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'hr', 'title', 'dt', 'dd',
]);
/** Table cells: their boundary reads as a space, so neighbouring cells do not run together. */
const HTML_CELL = new Set(['td', 'th']);
/**
 * Raw-text elements a reader never sees: the tokenizer reads their content as text up to
 * their own end tag, and a browser does not render it. (`noscript` is raw text when scripting
 * is on, as it is in every browser a page is opened in.) `script` is raw text too, with
 * escape rules of its own — `scriptEnd`.
 */
const HTML_HIDDEN_RAW = new Set(['style', 'noscript', 'iframe', 'noembed', 'noframes']);
/**
 * Elements whose content the tokenizer also reads as TEXT up to their own end tag, but a
 * browser SHOWS: `title` and `textarea` are RCDATA (entities decoded), `xmp` is RAWTEXT (shown
 * as written). Markup inside them is text, so a `</template>` there closes nothing — and
 * inside a template, their content is as hidden as the rest of it. (`plaintext` is the last
 * of the kind: everything after it is text, to the end of the file.)
 */
const HTML_SHOWN_RCDATA = new Set(['title', 'textarea']);
const HTML_SHOWN_RAWTEXT = new Set(['xmp']);

/** The longest element name this scanner acts on (`blockquote`); a longer one is just a tag. */
const HTML_NAME_MAX = 10;

const isAsciiAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** The tokenizer's whitespace (tab, LF, FF, CR, space). */
const isHtmlSpace = (c: number): boolean => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
/** What ends a tag name, for the tokenizer: whitespace, `/` or `>` — nothing else. */
const endsTagName = (c: number): boolean => isHtmlSpace(c) || c === 47 || c === 62;

/**
 * Whether the tag name `name` (lower case) is spelled at `at` and ENDS there — ASCII case
 * folded, then whitespace, `/` or `>` — which is the tokenizer's test for an end tag that
 * closes a raw-text element. `</scripture>` and `</script-x>` spell `script` and close
 * nothing; `</SCRIPT >` closes it. A name running into the end of the file closes nothing.
 */
function namedAt(s: string, at: number, name: string): boolean {
  if (at + name.length >= s.length) return false;
  for (let j = 0; j < name.length; j += 1) {
    // `| 0x20` folds A–Z onto a–z, and maps nothing else onto a lower-case letter.
    if ((s.charCodeAt(at + j) | 0x20) !== name.charCodeAt(j)) return false;
  }
  return endsTagName(s.charCodeAt(at + name.length));
}

/** The tag name at `at`, ASCII lower-cased — or '' when it is longer than any name acted on. */
function shortTagName(s: string, at: number): string {
  let k = at;
  while (k < s.length && k - at <= HTML_NAME_MAX && !endsTagName(s.charCodeAt(k))) k += 1;
  if (k - at > HTML_NAME_MAX) return '';
  return s.slice(at, k).replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

// The tokenizer's states inside a tag, as far as finding its end needs them: its self-closing
// and after-quoted-value states end a tag and begin an attribute exactly as "before attribute
// name" does, so they share its number.
const TAG_NAME = 0;
const BEFORE_ATTR = 1;
const ATTR_NAME = 2;
const AFTER_ATTR = 3;
const BEFORE_VALUE = 4;
const UNQUOTED = 5;
const QUOTED = 6;

/**
 * The `>` that ends the tag whose name starts at `from`, or -1 — by the HTML tokenizer's own
 * states, so a `>` inside a quoted attribute value ends nothing (`<a title="x > y">`), while
 * a quote that opens no value (`<a "x>`) is just a character.
 *
 * `flags.selfClosing` says whether the tokenizer set the tag's self-closing flag: a `/` met
 * outside a value, right before the `>`. `<svg/>` sets it; `<svg a=b/>` does not, because that
 * `/` is part of the unquoted value — a difference that decides whether foreign content opened.
 */
function htmlTagEnd(s: string, from: number, pace: Pace, flags?: { selfClosing: boolean }): Promise<number> {
  let state = TAG_NAME;
  let quote = 0;
  let slash = false;
  return pace.scan(s, from, (c) => {
    if (state === QUOTED) {
      slash = false;
      if (c === quote) state = BEFORE_ATTR;
      return false;
    }
    if (c === 62) {
      if (flags) flags.selfClosing = slash;
      return true;
    }
    const space = isHtmlSpace(c);
    // The tokenizer's self-closing start tag state is entered by a `/` outside a value.
    slash = c === 47 && state !== BEFORE_VALUE && state !== UNQUOTED;
    switch (state) {
      case TAG_NAME:
        if (space || c === 47) state = BEFORE_ATTR;
        break;
      case BEFORE_ATTR:
        if (!space && c !== 47) state = ATTR_NAME; // an `=` here starts a NAME, not a value
        break;
      case ATTR_NAME:
        if (space) state = AFTER_ATTR;
        else if (c === 47) state = BEFORE_ATTR;
        else if (c === 61) state = BEFORE_VALUE;
        break;
      case AFTER_ATTR:
        if (c === 47) state = BEFORE_ATTR;
        else if (c === 61) state = BEFORE_VALUE;
        else if (!space) state = ATTR_NAME;
        break;
      case BEFORE_VALUE:
        if (c === 34 || c === 39) {
          state = QUOTED;
          quote = c;
        } else if (!space) state = UNQUOTED;
        break;
      case UNQUOTED:
        if (space) state = BEFORE_ATTR;
        break;
    }
    return false;
  });
}

/**
 * The `>` that ends the comment opened at `lt`, or -1. As the tokenizer reads one: `-->` ends
 * it, so does `--!>`, and so do the abrupt `<!-->` and `<!--->` — which is why the search for
 * `-->` may overlap the opener's own dashes, and the one for `--!>` may not.
 */
async function commentEnd(s: string, lt: number, pace: Pace): Promise<number> {
  for (let p = lt + 2; ; ) {
    const k = await pace.find(s, '--', p);
    if (k < 0) return -1;
    if (s.charCodeAt(k + 2) === 62) return k + 2;
    if (k >= lt + 4 && s.charCodeAt(k + 2) === 33 && s.charCodeAt(k + 3) === 62) return k + 3;
    p = k + 1;
  }
}

/** Where the end tag closing a raw-text element's content starts (`</style …`), or -1. */
async function rawTextEnd(s: string, from: number, name: string, pace: Pace): Promise<number> {
  for (let k = from; ; ) {
    const lt = await pace.find(s, '</', k);
    if (lt < 0 || namedAt(s, lt + 2, name)) return lt;
    k = lt + 2;
  }
}

const closesScript = (s: string, lt: number): boolean => s.charCodeAt(lt + 1) === 47 && namedAt(s, lt + 2, 'script');

/**
 * Where the `</script` closing a script's content starts, or -1 — by the tokenizer's script
 * data states. Only a complete `</script` closes it; and after a `<!--` inside the script, a
 * `<script` there makes the next `</script` close only that, until `-->` (the "double escaped"
 * state, which a browser honours: `<script><!--<script></script>still script</script>`).
 */
async function scriptEnd(s: string, from: number, pace: Pace): Promise<number> {
  for (let k = from; ; ) {
    const lt = await pace.find(s, '<', k);
    if (lt < 0 || closesScript(s, lt)) return lt;
    if (!s.startsWith('<!--', lt)) {
      k = lt + 1;
      continue;
    }
    // Escaped (after `<!--`), and double escaped (after a `<script` in that) — back to plain
    // script data at the next `-->`.
    let double = false;
    let dashes = 2;
    let closer = -1;
    const back = await pace.scan(s, lt + 4, (c, j) => {
      if (c === 45) {
        dashes += 1;
        return false;
      }
      if (c === 62 && dashes >= 2) return true;
      dashes = 0;
      if (c !== 60) return false;
      if (double) {
        if (closesScript(s, j)) double = false;
      } else if (closesScript(s, j)) {
        closer = j;
        return true;
      } else if (namedAt(s, j + 1, 'script')) {
        double = true;
      }
      return false;
    });
    if (back < 0 || closer >= 0) return closer;
    k = back + 1;
  }
}

/**
 * Start tags at which a browser leaves foreign content wherever it is (`font` only with certain
 * attributes — here, conservatively, always). `</br>` and `</p>` do the same as end tags.
 */
const FOREIGN_BREAKOUT = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta',
  'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table',
  'tt', 'u', 'ul', 'var', 'font',
]);
/**
 * Foreign elements inside which a start tag is parsed as HTML — SVG's HTML integration points
 * and MathML's text integration points, with `annotation-xml` counted whatever its encoding.
 */
const INTEGRATION_POINTS = new Set(['foreignobject', 'desc', 'title', 'mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml']);
/**
 * In a select, the start tags at which a browser leaves it early. After one, the scanner can no
 * longer be sure what a browser shows, so nothing more of the file is indexed. (Every other
 * start tag in a select — `svg`, `frameset`, `plaintext` included — a browser ignores.)
 */
const SELECT_LEAVES = new Set([
  'select', 'input', 'keygen', 'textarea', 'caption', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'td', 'th',
]);
/**
 * Start tags that always clear a browser's frameset-ok flag, after which it ignores a
 * `<frameset>` (`input` is not here: a hidden one leaves the flag alone).
 */
const CLEARS_FRAMESET_OK = new Set([
  'select', 'textarea', 'xmp', 'iframe', 'table', 'img', 'hr', 'li', 'dd', 'dt', 'pre', 'listing',
  'button', 'br', 'embed', 'wbr', 'area', 'keygen', 'applet', 'marquee', 'object',
]);
/** How far into a run of text the scanner looks for proof that the frameset-ok flag is cleared. */
const FRAMESET_PROOF_SPAN = 256;
/** In a select inside a table, the end tags that close the select early. */
const SELECT_TABLE_ENDS = new Set(['caption', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'td', 'th']);

/** The longest foreign element name followed; a longer one makes the region uncertain. */
const FOREIGN_NAME_MAX = 64;

/** A tag name in foreign content, ASCII lower-cased — '' when longer than any followed. */
function foreignName(s: string, at: number): string {
  let k = at;
  while (k < s.length && k - at <= FOREIGN_NAME_MAX && !endsTagName(s.charCodeAt(k))) k += 1;
  if (k - at > FOREIGN_NAME_MAX) return '';
  return s.slice(at, k).replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Where a foreign-content region — an `<svg>` or `<math>` and everything in it — ends: the index
 * just past the `>` of the end tag that closes its root, or -1 when the scanner cannot be SURE
 * that is where a browser ends it. The caller indexes nothing in the region, and after a -1,
 * nothing more of the file.
 *
 * Inside foreign content a browser tokenizes differently — no raw text, real CDATA sections, no
 * template contents — and its tree builder can leave the region early (a breakout tag, an end
 * tag only HTML rules match) or late (an end tag ignored inside HTML content an integration point
 * holds). So the region is followed only while every token in it is one whose effect is certain:
 * text, comments, CDATA, foreign start tags (self-closing honoured), and end tags that close an
 * element open in the region. A breakout tag, a start tag inside an integration point, or an
 * end tag matching nothing open is the browser leaving the rules followed here — and -1.
 */
async function foreignEnd(s: string, from: number, root: string, pace: Pace): Promise<number> {
  const open = [root];
  const flags = { selfClosing: false };
  for (let i = from; ; ) {
    const lt = await pace.find(s, '<', i);
    if (lt < 0) return -1;
    const next = s.charCodeAt(lt + 1);
    if (next === 33 && s.startsWith('--', lt + 2)) {
      const end = await commentEnd(s, lt, pace);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const end = await pace.find(s, ']]>', lt + 9); // a real CDATA section, in foreign content
      if (end < 0) return -1;
      i = end + 3;
      continue;
    }
    if (next === 33 || next === 63 || (next === 47 && !isAsciiAlpha(s.charCodeAt(lt + 2)))) {
      const end = await pace.find(s, '>', lt + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (!isAsciiAlpha(next) && next !== 47) {
      i = lt + 1;
      continue;
    }
    const closing = next === 47;
    const nameAt = closing ? lt + 2 : lt + 1;
    const name = foreignName(s, nameAt);
    if (name === '') return -1;
    if (closing ? name === 'br' || name === 'p' : FOREIGN_BREAKOUT.has(name) || INTEGRATION_POINTS.has(open[open.length - 1]!)) {
      return -1;
    }
    flags.selfClosing = false;
    const gt = await htmlTagEnd(s, nameAt, pace, flags);
    if (gt < 0) return -1;
    i = gt + 1;
    if (!closing) {
      if (!flags.selfClosing) open.push(name);
      continue;
    }
    // An end tag pops to the nearest open element of its name; one that matches nothing open
    // falls through to the HTML rules, which this scanner does not follow from here.
    const at = open.lastIndexOf(name);
    if (at < 0) return -1;
    open.length = at;
    if (at === 0) return i;
  }
}

/**
 * Raw text (`xmp`, `plaintext`) is shown as written, so its `&` must survive the entity pass:
 * escaped here, a window at a time, and turned back into itself there.
 */
async function asWritten(text: string, pace: Pace): Promise<string> {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    await pace.turn();
    const end = Math.min(text.length, at + pace.room);
    out.push(text.slice(at, end).replaceAll('&', '&amp;'));
    pace.charge(end - at);
    at = end;
  }
  return out.join('');
}

/**
 * The text a reader of the page would see — in ONE linear pass.
 *
 * A scanner rather than regular expressions, deliberately. `<[^>]*>` and `<!--[\s\S]*?-->` look
 * linear and are not: on a file of `<` with no `>` after it, or of `<!--` with no `-->`, every
 * opener rescans to the end, and an 8 MiB page of them is quadratic work no time budget can
 * cut short in time. Here every index moves forward only, so the work is bounded by the
 * input — and every search in it is paced (`Pace`), so a pass this long checks the kernel's
 * signal as it goes, inside one long comment or tag as much as between short ones.
 *
 * Every construct ends where the HTML tokenizer ends it: a tag at a `>` outside a quoted
 * value, a comment at `-->` / `--!>` (or the abrupt `<!-->`), `script` by its escape rules,
 * and every element whose content the tokenizer reads as text — RAWTEXT, RCDATA, `plaintext` —
 * only at a COMPLETE end tag of its own name, nothing inside it acting as markup. Comments,
 * `script`, the hidden raw-text elements and everything inside `template` are dropped;
 * `title`, `textarea`, `xmp` and `plaintext` content is text, shown unless a template holds
 * it. Anything left UNCLOSED runs to the end of the file: a browser treats everything after
 * an unclosed `<script>` as script, and a page cut off mid-script (the prefix decode makes
 * that ordinary) must not have its source indexed as prose. So does a tag cut off before its
 * `>`. `test/html-oracle.test.ts` holds this against parse5, a browser-grade parser.
 *
 * **The contract is conservative: never index what a browser hides; index less where unsure.**
 * Some contexts change how a browser parses in ways this scanner does not follow, and there it
 * indexes NOTHING rather than guess:
 *
 * - **`select`** — the tree builder ignores almost every start tag inside one, so a `title` or
 *   `style` there switches nothing: only `script` and `template` change how it tokenizes. The
 *   scanner follows exactly that, indexes nothing, and stops at the `</select>` a browser
 *   would; a tag at which a browser leaves the select early (`input`, `textarea`, a table
 *   tag, a nested `select`, …) ends indexing for the rest of the file.
 * - **inline `svg` and `math`** — foreign content: no raw text, real CDATA, its own way out
 *   (`foreignEnd`). Nothing in the region is indexed, and if the scanner cannot be sure where a
 *   browser ends the region, nothing after it either.
 * - **`frameset`** — a honoured one leaves no body to show, so nothing after it is indexed. A
 *   browser honours one only while its frameset-ok flag is set; once the scanner has PROOF
 *   the flag is cleared (text that is surely not whitespace, or a start tag that always
 *   clears it) or a template is open, it knows the frameset is ignored, and reads on.
 * - any of these opened inside a `select` — nothing more of the file.
 *
 * So those contexts may be under-indexed, and their text after them too; nothing a browser
 * hides is ever indexed. The oracle holds both halves: over-indexing fails anywhere, and
 * under-indexing is allowed only from the first such context on.
 */
async function htmlText(html: string, pace: Pace): Promise<string> {
  const out: string[] = [];
  const n = html.length;
  // Open `template` elements: their content is parsed as usual and shown nowhere.
  let hidden = 0;
  // The template depth a `select` was opened at, or -1: nothing is indexed inside one.
  let selectAt = -1;
  const shown = () => hidden === 0 && selectAt < 0;
  const text = (from: number, to: number) => {
    if (shown() && to > from) out.push(html.slice(from, to));
  };
  const flags = { selfClosing: false };
  // Whether a browser has certainly cleared its frameset-ok flag, so that it ignores a
  // `<frameset>`. Only proof counts: the first character of a text run that is not whitespace
  // or NUL — within a short span, and not an `&`, so no character reference can turn it into
  // whitespace — or a start tag that always clears it.
  let framesetIgnored = false;
  const noteText = (from: number, to: number) => {
    if (framesetIgnored) return;
    const end = Math.min(to, from + FRAMESET_PROOF_SPAN);
    for (let k = from; k < end; k += 1) {
      const c = html.charCodeAt(k);
      if (isHtmlSpace(c) || c === 0) continue;
      framesetIgnored = c !== 38; // `&` proves nothing: it may decode to whitespace
      return;
    }
  };
  let i = 0;
  while (i < n) {
    const lt = await pace.find(html, '<', i);
    if (lt < 0) {
      text(i, n);
      break;
    }
    text(i, lt);
    noteText(i, lt);
    const next = html.charCodeAt(lt + 1);
    if (next === 33 && html.startsWith('--', lt + 2)) {
      const end = await commentEnd(html, lt, pace);
      if (end < 0) break;
      out.push(' ');
      i = end + 1;
      continue;
    }
    if (next === 33 || next === 63 || (next === 47 && !isAsciiAlpha(html.charCodeAt(lt + 2)))) {
      // `<!DOCTYPE …>`, `<?…>`, `</ …>`: a bogus comment, to the first `>`.
      const end = await pace.find(html, '>', lt + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (!isAsciiAlpha(next) && next !== 47) {
      text(lt, lt + 1); // `<` before anything else is text, as a browser reads it
      framesetIgnored = true;
      i = lt + 1;
      continue;
    }
    const closing = next === 47;
    const nameAt = closing ? lt + 2 : lt + 1;
    const name = shortTagName(html, nameAt);
    flags.selfClosing = false;
    const gt = await htmlTagEnd(html, nameAt, pace, flags);
    if (gt < 0) break;
    i = gt + 1;
    if (!closing && CLEARS_FRAMESET_OK.has(name)) framesetIgnored = true;
    if (selectAt >= 0 && hidden === selectAt) {
      // In the select itself: every tag but these is ignored by a browser and switches nothing.
      if (closing && name === 'select') {
        selectAt = -1;
        continue;
      }
      if (closing && name === 'template') {
        // Closing the template the select sits in closes the select with it; with no template
        // open, a browser ignores it.
        if (hidden > 0) {
          hidden -= 1;
          selectAt = -1;
        }
        continue;
      }
      if (closing ? SELECT_TABLE_ENDS.has(name) : SELECT_LEAVES.has(name)) break;
      if (!closing && name === 'template') {
        hidden += 1; // a template's content is parsed by the HTML rules again
      } else if (!closing && name === 'script') {
        const close = await scriptEnd(html, i, pace);
        const end = close < 0 ? -1 : await htmlTagEnd(html, close + 2, pace);
        if (end < 0) break;
        i = end + 1;
      }
      continue;
    }
    if (name === 'select') {
      // One opened inside a select's template is a select within a select: unsure from here.
      if (!closing && selectAt >= 0) break;
      if (!closing) selectAt = hidden;
      continue;
    }
    if (name === 'template') {
      hidden = closing ? Math.max(0, hidden - 1) : hidden + 1;
      continue;
    }
    if (!closing && (name === 'svg' || name === 'math' || name === 'frameset')) {
      // Contexts the scanner does not model (see above): nothing inside is indexed — and where
      // it cannot be sure a browser has left one, nothing more of the file.
      if (selectAt >= 0) break;
      if (name === 'frameset') {
        if (hidden > 0 || framesetIgnored) continue; // a browser ignores it
        break;
      }
      if (flags.selfClosing) continue; // `<svg/>` opens and closes at once
      const end = await foreignEnd(html, i, name, pace);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (!closing && name === 'plaintext') {
      // Everything after it is text, shown as written: there is no end tag to look for.
      if (shown()) out.push('\n', await asWritten(html.slice(i), pace));
      break;
    }
    const shownRcdata = HTML_SHOWN_RCDATA.has(name);
    const shownRaw = HTML_SHOWN_RAWTEXT.has(name);
    if (!closing && (name === 'script' || HTML_HIDDEN_RAW.has(name) || shownRcdata || shownRaw)) {
      // Read to the end tag as ONE unit: nothing inside — a `</template>`, a `<!--` — is markup.
      const close = name === 'script' ? await scriptEnd(html, i, pace) : await rawTextEnd(html, i, name, pace);
      const to = close < 0 ? n : close;
      if (shown()) {
        const edge = HTML_BLOCK.has(name) ? '\n' : ' ';
        out.push(edge);
        if (shownRcdata) out.push(html.slice(i, to)); // RCDATA: decoded with the rest
        else if (shownRaw) out.push(await asWritten(html.slice(i, to), pace));
        out.push(edge);
      }
      const end = close < 0 ? -1 : await htmlTagEnd(html, close + 2, pace);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (!shown()) continue;
    if (HTML_BLOCK.has(name)) out.push('\n');
    else if (HTML_CELL.has(name)) out.push(' ');
  }
  return decodeEntities(out.join(''), NAMED_ENTITIES, pace);
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
 * The longest entry name kept. Every part this package reads has a short fixed name, so a
 * longer one is never one of them — and capping it bounds the name tests over the directory.
 */
const MAX_ENTRY_NAME = 255;

/**
 * The central directory, read from the End Of Central Directory record backwards.
 *
 * ZIP64 is refused rather than half-read: an OOXML file needs it only past 4 GiB, which
 * is far beyond `maxInputBytes`, so meeting one means the file is not what it says.
 */
async function zipEntries(zip: Uint8Array, pace: Pace): Promise<ZipEntry[]> {
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
    await pace.turn();
    if (p + 46 > zip.length || view.getUint32(p, true) !== 0x02014b50) {
      throw new MalformedInput('the zip central directory is damaged');
    }
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    if (p + 46 + nameLength > zip.length) throw new MalformedInput('the zip central directory is damaged');
    entries.push({
      name: nameLength > MAX_ENTRY_NAME ? '' : names.decode(zip.subarray(p + 46, p + 46 + nameLength)),
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      uncompressedSize: view.getUint32(p + 24, true),
      localHeaderOffset: view.getUint32(p + 42, true),
    });
    const span = 46 + nameLength + extraLength + commentLength;
    pace.charge(span);
    p += span;
  }
  return entries;
}

/** A per-file inflate budget, shared by every part one extraction reads. */
interface InflateBudget {
  remaining: number;
}

/**
 * One entry's text: inflated under the budget, and decoded as UTF-8 as the inflater produces
 * it — a window at a time, so neither step holds the thread for more than a stride.
 *
 * The write is NOT awaited before reading: a `DecompressionStream` applies backpressure,
 * so awaiting the write of a chunk larger than its queue would wait for a reader that has
 * not started. The read loop counts what the inflater actually produces and cancels the
 * stream the moment the budget is spent.
 */
async function readEntryText(zip: Uint8Array, entry: ZipEntry, budget: InflateBudget, pace: Pace): Promise<string> {
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
  const decoder = new TextDecoder('utf-8');
  const text: string[] = [];
  if (entry.method === 0) {
    budget.remaining -= raw.length;
    if (budget.remaining < 0) throw new ExtractionBoundExceeded('the archive inflates past the extraction bound');
    await pace.decode(decoder, raw, text);
    text.push(decoder.decode());
    return text.join('');
  }
  if (entry.method !== 8) throw new MalformedInput('a zip entry uses an unsupported compression method');
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const writing = writer.write(raw).then(() => writer.close()).catch(() => {});
  const reader = ds.readable.getReader();
  let total = 0;
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
      try {
        await pace.decode(decoder, chunk, text);
      } catch (err) {
        await reader.cancel().catch(() => {});
        throw err;
      }
    }
  } finally {
    await writing;
  }
  budget.remaining -= total;
  text.push(decoder.decode());
  return text.join('');
}

// -- OOXML ---------------------------------------------------------------------------

/** The index of the first `>` at or after `from` that is outside a quoted value, or -1. */
function xmlTagEnd(s: string, from: number, pace: Pace): Promise<number> {
  let quote = 0;
  return pace.scan(s, from, (c) => {
    if (quote !== 0) {
      if (c === quote) quote = 0;
      return false;
    }
    if (c === 34 || c === 39) {
      quote = c;
      return false;
    }
    return c === 62;
  });
}

/** Whitespace, `/` or `>` ends an XML name. */
const endsName = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 62;

/** Longer than any qualified name the OOXML scan acts on (`w:t`, `a:rPh`); a longer one is just a tag. */
const XML_NAME_MAX = 64;

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
 * index moves forward only, every search is paced (`Pace`), and content after a construct
 * that never closes is not text.
 */
async function ooxmlText(xml: string, pace: Pace): Promise<string> {
  const out: string[] = [];
  const BREAK_AFTER = new Set(['p', 'si', 'row', 'tr']);
  const BREAK = new Set(['br', 'cr']);
  let inText = 0;
  let skip = 0;
  const inside = () => inText > 0 && skip === 0;
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = await pace.find(xml, '<', i);
    if (lt < 0) {
      if (inside()) out.push(await decodeEntities(xml.slice(i), XML_ENTITIES, pace));
      break;
    }
    if (lt > i && inside()) out.push(await decodeEntities(xml.slice(i, lt), XML_ENTITIES, pace));
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = await pace.find(xml, ']]>', lt + 9);
      if (end < 0) break;
      if (inside()) out.push(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = await pace.find(xml, '-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = await pace.find(xml, '?>', lt + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    const gt = await xmlTagEnd(xml, lt + 1, pace);
    if (gt < 0) break;
    i = gt + 1;
    if (xml[lt + 1] === '!') continue; // a declaration
    const closing = xml[lt + 1] === '/';
    const selfClosing = xml[gt - 1] === '/';
    const nameStart = closing ? lt + 2 : lt + 1;
    const nameLimit = Math.min(gt, nameStart + XML_NAME_MAX + 1);
    let nameEnd = nameStart;
    while (nameEnd < nameLimit && !endsName(xml.charCodeAt(nameEnd))) nameEnd += 1;
    if (nameEnd - nameStart > XML_NAME_MAX) continue;
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
  const pace = new Pace(signal);
  const entries = await zipEntries(zip, pace);
  if (!entries.some((e) => REQUIRED_PART[format].test(e.name))) {
    throw new MalformedInput(`the archive is not a ${format} file`);
  }
  const budget: InflateBudget = { remaining: bounds.maxInflatedBytes };
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
    const text = await ooxmlText(await readEntryText(zip, entry, budget, pace), pace);
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
  toText: (decoded: string, pace: Pace) => string | Promise<string>,
): Promise<{ text: string; truncated: boolean }> {
  const scan = input.maxTextBytes * scanFactor;
  const pace = new Pace(input.signal);
  const decoded = await decodeText(input.body.subarray(0, scan), parseContentType(input.contentType).charset, pace);
  return { text: await toText(decoded, pace), truncated: input.body.length > scan };
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
