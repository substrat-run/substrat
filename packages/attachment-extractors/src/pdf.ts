/**
 * PDF → text (#1575): the text layer a PDF's pages draw, read without a dependency.
 *
 * **The bytes are a tenant's, so this is a hostile-input parser first and a PDF reader second.**
 * Every structure a file can make large or circular has a bound of its own, and every bound
 * ends the extraction legibly — `{ failed }` with a content-free reason, or the text read so
 * far marked truncated — never a throw that escapes, and never a hang:
 *
 * - **Decompression** (`decodeStream`). Each stream's decoded size is counted as the decoder
 *   produces it, against `PDF_STREAM_MAX` for the stream (past it: a bomb, and the file
 *   fails) and against the extraction's inflate budget in total (past it: the text read so
 *   far is kept, truncated). A declared `/Length` or `/DL` is never trusted for either.
 * - **The cross-reference chain** (`readXref`): at most `PDF_XREF_SECTIONS` sections, and a
 *   `/Prev` or `/XRefStm` that comes back to one already read is a loop, refused.
 * - **Objects**: at most `PDF_OBJECTS_MAX` cross-reference entries, however large a `/Size`
 *   or a subsection count claims to be — nothing is allocated from a declared count. An object
 *   is parsed at most once (`objects`), and one whose resolution reaches itself — a `/Length`
 *   naming its own stream, a chain of references back to the start — resolves to null.
 * - **Object streams** do not nest: an object stream must itself sit at a file offset, as the
 *   format requires, so one named as living in another object stream is refused.
 * - **Nesting**: an array or dictionary at most `PDF_DEPTH_MAX` deep, a page tree at most
 *   `PDF_TREE_DEPTH_MAX` deep and never through one of its own ancestors, a form XObject at
 *   most `PDF_FORM_DEPTH_MAX` deep and never inside itself. Every walk is a loop with a depth
 *   counter or a recursion with one: none follows what the file says without counting.
 * - **Memory** (`Retained`): what the extraction keeps — cached decoded streams, a page's
 *   joined content, parsed objects, cross-reference entries, CMap entries, font decoders — is
 *   charged before it is allocated, at most `PDF_RETAINED_FACTOR` × the inflate budget plus
 *   `PDF_RETAINED_BASE`. Every other allocation is bounded by a named constant: a token, a
 *   stream (`PDF_STREAM_MAX`), the text collected, the operand stack.
 * - **Work**: a token or a direct object larger than `EXTRACTION_STRIDE` is refused, so the
 *   synchronous lexer never runs more than a stride between two checks of the signal, and
 *   every loop over the file — the lexer's, the byte searches, the decoders, the content
 *   interpreter — charges `Pace` and yields at a stride. Content is interpreted against a
 *   budget of its own (`PDF_INTERPRET_FACTOR` × the inflate budget), so a page tree that
 *   draws one form a thousand times cannot spend more than that.
 *
 * What it reads: the classic and the stream cross-reference forms, hybrid files, incremental
 * updates, object streams, and — when the cross-reference data is unusable, as in a file
 * edited by a tool that did not rewrite it — a scan for `N G obj` headers instead. Filters:
 * Flate (with PNG predictors), LZW, ASCIIHex, ASCII85, RunLength. Image filters are not text
 * and are skipped. Text is decoded through a font's `/ToUnicode` CMap where it has one, and
 * through its encoding — WinAnsi, MacRoman, Standard, `/Differences` glyph names — where it
 * has not. A composite font with no `/ToUnicode` names glyphs, not characters, so its text is
 * unreadable and is not guessed at.
 *
 * What it does not: **encrypted files** are refused with that reason (their keys are derived
 * with MD5 and RC4, which Web Crypto does not carry, and this package does not hand-roll a
 * hash). **No OCR**: a scanned page has no text layer, so a scanned PDF extracts to nothing,
 * which the kernel records `empty`.
 */
import { EXTRACTION_STRIDE, type ExtractionSignal } from '@substrat-run/kernel';
import {
  CALL_COST,
  COLLECT_FACTOR,
  Retained,
  RetainedBoundExceeded,
  ExtractionBoundExceeded,
  MalformedInput,
  Pace,
  inflateChunks,
  type InflateBudget,
} from './shared.js';

/** Cross-reference entries one file may declare, across every section. */
export const PDF_OBJECTS_MAX = 200_000;
/** Cross-reference sections followed through `/Prev` and `/XRefStm`. */
export const PDF_XREF_SECTIONS = 64;
/** Nesting of arrays and dictionaries inside one object. */
export const PDF_DEPTH_MAX = 32;
/** Depth of the page tree. */
export const PDF_TREE_DEPTH_MAX = 64;
/** Page-tree nodes visited, pages included. */
export const PDF_TREE_NODES_MAX = 50_000;
/** Depth of form XObjects drawn inside one another. */
export const PDF_FORM_DEPTH_MAX = 8;
/** Bytes one stream may decode to: past it, the stream is a bomb and the file fails. */
export const PDF_STREAM_MAX = 8 * 1024 * 1024;
/** Content bytes interpreted, as a multiple of the inflate budget. */
export const PDF_INTERPRET_FACTOR = 4;
/** The longest token, and the largest direct object, the lexer reads in one go. */
const TOKEN_MAX = EXTRACTION_STRIDE;
/** Operands one content-stream operator may collect before the stack is dropped as garbage. */
const OPERANDS_MAX = 256;
/** Codes a CMap may map, across every range in it. */
const CMAP_CODES_MAX = 1 << 17;
/** Code-space ranges one CMap may declare; a real one declares a handful. */
const CMAP_SPACES_MAX = 256;
/** The longest destination string a CMap maps a code to: the format's own limit, 512 bytes. */
const CMAP_DST_MAX = 512;
/** How far back from `obj` the scan looks for `N G `: two numbers and the space around them. */
const OBJ_HEADER_SPAN = 48;
/**
 * What one PDF extraction may hold at once, as a multiple of its inflate budget (`Retained`):
 * the decoded streams themselves (at most one inflate budget), and as much again for what is
 * built from them — parsed objects, the cross-reference, CMaps, fonts, joined page content.
 */
export const PDF_RETAINED_FACTOR = 2;
/** And a base the structures need whatever the inflate budget: fonts, the cross-reference, objects. */
export const PDF_RETAINED_BASE = 4 * 1024 * 1024;
/** What a parsed object holds per byte it was read from: values, arrays and maps cost more than their text. */
const OBJECT_COST_PER_BYTE = 4;
/** The fixed cost of an entry kept in a map or list: a cross-reference entry, a CMap entry, a parsed object. */
const ENTRY_COST = 64;
/**
 * What a font's decoder holds, measured rather than guessed: 20 000 decoders built the way
 * `fontDecoder` builds them and kept alive, over a collected heap (`node --expose-gc`,
 * `heapUsed` before and after, divided by the count). A simple font held 2 233 bytes (its
 * copied 256-entry table and its closure); each `/Differences` entry another ~78, its fresh
 * glyph string included; a composite font's closure 248. Rounded up.
 */
const SIMPLE_FONT_COST = 2_560;
const DIFFERENCE_COST = 64;
const COMPOSITE_FONT_COST = 256;
/** Whitespace read between a stream's declared end and its `endstream`. */
const STREAM_END_SPAN = 64;

// -- values ---------------------------------------------------------------------------

interface PdfName {
  readonly kind: 'name';
  readonly name: string;
}
interface PdfString {
  readonly kind: 'str';
  readonly bytes: Uint8Array;
}
interface PdfRef {
  readonly kind: 'ref';
  readonly num: number;
  readonly gen: number;
}
interface PdfStream {
  readonly kind: 'stream';
  readonly dict: PdfDict;
  readonly start: number;
  readonly length: number;
  /** The object number it was read as, for the decode cache; null for none. */
  readonly num: number | null;
}
type PdfDict = Map<string, PdfValue>;
type PdfValue = null | boolean | number | PdfName | PdfString | PdfRef | PdfStream | PdfDict | PdfValue[];

/** A tagged value's `kind`; undefined for a number, a boolean, null, an array or a dictionary. */
const kindOf = (v: PdfValue | undefined): string | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Map) ? v.kind : undefined;
const isName = (v: PdfValue | undefined): v is PdfName => kindOf(v) === 'name';
const isString = (v: PdfValue | undefined): v is PdfString => kindOf(v) === 'str';
const isRef = (v: PdfValue | undefined): v is PdfRef => kindOf(v) === 'ref';
const isStream = (v: PdfValue | undefined): v is PdfStream => kindOf(v) === 'stream';
const isDict = (v: PdfValue | undefined): v is PdfDict => v instanceof Map;
const nameOf = (v: PdfValue | undefined): string | null => (isName(v) ? v.name : null);
const intOf = (v: PdfValue | undefined): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

// -- bytes ----------------------------------------------------------------------------

const isWhite = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number): boolean =>
  c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const isRegular = (c: number): boolean => !isWhite(c) && !isDelim(c);
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
const latin1 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]!);
  return s;
};

/** The first `needle` in `buf` at or after `from`, searched a window at a time; -1 when none. */
async function findBytes(buf: Uint8Array, needle: Uint8Array, from: number, pace: Pace): Promise<number> {
  pace.charge(CALL_COST);
  const first = needle[0]!;
  for (let at = from; at < buf.length; ) {
    await pace.turn();
    const end = Math.min(buf.length, at + pace.room);
    for (let i = at; i < end; i += 1) {
      if (buf[i] !== first || i + needle.length > buf.length) continue;
      let k = 1;
      while (k < needle.length && buf[i + k] === needle[k]) k += 1;
      if (k === needle.length) {
        pace.charge(i + 1 - at);
        return i;
      }
    }
    pace.charge(end - at);
    at = end;
  }
  return -1;
}

/** The last `needle` in `buf`, looking back at most `span` bytes from the end, a window at a time. */
async function findLast(buf: Uint8Array, needle: Uint8Array, span: number, pace: Pace): Promise<number> {
  pace.charge(CALL_COST);
  const stop = Math.max(0, buf.length - span);
  for (let at = buf.length - needle.length; at >= stop; ) {
    await pace.turn();
    const end = Math.max(stop, at - pace.room);
    for (let i = at; i >= end; i -= 1) {
      let k = 0;
      while (k < needle.length && buf[i + k] === needle[k]) k += 1;
      if (k === needle.length) {
        pace.charge(at - i + 1);
        return i;
      }
    }
    pace.charge(at - end + 1);
    at = end - 1;
  }
  return -1;
}

/** Chunks joined into one array; a single chunk is returned as it is. */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// -- the lexer --------------------------------------------------------------------------

/** A literal string's one-character escapes: `\n \r \t \b \f \( \) \\`. */
const ESCAPES: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };

type Token =
  | { readonly t: 'num'; readonly v: number }
  | { readonly t: 'str'; readonly v: Uint8Array }
  | { readonly t: 'name'; readonly v: string }
  | { readonly t: 'kw'; readonly v: string }
  | { readonly t: '[' | ']' | '<<' | '>>' | '{' | '}' | 'eof' };

/**
 * Tokens over a byte range, synchronously. Each token — and the whitespace and comments before
 * it — is at most `TOKEN_MAX` bytes, and what it consumed is charged to `pace`, so a caller's
 * loop that yields whenever `pace.room` runs out never holds the thread for much past a stride.
 */
class Lexer {
  pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start: number,
    private readonly end: number,
    private readonly pace: Pace,
  ) {
    this.pos = start;
  }

  private tooLong(from: number): void {
    if (this.pos - from > TOKEN_MAX) {
      // What was read is charged even though the token is refused: the work was done.
      this.pace.charge(this.pos - from);
      throw new MalformedInput('a PDF token is longer than the extraction reads');
    }
  }

  /** Skip whitespace and comments. */
  private skipSpace(): void {
    const from = this.pos;
    while (this.pos < this.end) {
      const c = this.buf[this.pos]!;
      if (isWhite(c)) {
        this.pos += 1;
      } else if (c === 37) {
        // To the end of the line — but never past the token bound, however long the line is.
        const stop = Math.min(this.end, from + TOKEN_MAX + 1);
        while (this.pos < stop && this.buf[this.pos] !== 10 && this.buf[this.pos] !== 13) this.pos += 1;
      } else {
        break;
      }
      this.tooLong(from);
    }
    this.pace.charge(this.pos - from);
  }

  next(): Token {
    this.skipSpace();
    if (this.pos >= this.end) return { t: 'eof' };
    const from = this.pos;
    const c = this.buf[this.pos]!;
    let token: Token;
    if (c === 40) token = { t: 'str', v: this.literal() };
    else if (c === 60 && this.buf[this.pos + 1] === 60) {
      this.pos += 2;
      token = { t: '<<' };
    } else if (c === 60) token = { t: 'str', v: this.hex() };
    else if (c === 62) {
      this.pos += this.buf[this.pos + 1] === 62 ? 2 : 1;
      token = { t: '>>' };
    } else if (c === 91 || c === 93 || c === 123 || c === 125) {
      this.pos += 1;
      token = { t: String.fromCharCode(c) as '[' | ']' | '{' | '}' };
    } else if (c === 47) token = { t: 'name', v: this.name() };
    else if (c === 41) {
      // A stray `)` is not a token anything reads; step over it rather than stall on it.
      this.pos += 1;
      token = { t: 'kw', v: ')' };
    } else {
      // One forward pass decides whether the word is a number — `[+-]?`, digits with at most
      // one `.`, at least one digit — as it finds the word's end. Never a regular expression
      // over the word: an ambiguous one backtracks quadratically on a long digit run that
      // ends in a letter, which a file can make 256 Ki long (Codex #2062 r1).
      const start = this.pos;
      let digits = 0;
      let dots = 0;
      let numeric = true;
      while (this.pos < this.end && isRegular(this.buf[this.pos]!)) {
        const c = this.buf[this.pos]!;
        if (c >= 48 && c <= 57) digits += 1;
        else if (c === 46) dots += 1;
        else if (!((c === 43 || c === 45) && this.pos === start)) numeric = false;
        this.pos += 1;
        this.tooLong(start);
      }
      const word = latin1(this.buf.subarray(start, this.pos));
      const n = numeric && digits > 0 && dots <= 1 ? Number(word) : Number.NaN;
      token = Number.isFinite(n) ? { t: 'num', v: n } : { t: 'kw', v: word };
    }
    // A token's bytes, and the fixed cost of making one (`CALL_COST`): a stream of one-byte
    // tokens is a call per byte.
    this.pace.charge(this.pos - from + CALL_COST);
    return token;
  }

  private literal(): Uint8Array {
    const start = this.pos;
    this.pos += 1;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.end) {
      this.tooLong(start);
      const c = this.buf[this.pos++]!;
      if (c === 40) depth += 1;
      else if (c === 41 && (depth -= 1) === 0) return Uint8Array.from(out);
      if (c !== 92) {
        out.push(c);
        continue;
      }
      const e = this.buf[this.pos++];
      if (e === undefined) break;
      if (ESCAPES[e] !== undefined) out.push(ESCAPES[e]!);
      else if (e >= 48 && e <= 55) {
        let v = e - 48;
        for (let k = 0; k < 2 && this.buf[this.pos]! >= 48 && this.buf[this.pos]! <= 55; k += 1) v = v * 8 + (this.buf[this.pos++]! - 48);
        out.push(v & 0xff);
      } else if (e === 13) {
        if (this.buf[this.pos] === 10) this.pos += 1;
      } else if (e !== 10) out.push(e);
    }
    return Uint8Array.from(out);
  }

  private hex(): Uint8Array {
    const start = this.pos;
    this.pos += 1;
    const out: number[] = [];
    let half = -1;
    while (this.pos < this.end) {
      this.tooLong(start);
      const c = this.buf[this.pos++]!;
      if (c === 62) break;
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v < 0) continue;
      if (half < 0) half = v;
      else {
        out.push(half * 16 + v);
        half = -1;
      }
    }
    if (half >= 0) out.push(half * 16);
    return Uint8Array.from(out);
  }

  private name(): string {
    const start = this.pos;
    this.pos += 1;
    let s = '';
    while (this.pos < this.end && isRegular(this.buf[this.pos]!)) {
      this.tooLong(start);
      const c = this.buf[this.pos++]!;
      if (c === 35 && this.pos + 1 < this.end) {
        const v = Number.parseInt(String.fromCharCode(this.buf[this.pos]!, this.buf[this.pos + 1]!), 16);
        if (!Number.isNaN(v)) {
          s += String.fromCharCode(v);
          this.pos += 2;
          continue;
        }
      }
      s += String.fromCharCode(c);
    }
    return s;
  }
}

/**
 * One direct value, starting from a token already read. `refs` says whether `N G R` is read as
 * a reference: in a content stream it never is, and the lookahead would only cost.
 */
function valueFrom(tok: Token, lex: Lexer, refs: boolean, depth = 0, start = lex.pos): PdfValue {
  if (lex.pos - start > TOKEN_MAX) throw new MalformedInput('a PDF object is larger than the extraction reads');
  switch (tok.t) {
    case 'num': {
      if (refs && Number.isInteger(tok.v) && tok.v >= 0) {
        const save = lex.pos;
        const gen = lex.next();
        if (gen.t === 'num' && Number.isInteger(gen.v) && gen.v >= 0) {
          const r = lex.next();
          if (r.t === 'kw' && r.v === 'R') return { kind: 'ref', num: tok.v, gen: gen.v };
        }
        lex.pos = save;
      }
      return tok.v;
    }
    case 'str':
      return { kind: 'str', bytes: tok.v };
    case 'name':
      return { kind: 'name', name: tok.v };
    case 'kw':
      return tok.v === 'true' ? true : tok.v === 'false' ? false : null;
    case '[':
    case '<<': {
      if (depth >= PDF_DEPTH_MAX) throw new MalformedInput('a PDF object is nested too deeply');
      const close = tok.t === '[' ? ']' : '>>';
      const items: PdfValue[] = [];
      const dict: PdfDict = new Map();
      let key: string | null = null;
      for (;;) {
        // Every token read counts against the object's size, a skipped key included.
        if (lex.pos - start > TOKEN_MAX) throw new MalformedInput('a PDF object is larger than the extraction reads');
        const next = lex.next();
        if (next.t === close) break;
        if (next.t === 'eof') throw new MalformedInput('the PDF ends inside an object');
        if (next.t === ']' || next.t === '>>') throw new MalformedInput('a PDF object is not closed the way it was opened');
        if (tok.t === '<<' && key === null) {
          // A key must be a name; anything else in that place is skipped, as readers do.
          if (next.t === 'name') key = next.v;
          continue;
        }
        const v = valueFrom(next, lex, refs, depth + 1, start);
        if (tok.t === '[') items.push(v);
        else {
          dict.set(key!, v);
          key = null;
        }
      }
      return tok.t === '[' ? items : dict;
    }
    default:
      return null;
  }
}

// -- decoding streams -----------------------------------------------------------------

/** What a decoder did: its bytes, and whether the extraction's budget ran out on the way. */
interface Decoded {
  readonly data: Uint8Array;
  /** True when the inflate budget, not the stream, ended the data. */
  readonly exhausted: boolean;
}

/**
 * Collect a decoder's output under both bounds: past `PDF_STREAM_MAX` the stream is a bomb and
 * the file fails; past what the budget has left, the data ends there and says so.
 */
class Sink {
  private readonly chunks: Uint8Array[] = [];
  size = 0;
  exhausted = false;

  constructor(private readonly budget: InflateBudget) {}

  /** Add a chunk; false once the budget is spent and nothing more should be produced. */
  add(chunk: Uint8Array): boolean {
    if (this.size + chunk.length > PDF_STREAM_MAX) {
      throw new ExtractionBoundExceeded('a PDF stream decodes past the extraction bound');
    }
    if (this.size + chunk.length > this.budget.remaining) {
      this.chunks.push(chunk.subarray(0, Math.max(0, this.budget.remaining - this.size)));
      this.size = this.budget.remaining;
      this.exhausted = true;
      return false;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    return true;
  }

  done(): Decoded {
    this.budget.remaining -= this.size;
    return { data: concatBytes(this.chunks), exhausted: this.exhausted };
  }
}

/**
 * Flate, through the runtime's `DecompressionStream`. A zlib header picks `deflate`; data
 * without one (some writers omit it) is read as raw deflate. A stream that is damaged part way
 * keeps what was inflated before the damage, as viewers do: a truncated page is still text.
 */
async function inflate(raw: Uint8Array, budget: InflateBudget, pace: Pace): Promise<Decoded> {
  const zlib = raw.length >= 2 && (raw[0]! & 0x0f) === 8 && ((raw[0]! << 8) | raw[1]!) % 31 === 0;
  const sink = new Sink(budget);
  await inflateChunks(raw, zlib ? 'deflate' : 'deflate-raw', pace, (chunk) => {
    pace.charge(chunk.length);
    return sink.add(chunk);
  });
  return sink.done();
}

/** LZW as PDF writes it (8-bit, early change by default). */
async function lzw(raw: Uint8Array, early: boolean, budget: InflateBudget, pace: Pace): Promise<Decoded> {
  const sink = new Sink(budget);
  let dict: Uint8Array[] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i += 1) dict.push(Uint8Array.of(i));
    dict.push(new Uint8Array(0), new Uint8Array(0));
  };
  reset();
  let width = 9;
  let bits = 0;
  let acc = 0;
  let prev: Uint8Array | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    if (pace.room <= 0) await pace.turn();
    pace.charge(1);
    acc = (acc << 8) | raw[i]!;
    bits += 8;
    while (bits >= width) {
      const code = (acc >> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      acc &= (1 << bits) - 1;
      if (code === 256) {
        reset();
        width = 9;
        prev = null;
        continue;
      }
      if (code === 257) return sink.done();
      let entry: Uint8Array;
      if (code < dict.length) entry = dict[code]!;
      else if (prev && code === dict.length) {
        entry = new Uint8Array(prev.length + 1);
        entry.set(prev);
        entry[prev.length] = prev[0]!;
      } else return sink.done();
      // An entry is at most the table's 4096 bytes; its copy is work, charged as such.
      pace.charge(entry.length);
      if (!sink.add(entry)) return sink.done();
      if (prev && dict.length < 4096) {
        const grown = new Uint8Array(prev.length + 1);
        grown.set(prev);
        grown[prev.length] = entry[0]!;
        dict.push(grown);
      }
      prev = entry;
      const limit = dict.length + (early ? 1 : 0);
      width = limit >= 2048 ? 12 : limit >= 1024 ? 11 : limit >= 512 ? 10 : 9;
    }
  }
  return sink.done();
}

/** ASCIIHex, ASCII85 and RunLength: small, byte-at-a-time, paced and bounded the same way. */
/**
 * Decoded bytes, one at a time, into a `Sink` a buffer at a time — so a decoder that produces
 * bytes singly is held to the budgets AS it produces them, and stops the moment the budget is
 * spent, rather than materialising its whole output first.
 */
class ByteWriter {
  private readonly buffer: Uint8Array;
  private n = 0;

  /** Buffered up to the budget left plus one byte, so the write that crosses it is the first one seen. */
  constructor(
    private readonly sink: Sink,
    budget: InflateBudget,
  ) {
    this.buffer = new Uint8Array(Math.max(1, Math.min(64 * 1024, budget.remaining + 1)));
  }

  /** Write one byte; false once the budget is spent and the decoder should stop. */
  put(byte: number): boolean {
    this.buffer[this.n++] = byte;
    return this.n < this.buffer.length || this.flush();
  }

  flush(): boolean {
    if (this.n === 0) return true;
    const more = this.sink.add(this.buffer.slice(0, this.n));
    this.n = 0;
    return more;
  }
}

async function asciiHex(raw: Uint8Array, budget: InflateBudget, pace: Pace): Promise<Decoded> {
  const sink = new Sink(budget);
  const out = new ByteWriter(sink, budget);
  let half = -1;
  for (let i = 0; i < raw.length; i += 1) {
    if (pace.room <= 0) await pace.turn();
    pace.charge(1);
    const c = raw[i]!;
    if (c === 62) break;
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v < 0) continue;
    if (half < 0) half = v;
    else {
      if (!out.put(half * 16 + v)) return sink.done();
      half = -1;
    }
  }
  if (half >= 0) out.put(half * 16);
  out.flush();
  return sink.done();
}

async function ascii85(raw: Uint8Array, budget: InflateBudget, pace: Pace): Promise<Decoded> {
  const sink = new Sink(budget);
  const out = new ByteWriter(sink, budget);
  const group: number[] = [];
  /** The first `n` bytes of the group's value; false once the budget is spent. */
  const emit = (n: number): boolean => {
    let v = 0;
    for (let k = 0; k < 5; k += 1) v = v * 85 + (group[k] ?? 84);
    group.length = 0;
    for (let k = 0; k < n; k += 1) if (!out.put((v >>> (24 - 8 * k)) & 0xff)) return false;
    return true;
  };
  let i = raw[0] === 60 && raw[1] === 126 ? 2 : 0;
  for (; i < raw.length; i += 1) {
    if (pace.room <= 0) await pace.turn();
    pace.charge(1);
    const c = raw[i]!;
    if (c === 126) break;
    if (isWhite(c)) continue;
    if (c === 122 && group.length === 0) {
      if (!out.put(0) || !out.put(0) || !out.put(0) || !out.put(0)) return sink.done();
      continue;
    }
    if (c < 33 || c > 117) continue;
    group.push(c - 33);
    if (group.length === 5 && !emit(4)) return sink.done();
  }
  if (group.length > 1) emit(group.length - 1);
  out.flush();
  return sink.done();
}

async function runLength(raw: Uint8Array, budget: InflateBudget, pace: Pace): Promise<Decoded> {
  const sink = new Sink(budget);
  for (let i = 0; i < raw.length; ) {
    if (pace.room <= 0) await pace.turn();
    const n = raw[i]!;
    if (n === 128) break;
    const piece = n < 128 ? raw.subarray(i + 1, i + 2 + n) : new Uint8Array(257 - n).fill(raw[i + 1] ?? 0);
    pace.charge(piece.length + 1);
    i += n < 128 ? n + 2 : 2;
    if (!sink.add(piece)) break;
  }
  return sink.done();
}

/** Undo a PNG predictor (`/Predictor` 10–15), row by row, with each row's own filter byte. */
async function unpredict(data: Uint8Array, parms: PdfDict | null, pace: Pace): Promise<Uint8Array> {
  const predictor = intOf(parms?.get('Predictor')) ?? 1;
  if (predictor < 10) {
    if (predictor === 1) return data;
    throw new MalformedInput('a PDF stream uses a predictor that is not read');
  }
  const colors = Math.min(Math.max(intOf(parms?.get('Colors')) ?? 1, 1), 32);
  const bpc = Math.min(Math.max(intOf(parms?.get('BitsPerComponent')) ?? 8, 1), 16);
  const columns = Math.min(Math.max(intOf(parms?.get('Columns')) ?? 1, 1), 1 << 20);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  // The row width is the file's DECLARATION; the data is what decoding produced, already held
  // to the stream budget. No allocation is sized by the declaration until the data shows a
  // whole row of it: a tiny stream claiming 64 MiB rows decodes to nothing and costs nothing.
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLength + 1));
  if (rows === 0) return new Uint8Array(0);
  const out = new Uint8Array(rows * rowLength); // ≤ data.length
  for (let r = 0; r < rows; r += 1) {
    const filter = data[r * (rowLength + 1)]!;
    const row = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const cur = out.subarray(r * rowLength, (r + 1) * rowLength);
    // The row above; the first row's is all zeros, read as such rather than allocated.
    const prior = r > 0 ? out.subarray((r - 1) * rowLength, r * rowLength) : null;
    pace.charge(1);
    // A row can be megabytes wide: paced inside it, a window at a time.
    for (let i = 0; i < rowLength; ) {
      if (pace.room <= 0) await pace.turn();
      const end = Math.min(rowLength, i + pace.room);
      pace.charge(end - i);
      for (; i < end; i += 1) {
        const a = i >= bpp ? cur[i - bpp]! : 0;
        const b = prior ? prior[i]! : 0;
        const c = prior && i >= bpp ? prior[i - bpp]! : 0;
        let v = row[i]!;
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        cur[i] = v & 0xff;
      }
    }
  }
  return out;
}

/** The filters a stream names, with their parameters, in order. */
function filtersOf(dict: PdfDict): { name: string; parms: PdfDict | null }[] {
  const f = dict.get('Filter') ?? dict.get('F');
  const p = dict.get('DecodeParms') ?? dict.get('DP');
  const names = Array.isArray(f) ? f : f === undefined || f === null ? [] : [f];
  const parms = Array.isArray(p) ? p : [p];
  return names.map((n, i) => ({ name: nameOf(n) ?? '', parms: isDict(parms[i]) ? parms[i] : null }));
}

/** The filters read, by full name and abbreviation; `predicted` ones may carry a predictor. */
interface Filter {
  readonly run: (data: Uint8Array, parms: PdfDict | null, budget: InflateBudget, pace: Pace) => Promise<Decoded>;
  readonly predicted: boolean;
}
const FLATE: Filter = { run: (d, _p, b, pace) => inflate(d, b, pace), predicted: true };
const LZW: Filter = { run: (d, p, b, pace) => lzw(d, intOf(p?.get('EarlyChange')) !== 0, b, pace), predicted: true };
const AHX: Filter = { run: (d, _p, b, pace) => asciiHex(d, b, pace), predicted: false };
const A85: Filter = { run: (d, _p, b, pace) => ascii85(d, b, pace), predicted: false };
const RL: Filter = { run: (d, _p, b, pace) => runLength(d, b, pace), predicted: false };
const FILTERS: Record<string, Filter> = {
  FlateDecode: FLATE, Fl: FLATE, LZWDecode: LZW, LZW, ASCIIHexDecode: AHX, AHx: AHX,
  ASCII85Decode: A85, A85, RunLengthDecode: RL, RL,
};

// -- the document -----------------------------------------------------------------------

type XrefEntry = { readonly type: 1; readonly offset: number } | { readonly type: 2; readonly stream: number };

/** The text read so far is enough: stop reading, and say the text was cut. */
class Enough extends Error {}

/**
 * A file that is not damaged but refused — a loop, nested object streams, encryption. Damage
 * earns the scan fallback a second way in; a refusal is the file's answer and never does.
 */
class Refusal extends MalformedInput {}

const tooManyObjects = (): ExtractionBoundExceeded =>
  new ExtractionBoundExceeded(`the PDF declares more than ${PDF_OBJECTS_MAX} objects`);

class PdfDocument {
  readonly xref = new Map<number, XrefEntry>();
  /** Each object is parsed at most once. */
  private readonly objects = new Map<number, PdfValue>();
  /** Objects whose resolution is in progress: met again, the reference resolves to null. */
  private readonly resolving = new Set<number>();
  private readonly objectStreams = new Map<number, { data: Uint8Array; offsets: Map<number, number> } | null>();
  /** Decoded form XObjects and CMaps, by object number: a form drawn on every page decodes once. */
  private readonly decodedByNum = new Map<number, Decoded | null>();
  /** Parsed CMaps, by stream object number: a ToUnicode shared by a thousand fonts parses once. */
  readonly cmaps = new Map<number, CMap | null>();
  trailer: PdfDict = new Map();

  constructor(
    readonly buf: Uint8Array,
    readonly budget: InflateBudget,
    readonly pace: Pace,
    readonly retained: Retained,
  ) {}

  /**
   * Forget the cross-reference and everything read through it, for the scan to start over: an
   * object a wrong offset resolved to null would otherwise stay null. The budget spent stays
   * spent.
   */
  forgetXref(): void {
    this.xref.clear();
    this.objects.clear();
    this.objectStreams.clear();
    this.decodedByNum.clear();
    this.cmaps.clear();
  }

  /**
   * Record where an object is, within `PDF_OBJECTS_MAX`. Sections are read newest first, so
   * by default the first entry for a number wins; the scan reads the file forwards, so it
   * `replace`s — the last header for a number is the newest.
   */
  addEntry(num: number, entry: XrefEntry, replace = false): void {
    if (this.xref.has(num) && !replace) return;
    if (!this.xref.has(num)) {
      if (this.xref.size >= PDF_OBJECTS_MAX) throw tooManyObjects();
      this.retained.take(ENTRY_COST);
    }
    this.xref.set(num, entry);
  }

  async resolve(v: PdfValue | undefined): Promise<PdfValue> {
    if (v === undefined) return null;
    return isRef(v) ? this.object(v.num) : v;
  }

  async resolveDict(v: PdfValue | undefined): Promise<PdfDict | null> {
    const r = await this.resolve(v);
    return isDict(r) ? r : isStream(r) ? r.dict : null;
  }

  async object(num: number): Promise<PdfValue> {
    if (this.objects.has(num)) return this.objects.get(num)!;
    if (this.resolving.has(num)) return null;
    // A parse is synchronous and up to a token's bound long: a walk that resolves object after
    // object — kids, fonts, forms — yields between them once the stride is spent.
    if (this.pace.room <= 0) await this.pace.turn();
    const entry = this.xref.get(num);
    if (!entry) return null;
    this.resolving.add(num);
    try {
      const v = entry.type === 1 ? await this.objectAt(entry.offset, num) : await this.objectInStream(entry.stream, num);
      this.objects.set(num, v);
      return v;
    } finally {
      this.resolving.delete(num);
    }
  }

  /** `N G obj <value> [stream … endstream] endobj` at a file offset. */
  async objectAt(offset: number, expect: number | null): Promise<PdfValue> {
    if (offset < 0 || offset >= this.buf.length) return null;
    const lex = new Lexer(this.buf, offset, this.buf.length, this.pace);
    const n = lex.next();
    const g = lex.next();
    const o = lex.next();
    if (n.t !== 'num' || g.t !== 'num' || o.t !== 'kw' || o.v !== 'obj') return null;
    if (expect !== null && n.v !== expect) return null;
    const from = lex.pos;
    const v = valueFrom(lex.next(), lex, true);
    // A parsed object is kept (`objects`): charged for what it was read from.
    this.retained.take(ENTRY_COST + (lex.pos - from) * OBJECT_COST_PER_BYTE);
    if (!isDict(v)) return v;
    const save = lex.pos;
    const kw = lex.next();
    if (kw.t !== 'kw' || kw.v !== 'stream') {
      lex.pos = save;
      return v;
    }
    let start = lex.pos;
    if (this.buf[start] === 13) start += 1;
    if (this.buf[start] === 10) start += 1;
    return { kind: 'stream', dict: v, start, length: await this.streamLength(v, start), num: expect };
  }

  /**
   * A stream's data length: its `/Length` when the bytes there end with `endstream`, and the
   * distance to the next `endstream` otherwise — a wrong `/Length` is common, and a `/Length`
   * that names its own stream resolves to null and lands here too.
   */
  private async streamLength(dict: PdfDict, start: number): Promise<number> {
    const declared = intOf(await this.resolve(dict.get('Length')));
    if (declared !== null && declared >= 0 && start + declared <= this.buf.length) {
      let k = start + declared;
      const stop = Math.min(this.buf.length, k + STREAM_END_SPAN);
      while (k < stop && isWhite(this.buf[k]!)) k += 1;
      if (latin1(this.buf.subarray(k, k + 9)) === 'endstream') return declared;
    }
    const end = await findBytes(this.buf, ENDSTREAM, start, this.pace);
    if (end < 0) throw new MalformedInput('a PDF stream is not ended');
    let length = end - start;
    if (this.buf[start + length - 1] === 10) length -= 1;
    if (this.buf[start + length - 1] === 13) length -= 1;
    return Math.max(0, length);
  }

  private async objectInStream(container: number, num: number): Promise<PdfValue> {
    const stm = await this.objectStream(container);
    const at = stm?.offsets.get(num);
    if (!stm || at === undefined) return null;
    const lex = new Lexer(stm.data, at, stm.data.length, this.pace);
    const v = valueFrom(lex.next(), lex, true);
    // Kept, like any parsed object — and many numbers may name one offset, each parsed again.
    this.retained.take(ENTRY_COST + (lex.pos - at) * OBJECT_COST_PER_BYTE);
    return v;
  }

  /** An object stream's decoded data and its header of object numbers and offsets. */
  private async objectStream(container: number): Promise<{ data: Uint8Array; offsets: Map<number, number> } | null> {
    if (this.objectStreams.has(container)) return this.objectStreams.get(container)!;
    const entry = this.xref.get(container);
    // The format puts an object stream at a file offset; one said to sit in another object
    // stream is nesting, which nothing writes and this refuses rather than follows.
    if (entry?.type === 2) throw new Refusal('the PDF nests object streams');
    this.objectStreams.set(container, null);
    const s = await this.object(container);
    if (!isStream(s)) return null;
    const decoded = await this.decode(s);
    if (!decoded) return null;
    if (decoded.exhausted) throw new ExtractionBoundExceeded('the PDF decodes past the extraction bound');
    const offsets = await objectStreamOffsets(decoded.data, s.dict, this.pace);
    this.retained.take(offsets.size * ENTRY_COST);
    const stm = { data: decoded.data, offsets };
    this.objectStreams.set(container, stm);
    return stm;
  }

  /**
   * A stream's decoded bytes, through its filters in order; null for a stream that holds an
   * image (not text) or uses a filter this does not read.
   */
  async decode(s: PdfStream): Promise<Decoded | null> {
    if (s.num !== null && this.decodedByNum.has(s.num)) return this.decodedByNum.get(s.num)!;
    let data = this.buf.subarray(s.start, Math.min(this.buf.length, s.start + s.length));
    let exhausted = false;
    let result: Decoded | null = null;
    try {
      const filters = filtersOf(s.dict);
      if (filters.length === 0) {
        // Unfiltered bytes are decoded bytes too, held to both budgets like any filter's output:
        // past the per-stream bound the file fails, past the total the data ends there.
        const sink = new Sink(this.budget);
        sink.add(data);
        result = sink.done();
        return result;
      }
      for (const { name, parms } of filters) {
        // An image filter is not text, and an unknown one is not read: either way, no data.
        const filter = Object.hasOwn(FILTERS, name) ? FILTERS[name]! : null;
        if (!filter) return null;
        const d = await filter.run(data, parms, this.budget, this.pace);
        data = filter.predicted ? await unpredict(d.data, parms, this.pace) : d.data;
        exhausted ||= d.exhausted;
        if (exhausted) break;
      }
      result = { data, exhausted };
      return result;
    } finally {
      if (s.num !== null) {
        // Cached for the rest of the extraction: held, and charged as such.
        if (result) this.retained.take(result.data.length);
        this.decodedByNum.set(s.num, result);
      }
    }
  }
}

/** An object stream's header: each object number it holds, and where in the data it starts. */
async function objectStreamOffsets(data: Uint8Array, dict: PdfDict, pace: Pace): Promise<Map<number, number>> {
  const first = intOf(dict.get('First')) ?? 0;
  const count = Math.min(intOf(dict.get('N')) ?? 0, PDF_OBJECTS_MAX);
  const lex = new Lexer(data, 0, Math.min(first, data.length), pace);
  const offsets = new Map<number, number>();
  for (let k = 0; k < count; k += 1) {
    if (pace.room <= 0) await pace.turn();
    const a = lex.next();
    const b = lex.next();
    if (a.t !== 'num' || b.t !== 'num') break;
    offsets.set(a.v, first + b.v);
  }
  return offsets;
}

const ENDSTREAM = ascii('endstream');
const NEWLINE = Uint8Array.of(10);
const STARTXREF = ascii('startxref');
const TRAILER = ascii('trailer');

// -- cross-reference ----------------------------------------------------------------------

/**
 * Read every cross-reference section, newest first: the `startxref` offset, then each
 * section's `/Prev` (and a hybrid file's `/XRefStm`). At most `PDF_XREF_SECTIONS`, and an
 * offset met twice is a loop, refused.
 */
async function readXref(doc: PdfDocument): Promise<void> {
  const sx = await findLast(doc.buf, STARTXREF, 2048, doc.pace);
  if (sx < 0) throw new MalformedInput('the PDF has no startxref');
  const lex = new Lexer(doc.buf, sx + STARTXREF.length, doc.buf.length, doc.pace);
  const first = lex.next();
  if (first.t !== 'num') throw new MalformedInput('the PDF has no startxref');
  const queue: number[] = [first.v];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const offset = queue.shift()!;
    if (seen.has(offset)) throw new Refusal('the PDF cross-reference chain loops');
    seen.add(offset);
    if (seen.size > PDF_XREF_SECTIONS) {
      throw new ExtractionBoundExceeded(`the PDF has more than ${PDF_XREF_SECTIONS} cross-reference sections`);
    }
    const trailer = await xrefSection(doc, offset);
    if (seen.size === 1) doc.trailer = trailer; // the newest section's trailer
    // The hybrid file's stream comes before its own table's `/Prev`: it is the same update.
    const stm = intOf(trailer.get('XRefStm'));
    if (stm !== null) queue.unshift(stm);
    const prev = intOf(trailer.get('Prev'));
    if (prev !== null) queue.push(prev);
  }
}

/** One section at `offset` — a classic table or a cross-reference stream — and its trailer. */
async function xrefSection(doc: PdfDocument, offset: number): Promise<PdfDict> {
  const lex = new Lexer(doc.buf, offset, doc.buf.length, doc.pace);
  const head = lex.next();
  if (head.t === 'kw' && head.v === 'xref') {
    for (;;) {
      if (doc.pace.room <= 0) await doc.pace.turn();
      const save = lex.pos;
      const a = lex.next();
      if (a.t === 'kw' && a.v === 'trailer') break;
      const b = lex.next();
      if (a.t !== 'num' || b.t !== 'num' || a.v < 0 || b.v < 0) {
        lex.pos = save;
        throw new MalformedInput('a PDF cross-reference table is damaged');
      }
      // Checked before the loop: a subsection that claims a billion rows is refused, not read.
      if (b.v > PDF_OBJECTS_MAX) throw tooManyObjects();
      for (let i = 0; i < b.v; i += 1) {
        if (doc.pace.room <= 0) await doc.pace.turn();
        const off = lex.next();
        const gen = lex.next();
        const kind = lex.next();
        if (off.t !== 'num' || gen.t !== 'num' || kind.t !== 'kw') throw new MalformedInput('a PDF cross-reference table is damaged');
        if (kind.v === 'n' && off.v > 0) doc.addEntry(a.v + i, { type: 1, offset: off.v });
        else if (kind.v === 'f' && !doc.xref.has(a.v + i)) doc.addEntry(a.v + i, { type: 1, offset: -1 });
      }
    }
    const trailer = valueFrom(lex.next(), lex, true);
    if (!isDict(trailer)) throw new MalformedInput('a PDF trailer is damaged');
    return trailer;
  }
  const s = await doc.objectAt(offset, null);
  if (!isStream(s) || nameOf(s.dict.get('Type')) !== 'XRef') throw new MalformedInput('a PDF cross-reference section is damaged');
  const decoded = await doc.decode(s);
  if (!decoded || decoded.exhausted) throw new MalformedInput('a PDF cross-reference stream is unreadable');
  const w = s.dict.get('W');
  const widths = Array.isArray(w) ? w.map((x) => intOf(x) ?? -1) : [];
  if (widths.length !== 3 || widths.some((x) => x < 0 || x > 8)) throw new MalformedInput('a PDF cross-reference stream is damaged');
  const size = intOf(s.dict.get('Size')) ?? 0;
  const index = s.dict.get('Index');
  const ranges = Array.isArray(index) ? index.map((x) => intOf(x) ?? -1) : [0, size];
  const row = widths[0]! + widths[1]! + widths[2]!;
  if (row === 0) throw new MalformedInput('a PDF cross-reference stream is damaged');
  const data = decoded.data;
  const field = (at: number, width: number, fallback: number): number => {
    if (width === 0) return fallback;
    let v = 0;
    for (let k = 0; k < width; k += 1) v = v * 256 + data[at + k]!;
    return v;
  };
  let at = 0;
  for (let r = 0; r + 1 < ranges.length; r += 2) {
    const start = ranges[r]!;
    const count = ranges[r + 1]!;
    if (start < 0 || count < 0) throw new MalformedInput('a PDF cross-reference stream is damaged');
    if (count > PDF_OBJECTS_MAX) throw tooManyObjects();
    for (let i = 0; i < count && at + row <= data.length; i += 1) {
      if (doc.pace.room <= 0) await doc.pace.turn();
      doc.pace.charge(row);
      const type = field(at, widths[0]!, 1);
      const f2 = field(at + widths[0]!, widths[1]!, 0);
      at += row;
      if (type === 1) doc.addEntry(start + i, { type: 1, offset: f2 });
      else if (type === 2) doc.addEntry(start + i, { type: 2, stream: f2 });
      else if (type === 0 && !doc.xref.has(start + i)) doc.addEntry(start + i, { type: 1, offset: -1 });
    }
  }
  return s.dict;
}

/**
 * When the cross-reference data is unusable: every `N G obj` header in the file, the last one
 * of a number winning (an incremental update appends), each object stream's contents, and the
 * last `trailer` dictionary — or, with none, the catalog found among the objects.
 */
async function scanObjects(doc: PdfDocument): Promise<void> {
  doc.forgetXref();
  const buf = doc.buf;
  const OBJ = ascii('obj');
  const streams: number[] = [];
  for (let at = await findBytes(buf, OBJ, 0, doc.pace); at >= 0; at = await findBytes(buf, OBJ, at + 3, doc.pace)) {
    // Back over `N G ` before `obj` — never further than `OBJ_HEADER_SPAN`: a header is two
    // short numbers, and a digit run longer than that is not one, however long it goes on.
    const floor = Math.max(0, at - OBJ_HEADER_SPAN);
    doc.pace.charge(OBJ_HEADER_SPAN);
    let k = at - 1;
    while (k >= floor && isWhite(buf[k]!)) k -= 1;
    const genEnd = k + 1;
    while (k >= floor && buf[k]! >= 48 && buf[k]! <= 57) k -= 1;
    if (k + 1 === genEnd) continue;
    while (k >= floor && isWhite(buf[k]!)) k -= 1;
    const numEnd = k + 1;
    while (k >= floor && buf[k]! >= 48 && buf[k]! <= 57) k -= 1;
    // Stopped at the floor still inside the number: not a header this scan reads.
    if (k + 1 === numEnd || k < floor || (k >= 0 && isRegular(buf[k]!))) continue;
    doc.addEntry(Number(latin1(buf.subarray(k + 1, numEnd))), { type: 1, offset: k + 1 }, true);
  }
  for (const [num] of doc.xref) {
    if (doc.pace.room <= 0) await doc.pace.turn();
    const v = await doc.object(num).catch(onlyDamage(null));
    if (isStream(v) && nameOf(v.dict.get('Type')) === 'ObjStm') streams.push(num);
  }
  for (const container of streams) {
    const s = (await doc.object(container)) as PdfStream;
    const decoded = await doc.decode(s).catch(onlyDamage(null));
    if (!decoded) continue;
    for (const num of (await objectStreamOffsets(decoded.data, s.dict, doc.pace)).keys()) {
      doc.addEntry(num, { type: 2, stream: container });
    }
  }
  const t = await findLast(buf, TRAILER, buf.length, doc.pace);
  if (t >= 0) {
    const lex = new Lexer(buf, t + TRAILER.length, buf.length, doc.pace);
    const trailer = valueFrom(lex.next(), lex, true);
    if (isDict(trailer) && trailer.has('Root')) {
      doc.trailer = trailer;
      return;
    }
  }
  for (const [num] of doc.xref) {
    if (doc.pace.room <= 0) await doc.pace.turn();
    const v = await doc.object(num).catch(onlyDamage(null));
    if (isDict(v) && nameOf(v.get('Type')) === 'Catalog') {
      doc.trailer = new Map([['Root', { kind: 'ref', num, gen: 0 }]]);
      return;
    }
  }
}

// -- fonts --------------------------------------------------------------------------------

/** How one font's string bytes become text. */
interface FontDecoder {
  decode(bytes: Uint8Array): string;
}

const ACCENTS: Record<string, string> = {
  acute: '́', grave: '̀', circumflex: '̂', dieresis: '̈', tilde: '̃', ring: '̊',
  cedilla: '̧', caron: '̌', macron: '̄', breve: '̆', ogonek: '̨', dotaccent: '̇',
  hungarumlaut: '̋', commaaccent: '̦',
};

const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quotesingle: "'", quoteright: '’', parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',',
  hyphen: '-', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?',
  at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`',
  quoteleft: '‘', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', exclamdown: '¡', cent: '¢',
  sterling: '£', fraction: '⁄', yen: '¥', florin: 'ƒ', section: '§', currency: '¤', quotedblleft: '“',
  guillemotleft: '«', guilsinglleft: '‹', guilsinglright: '›', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi',
  ffl: 'ffl', endash: '–', dagger: '†', daggerdbl: '‡', periodcentered: '·', paragraph: '¶',
  bullet: '•', quotesinglbase: '‚', quotedblbase: '„', quotedblright: '”', guillemotright: '»',
  ellipsis: '…', perthousand: '‰', questiondown: '¿', emdash: '—', AE: 'Æ', ae: 'æ', ordfeminine: 'ª',
  ordmasculine: 'º', Lslash: 'Ł', lslash: 'ł', Oslash: 'Ø', oslash: 'ø', OE: 'Œ', oe: 'œ', dotlessi: 'ı',
  germandbls: 'ß', Eth: 'Ð', eth: 'ð', Thorn: 'Þ', thorn: 'þ', trademark: '™', copyright: '©',
  registered: '®', degree: '°', plusminus: '±', multiply: '×', divide: '÷', minus: '−', mu: 'µ',
  onehalf: '½', onequarter: '¼', threequarters: '¾', onesuperior: '¹', twosuperior: '²', threesuperior: '³',
  logicalnot: '¬', brokenbar: '¦', Euro: '€', nbspace: ' ', nonbreakingspace: ' ', sfthyphen: '-', softhyphen: '-',
  ...ACCENTS,
};

/** The longest glyph name read; a writer's names are a few characters, `uni…` a few dozen. */
const GLYPH_NAME_MAX = 64;

/**
 * A glyph name → its text: the names writers use, `uniXXXX`, `uXXXX`, and composed accents.
 * The patterns below are anchored with one quantifier each (or fixed-width groups), so none
 * can backtrack past linear — and a name is at most `GLYPH_NAME_MAX` long besides.
 */
function glyphText(name: string): string {
  if (name.length > GLYPH_NAME_MAX) return '';
  const base = name.split('.')[0]!;
  if (base.includes('_')) return base.split('_').map(glyphText).join('');
  if (GLYPHS[base] !== undefined) return GLYPHS[base]!;
  if (/^[A-Za-z]$/.test(base)) return base;
  const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(base);
  if (uni) return uni[1]!.match(/.{4}/g)!.map((h) => String.fromCharCode(Number.parseInt(h, 16))).join('');
  const u = /^u([0-9A-F]{4,6})$/.exec(base);
  if (u) {
    const cp = Number.parseInt(u[1]!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  const accented = /^([A-Za-z])([a-z]+)$/.exec(base);
  if (accented && ACCENTS[accented[2]!]) return (accented[1]! + ACCENTS[accented[2]!]!).normalize('NFC');
  return '';
}

const ASCII_RANGE = (): (string | null)[] => {
  const t: (string | null)[] = new Array(256).fill(null);
  for (let c = 32; c < 127; c += 1) t[c] = String.fromCharCode(c);
  return t;
};

const WIN_ANSI = (() => {
  const t = ASCII_RANGE();
  const high = '€\u0000‚ƒ„…†‡ˆ‰Š‹Œ\u0000Ž\u0000\u0000‘’“”•–—˜™š›œ\u0000žŸ';
  for (let i = 0; i < 32; i += 1) t[0x80 + i] = high[i] === '\u0000' ? null : high[i]!;
  for (let c = 0xa0; c <= 0xff; c += 1) t[c] = String.fromCharCode(c);
  return t;
})();

const MAC_ROMAN = (() => {
  const t = ASCII_RANGE();
  const high =
    'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
  for (let i = 0; i < 128; i += 1) t[0x80 + i] = high[i] ?? null;
  return t;
})();

const STANDARD = (() => {
  const t = ASCII_RANGE();
  t[0x27] = '’';
  t[0x60] = '‘';
  const high: Record<number, string> = {
    0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '⁄', 0xa5: '¥', 0xa6: 'ƒ', 0xa7: '§', 0xa8: '¤', 0xa9: "'",
    0xaa: '“', 0xab: '«', 0xac: '‹', 0xad: '›', 0xae: 'fi', 0xaf: 'fl', 0xb1: '–', 0xb2: '†',
    0xb3: '‡', 0xb4: '·', 0xb6: '¶', 0xb7: '•', 0xb8: '‚', 0xb9: '„', 0xba: '”', 0xbb: '»',
    0xbc: '…', 0xbd: '‰', 0xbf: '¿', 0xd0: '—', 0xe1: 'Æ', 0xe3: 'ª', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ',
    0xeb: 'º', 0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß',
  };
  for (const [k, v] of Object.entries(high)) t[Number(k)] = v;
  return t;
})();

const BASE_ENCODINGS: Record<string, (string | null)[]> = {
  WinAnsiEncoding: WIN_ANSI,
  MacRomanEncoding: MAC_ROMAN,
  StandardEncoding: STANDARD,
};

/**
 * A code space: per code length (1–4 bytes), its ranges sorted and merged, so a code is placed
 * by a binary search — never a scan over every range a file declared (Codex #2062 r2).
 */
class CodeSpace {
  /** `byLength[n]` holds the merged `[low, high]` ranges of n-byte codes, ascending. */
  private readonly byLength: [number, number][][];

  constructor(ranges: readonly [number, number, number][]) {
    this.byLength = [[], [], [], [], []];
    for (const [len, lo, hi] of ranges) if (lo <= hi) this.byLength[len]!.push([lo, hi]);
    for (const list of this.byLength) {
      list.sort((a, b) => a[0] - b[0]);
      let w = 0;
      for (const r of list) {
        if (w > 0 && r[0] <= list[w - 1]![1] + 1) list[w - 1]![1] = Math.max(list[w - 1]![1], r[1]);
        else list[w++] = r;
      }
      list.length = w;
    }
  }

  get empty(): boolean {
    return this.byLength.every((l) => l.length === 0);
  }

  /** Whether an n-byte code falls in the space. */
  has(length: number, code: number): boolean {
    const list = this.byLength[length]!;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [a, b] = list[mid]!;
      if (code < a) hi = mid - 1;
      else if (code > b) lo = mid + 1;
      else return true;
    }
    return false;
  }
}

/** What one sealed `CodeMap` segment costs: its first and last key (float64 each) and a definition index. */
const SEGMENT_COST = 20;

/**
 * One `bfrange` destination, split where a code's offset can reach it: `prefix` is the text of
 * every byte the count never touches, `tail` the last one to three bytes it does (`utf16be`
 * pairs bytes from the front, so the split falls on a pair and the two decode independently).
 */
interface RangeDestination {
  readonly from: number;
  readonly prefix: string;
  readonly tail: Uint8Array;
}

/**
 * A ToUnicode mapping that holds what the CMap WROTE, not what it implies: each `bfchar` code
 * as its string, and each `bfrange` as one definition — its first and last code and its base
 * destination — whose destination for a code is computed when that code is looked up (#2062
 * r3). Expanding a range into one string per code let a 1.5 KiB file grow the heap by half a
 * gigabyte. Each definition is charged to the extraction's `Retained` before it is kept.
 *
 * Definitions overlap, and the LATER one wins for every code it names, whichever kind either is
 * — the precedence the map had when it held a string per code. `seal` resolves them once into
 * disjoint segments, each naming the definition that wins it, so a lookup is one binary search.
 */
class CodeMap {
  /** Each definition's first and last key, in the order the CMap wrote them. */
  private los: number[] = [];
  private his: number[] = [];
  /** And what it maps to: a `bfchar`'s text, or a `bfrange`'s destination. */
  private readonly targets: (string | RangeDestination)[] = [];
  /** The sealed segments: `segLo[i]`…`segHi[i]` map through `targets[segDef[i]]`. */
  private segLo = new Float64Array(0);
  private segHi = new Float64Array(0);
  private segDef = new Int32Array(0);
  private segments = 0;
  /** Codes defined so far, against `CMAP_CODES_MAX`. */
  private covered = 0;

  constructor(private readonly retained: Retained) {}

  setChar(length: number, code: number, text: string): void {
    if (this.covered >= CMAP_CODES_MAX) return;
    this.retained.take(ENTRY_COST + text.length * 2);
    const key = codeKey(length, code);
    this.define(key, key, text);
    this.covered += 1;
  }

  /** Codes `from`…`to`, mapped to `base` counting up in its last byte, as the format specifies. */
  setRange(length: number, from: number, to: number, base: Uint8Array): void {
    const count = Math.min(to - from + 1, CMAP_CODES_MAX - this.covered);
    if (count <= 0 || base.length === 0) return;
    this.retained.take(ENTRY_COST + base.length * 2);
    const cut = base.length % 2 === 0 ? base.length - 2 : Math.max(0, base.length - 3);
    const lo = codeKey(length, from);
    this.define(lo, codeKey(length, from + count - 1), { from: lo, prefix: utf16be(base.subarray(0, cut)), tail: Uint8Array.from(base.subarray(cut)) });
    this.covered += count;
  }

  private define(lo: number, hi: number, target: string | RangeDestination): void {
    this.los.push(lo);
    this.his.push(hi);
    this.targets.push(target);
  }

  /**
   * Resolve the definitions into disjoint segments, the later definition winning each code: a
   * sweep over every definition's first code and the one past its last, holding the definitions
   * open there in a heap by order. A CMap that writes its definitions ascending and apart — as
   * real ones do — is its own segment list and skips the sweep.
   */
  async seal(pace: Pace): Promise<this> {
    const n = this.los.length;
    // At most one segment between each two of a definition's 2n boundaries: charged before it is made.
    this.retained.take(2 * n * SEGMENT_COST);
    const segLo = new Float64Array(2 * n);
    const segHi = new Float64Array(2 * n);
    const segDef = new Int32Array(2 * n);
    let count = 0;
    let ordered = true;
    for (let i = 1; i < n && ordered; i += 1) ordered = this.los[i]! > this.his[i - 1]!;
    if (ordered) {
      for (let i = 0; i < n; i += 1) {
        segLo[i] = this.los[i]!;
        segHi[i] = this.his[i]!;
        segDef[i] = i;
      }
      count = n;
    } else {
      // Definitions by first code, and every boundary: a first code, or the code past a last.
      const byLo = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => this.los[a]! - this.los[b]! || a - b);
      const bounds = new Float64Array(2 * n);
      for (let i = 0; i < n; i += 1) {
        bounds[2 * i] = this.los[i]!;
        bounds[2 * i + 1] = this.his[i]! + 1;
      }
      bounds.sort();
      pace.charge(4 * n * Math.max(1, Math.log2(2 * n)));
      // A max-heap of the open definitions by index: the latest one written wins.
      const heap = new Int32Array(n);
      let size = 0;
      const push = (d: number): void => {
        let i = size++;
        while (i > 0 && heap[(i - 1) >> 1]! < d) {
          heap[i] = heap[(i - 1) >> 1]!;
          i = (i - 1) >> 1;
        }
        heap[i] = d;
      };
      const pop = (): void => {
        const d = heap[--size]!;
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= size) break;
          if (c + 1 < size && heap[c + 1]! > heap[c]!) c += 1;
          if (heap[c]! <= d) break;
          heap[i] = heap[c]!;
          i = c;
        }
        heap[i] = d;
      };
      let next = 0;
      for (let b = 0; b < 2 * n; b += 1) {
        if (pace.room <= 0) await pace.turn();
        pace.charge(CALL_COST);
        const at = bounds[b]!;
        if (b + 1 < 2 * n && bounds[b + 1] === at) continue;
        while (next < n && this.los[byLo[next]!]! <= at) push(byLo[next++]!);
        while (size > 0 && this.his[heap[0]!]! < at) pop();
        if (size === 0 || b + 1 >= 2 * n) continue;
        // Every boundary is one, so the winner here holds to the next boundary at least.
        const d = heap[0]!;
        const until = bounds[b + 1]! - 1;
        if (count > 0 && segDef[count - 1] === d && segHi[count - 1] === at - 1) segHi[count - 1] = until;
        else {
          segLo[count] = at;
          segHi[count] = until;
          segDef[count] = d;
          count += 1;
        }
      }
    }
    this.segLo = segLo;
    this.segHi = segHi;
    this.segDef = segDef;
    this.segments = count;
    // The definitions' bounds are in the segments now.
    this.los = [];
    this.his = [];
    return this;
  }

  get(length: number, code: number): string | undefined {
    const key = codeKey(length, code);
    // The last segment starting at or before the key; it maps the code if it reaches it.
    let lo = 0;
    let hi = this.segments - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.segLo[mid]! <= key) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0 || key > this.segHi[found]!) return undefined;
    const target = this.targets[this.segDef[found]!]!;
    return typeof target === 'string' ? target : target.prefix + countedTail(target.tail, key - target.from);
  }
}

/**
 * A `bfrange` destination's last one to three bytes, counted up by `offset` in the last byte —
 * carrying once into the byte before it, as the format specifies — as text, allocating nothing
 * but the string.
 */
function countedTail(tail: Uint8Array, offset: number): string {
  const last = tail[tail.length - 1]! + offset;
  const low = last & 0xff;
  if (tail.length === 1) return String.fromCharCode(low);
  const carried = (tail[tail.length - 2]! + (last >> 8)) & 0xff;
  if (tail.length === 2) return String.fromCharCode((carried << 8) | low);
  return String.fromCharCode((tail[0]! << 8) | carried) + String.fromCharCode(low);
}

/** A CMap's code space and its code → text map (a ToUnicode CMap, or an encoding CMap's spaces). */
interface CMap {
  readonly spaces: CodeSpace;
  readonly map: CodeMap;
}

const codeKey = (length: number, code: number): number => length * 0x1_0000_0000 + code;
/** Identity-H and -V: every two-byte code. */
const IDENTITY_SPACE = new CodeSpace([[2, 0, 0xffff]]);
const utf16be = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  if (b.length % 2 === 1) s += String.fromCharCode(b[b.length - 1]!);
  return s;
};
const bytesToInt = (b: Uint8Array): number => b.reduce((v, x) => v * 256 + x, 0);

/**
 * A CMap stream's `codespacerange`, `bfchar` and `bfrange` sections, bounded by `CMAP_CODES_MAX`
 * and charged to `retained` — parsed once per stream (`PdfDocument.cmaps`).
 */
async function parseCMap(data: Uint8Array, pace: Pace, retained: Retained): Promise<CMap> {
  const lex = new Lexer(data, 0, data.length, pace);
  const ranges: [number, number, number][] = [];
  const map = new CodeMap(retained);
  const operands: PdfValue[] = [];
  for (;;) {
    if (pace.room <= 0) await pace.turn();
    const tok = lex.next();
    if (tok.t === 'eof') break;
    if (tok.t !== 'kw') {
      operands.push(valueFrom(tok, lex, false));
      // A section holds at most 100 entries; past that many operands it is not a CMap.
      if (operands.length > 3 * OPERANDS_MAX) operands.length = 0;
      continue;
    }
    if (tok.v === 'begincodespacerange' || tok.v === 'beginbfchar' || tok.v === 'beginbfrange') operands.length = 0;
    else if (tok.v === 'endcodespacerange') {
      for (let i = 0; i + 1 < operands.length; i += 2) {
        const lo = operands[i];
        const hi = operands[i + 1];
        // At most `CMAP_SPACES_MAX` ranges, however many sections declare more.
        if (isString(lo) && isString(hi) && lo.bytes.length >= 1 && lo.bytes.length <= 4 && ranges.length < CMAP_SPACES_MAX) {
          ranges.push([lo.bytes.length, bytesToInt(lo.bytes), bytesToInt(hi.bytes.subarray(0, 4))]);
        }
      }
      operands.length = 0;
    } else if (tok.v === 'endbfchar') {
      for (let i = 0; i + 1 < operands.length; i += 2) {
        const src = operands[i];
        const dst = operands[i + 1];
        if (isString(src) && isString(dst) && src.bytes.length <= 4 && dst.bytes.length <= CMAP_DST_MAX) {
          map.setChar(src.bytes.length, bytesToInt(src.bytes), utf16be(dst.bytes));
        }
      }
      operands.length = 0;
    } else if (tok.v === 'endbfrange') {
      for (let i = 0; i + 2 < operands.length; i += 3) {
        const lo = operands[i];
        const hi = operands[i + 1];
        const dst = operands[i + 2];
        if (!isString(lo) || !isString(hi) || lo.bytes.length > 4) continue;
        const from = bytesToInt(lo.bytes);
        const to = Math.min(bytesToInt(hi.bytes.subarray(0, 4)), from + 0xffff);
        if (isString(dst)) {
          // One entry for the whole range; a destination past the format's 512 bytes is not one.
          if (dst.bytes.length <= CMAP_DST_MAX) map.setRange(lo.bytes.length, from, to, dst.bytes);
        } else if (Array.isArray(dst)) {
          // An array names each code's destination itself: as many entries as it holds.
          for (let k = 0; k < dst.length && from + k <= to; k += 1) {
            if (pace.room <= 0) await pace.turn();
            pace.charge(1);
            const d = dst[k];
            if (isString(d) && d.bytes.length <= CMAP_DST_MAX) map.setChar(lo.bytes.length, from + k, utf16be(d.bytes));
          }
        }
      }
      operands.length = 0;
    }
  }
  return { spaces: new CodeSpace(ranges), map: await map.seal(pace) };
}

/** A CMap stream, parsed once per object number however many fonts name it. */
async function cmapOf(doc: PdfDocument, ref: PdfValue | undefined): Promise<CMap | null> {
  const num = isRef(ref) ? ref.num : null;
  if (num !== null && doc.cmaps.has(num)) return doc.cmaps.get(num)!;
  const s = await doc.resolve(ref);
  let cmap: CMap | null = null;
  if (isStream(s)) {
    const decoded = await doc.decode(s);
    if (decoded) cmap = await parseCMap(decoded.data, doc.pace, doc.retained);
  }
  if (num !== null) doc.cmaps.set(num, cmap);
  return cmap;
}

/**
 * A string's text through a code space and a code → text map: each code the shortest length
 * whose bytes fall in the space (or `fallback` bytes), placed by at most four binary searches.
 * The work is a constant per byte of the string — which the lexer has already charged.
 */
function codesToText(bytes: Uint8Array, spaces: CodeSpace, fallback: number, map: CodeMap): string {
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    let length = 0;
    let code = 0;
    for (let n = 1; n <= 4 && i + n <= bytes.length; n += 1) {
      code = code * 256 + bytes[i + n - 1]!;
      if (spaces.has(n, code)) {
        length = n;
        break;
      }
    }
    if (length === 0) {
      length = Math.min(fallback, bytes.length - i);
      code = 0;
      for (let n = 0; n < length; n += 1) code = code * 256 + bytes[i + n]!;
    }
    s += map.get(length, code) ?? '';
    i += length;
  }
  return s;
}

/** A font's decoder: `/ToUnicode` first, then its encoding; unreadable composite fonts give nothing. */
async function fontDecoder(doc: PdfDocument, font: PdfDict): Promise<FontDecoder> {
  const subtype = nameOf(font.get('Subtype'));
  // Each font's decoder is kept for the extraction (`Reading.fonts`): charged before it is built,
  // for what it holds. A CMap it reads is charged as that CMap is parsed, once however many fonts share it.
  const toUnicode = await cmapOf(doc, font.get('ToUnicode'));
  if (subtype === 'Type0') {
    doc.retained.take(COMPOSITE_FONT_COST);
    const encRef = font.get('Encoding');
    let spaces = IDENTITY_SPACE;
    const encoding = isName(encRef) ? null : await cmapOf(doc, encRef);
    if (encoding && !encoding.spaces.empty) spaces = encoding.spaces;
    else if (!encoding && toUnicode && !toUnicode.spaces.empty) spaces = toUnicode.spaces;
    return { decode: (bytes) => (toUnicode ? codesToText(bytes, spaces, 2, toUnicode.map) : '') };
  }
  // A simple font: one byte per code.
  const enc = await doc.resolve(font.get('Encoding'));
  const encDict = isDict(enc) ? enc : null;
  const baseName = nameOf(encDict ? encDict.get('BaseEncoding') : enc) ?? '';
  const base = Object.hasOwn(BASE_ENCODINGS, baseName) ? BASE_ENCODINGS[baseName]! : subtype === 'TrueType' ? WIN_ANSI : STANDARD;
  doc.retained.take(SIMPLE_FONT_COST);
  const table: (string | null)[] = [...base];
  const differences = encDict?.get('Differences');
  if (Array.isArray(differences)) {
    let code = 0;
    for (const d of differences) {
      if (typeof d === 'number') code = d;
      else if (isName(d) && code >= 0 && code < 256) {
        const text = glyphText(d.name);
        doc.retained.take(DIFFERENCE_COST + text.length * 2);
        table[code++] = text;
      }
    }
  }
  return {
    decode: (bytes) => {
      let s = '';
      for (let i = 0; i < bytes.length; i += 1) {
        const mapped = toUnicode?.map.get(1, bytes[i]!);
        s += mapped ?? table[bytes[i]!] ?? '';
      }
      return s;
    },
  };
}

// -- content ------------------------------------------------------------------------------

/** Damage is skipped where the rest of the file still reads; a bound or an abort never is. */
function onlyDamage<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (err instanceof MalformedInput) return fallback;
    throw err;
  };
}

/** One extraction's reading state: the text collected, and what it may still spend. */
interface Reading {
  readonly doc: PdfDocument;
  readonly out: string[];
  collected: number;
  readonly limit: number;
  /** Content bytes that may still be interpreted. */
  interpretLeft: number;
  readonly fonts: WeakMap<PdfDict, FontDecoder>;
  /** Form XObjects being drawn, by object number: one drawn inside itself is skipped. */
  readonly drawing: Set<number>;
  /** Page-tree nodes on the path being walked, by object number: one met again is a loop. */
  readonly ancestors: Set<number>;
  /** Page-tree nodes visited so far, against `PDF_TREE_NODES_MAX`. */
  visited: number;
}

function emit(r: Reading, s: string): void {
  if (s.length === 0) return;
  r.out.push(s);
  r.collected += s.length;
  if (r.collected > r.limit) throw new Enough();
}

const LINE_OPERATORS = new Set(['T*', "'", '"', 'Tm', 'ET']);
const INLINE_DATA = ascii('ID');
const INLINE_END = ascii('EI');

/** Interpret one content stream, emitting the text it shows. */
async function interpret(r: Reading, content: Uint8Array, resources: PdfDict | null, depth: number): Promise<void> {
  if (content.length > r.interpretLeft) {
    r.interpretLeft = 0;
    throw new Enough();
  }
  r.interpretLeft -= content.length;
  const { doc } = r;
  const pace = doc.pace;
  const lex = new Lexer(content, 0, content.length, pace);
  const operands: PdfValue[] = [];
  let font: FontDecoder | null = null;
  const fontsDict = await doc.resolveDict(resources?.get('Font'));
  const xobjects = await doc.resolveDict(resources?.get('XObject'));
  const show = (v: PdfValue | undefined): void => {
    if (!isString(v) || !font) return;
    // Decoding is a constant per byte (`codesToText`), charged as the work it is.
    pace.charge(v.bytes.length);
    emit(r, font.decode(v.bytes));
  };
  for (;;) {
    if (pace.room <= 0) await pace.turn();
    const tok = lex.next();
    if (tok.t === 'eof') return;
    if (tok.t !== 'kw' || tok.v === 'true' || tok.v === 'false' || tok.v === 'null') {
      operands.push(valueFrom(tok, lex, false));
      if (operands.length > OPERANDS_MAX) operands.length = 0;
      continue;
    }
    const op = tok.v;
    if (op === 'BI') {
      // An inline image: its data is binary, so skip to an `EI` standing alone after it.
      const id = await findBytes(content, INLINE_DATA, lex.pos, pace);
      if (id < 0) return;
      let e = id + 2;
      for (;;) {
        e = await findBytes(content, INLINE_END, e, pace);
        if (e < 0) return;
        if (isWhite(content[e - 1]!) && (e + 2 >= content.length || !isRegular(content[e + 2]!))) break;
        e += 1;
      }
      lex.pos = e + 2;
    } else if (op === 'Tf') {
      const fontName = nameOf(operands[operands.length - 2]);
      font = null;
      const fontDict = fontName ? await doc.resolveDict(fontsDict?.get(fontName)) : null;
      if (fontDict) {
        font = r.fonts.get(fontDict) ?? null;
        if (!font) {
          // A font this cannot read draws nothing; the rest of the page still reads.
          font = await fontDecoder(doc, fontDict).catch(onlyDamage<FontDecoder>({ decode: () => '' }));
          r.fonts.set(fontDict, font);
        }
      }
    } else if (op === 'Tj') show(operands[operands.length - 1]);
    else if (op === "'" || op === '"') {
      emit(r, '\n');
      show(operands[operands.length - 1]);
    } else if (op === 'TJ') {
      const arr = operands[operands.length - 1];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          // A wide negative adjustment is the gap a writer leaves for a space.
          if (typeof item === 'number' && item < -150) emit(r, ' ');
          else show(item);
        }
      }
    } else if (op === 'Td' || op === 'TD') {
      const ty = operands[operands.length - 1];
      const tx = operands[operands.length - 2];
      if (typeof ty === 'number' && ty !== 0) emit(r, '\n');
      else if (typeof tx === 'number' && tx !== 0) emit(r, ' ');
    } else if (LINE_OPERATORS.has(op)) emit(r, '\n');
    else if (op === 'Do' && depth < PDF_FORM_DEPTH_MAX) {
      const ref = xobjects?.get(nameOf(operands[operands.length - 1]) ?? '');
      const num = isRef(ref) ? ref.num : null;
      if (num !== null && !r.drawing.has(num)) {
        const form = await doc.resolve(ref);
        if (isStream(form) && nameOf(form.dict.get('Subtype')) === 'Form') {
          const decoded = await doc.decode(form);
          if (decoded) {
            r.drawing.add(num);
            try {
              const own = await doc.resolveDict(form.dict.get('Resources'));
              await interpret(r, decoded.data, own ?? resources, depth + 1);
            } finally {
              r.drawing.delete(num);
            }
            if (decoded.exhausted) throw new Enough();
          }
        }
      }
    }
    operands.length = 0;
  }
}

/** A page's content: one stream or an array of them, read as one. */
async function pageContent(doc: PdfDocument, page: PdfDict): Promise<(Decoded & { readonly held: number }) | null> {
  const c = await doc.resolve(page.get('Contents'));
  const parts = Array.isArray(c) ? c : [c];
  const pieces: Uint8Array[] = [];
  let exhausted = false;
  for (const part of parts) {
    const s = await doc.resolve(part);
    if (!isStream(s)) continue;
    const d = await doc.decode(s);
    if (!d) continue;
    // Parts are read as one stream, a line apart: a token never runs from one into the next.
    if (pieces.length > 0) pieces.push(NEWLINE);
    pieces.push(d.data);
    if ((exhausted = d.exhausted)) break;
  }
  if (pieces.length === 0) return null;
  if (pieces.length === 1) return { data: pieces[0]!, exhausted, held: 0 };
  // Joining is a new allocation of every part's size — a part named twice is joined twice —
  // so it is charged before it is made, and given back once the page is read (#2062 r3).
  const held = pieces.reduce((n, p) => n + p.length, 0);
  doc.retained.take(held);
  return { data: concatBytes(pieces), exhausted, held };
}

/** Walk the page tree in order, drawing each page: depth- and node-bounded, ancestors refused. */
async function readPages(r: Reading, node: PdfValue, inherited: PdfDict | null, depth: number): Promise<void> {
  if (depth > PDF_TREE_DEPTH_MAX) throw new MalformedInput('the PDF page tree is nested too deeply');
  const num = isRef(node) ? node.num : null;
  if (num !== null && r.ancestors.has(num)) throw new MalformedInput('the PDF page tree loops');
  if ((r.visited += 1) > PDF_TREE_NODES_MAX) throw new Enough();
  const dict = await r.doc.resolveDict(node);
  if (!dict) return;
  const resources = (await r.doc.resolveDict(dict.get('Resources'))) ?? inherited;
  const kids = await r.doc.resolve(dict.get('Kids'));
  if (Array.isArray(kids)) {
    if (num !== null) r.ancestors.add(num);
    try {
      for (const kid of kids) await readPages(r, kid, resources, depth + 1);
    } finally {
      if (num !== null) r.ancestors.delete(num);
    }
    return;
  }
  const content = await pageContent(r.doc, dict).catch(onlyDamage(null));
  if (!content) return;
  // A damaged page keeps the text read before the damage; the next page still reads.
  try {
    await interpret(r, content.data, resources, 0).catch(onlyDamage(undefined));
  } finally {
    r.doc.retained.give(content.held);
  }
  emit(r, '\n\n');
  if (content.exhausted) throw new Enough();
}

/**
 * A PDF's text, in page order. `{ text, truncated }` like every extractor here; a file that is
 * not a readable PDF throws `MalformedInput` and one that breaks a bound
 * `ExtractionBoundExceeded`, which the extractor turns into `{ failed }`.
 */
export async function pdfExtract(
  body: Uint8Array,
  maxInflatedBytes: number,
  maxTextBytes: number,
  signal: ExtractionSignal,
  /** The memory budget; the package's own tests pass one to read what was charged. */
  retained: Retained = new Retained(maxInflatedBytes * PDF_RETAINED_FACTOR + PDF_RETAINED_BASE),
): Promise<{ text: string; truncated: boolean }> {
  if (latin1(body.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new MalformedInput('not a PDF file');
  const pace = new Pace(signal);
  const doc = new PdfDocument(body, { remaining: maxInflatedBytes }, pace, retained);
  let root: PdfDict | null = null;
  const refuseEncrypted = (): void => {
    if (doc.trailer.has('Encrypt')) throw new Refusal('the PDF is encrypted, and encrypted PDFs are not read');
  };
  try {
    await readXref(doc);
    refuseEncrypted();
    root = await doc.resolveDict(doc.trailer.get('Root'));
  } catch (err) {
    // A refusal or a bound is the file's answer; only DAMAGE earns a second way in.
    if (!(err instanceof MalformedInput) || err instanceof Refusal) throw err;
  }
  if (!root) {
    await scanObjects(doc);
    root = await doc.resolveDict(doc.trailer.get('Root'));
  }
  refuseEncrypted();
  if (!root) throw new MalformedInput('the PDF has no document catalog');
  const r: Reading = {
    doc,
    out: [],
    collected: 0,
    limit: maxTextBytes * COLLECT_FACTOR,
    interpretLeft: maxInflatedBytes * PDF_INTERPRET_FACTOR,
    fonts: new WeakMap(),
    drawing: new Set(),
    ancestors: new Set(),
    visited: 0,
  };
  let truncated = false;
  try {
    await readPages(r, root.get('Pages') ?? null, null, 0);
  } catch (err) {
    // A spent memory bound while reading pages ends the reading as the text budget does: what
    // was read is kept, marked cut. Before the pages, it fails the file (`extractWith`).
    if (!(err instanceof Enough) && !(err instanceof RetainedBoundExceeded)) throw err;
    truncated = true;
  }
  return { text: r.out.join(''), truncated };
}

/** The glyph-name and encoding tables, for the package's own tests. */
export const pdfTables = { glyphText, WIN_ANSI, MAC_ROMAN, STANDARD };

/** The stream decoders, for the package's own tests: each judged on what it charges and keeps. */
export const pdfDecoders = { unpredict, asciiHex, ascii85, runLength, lzw };

/** The lexer, for the package's own tests: judged on what it charges for one token. */
/** The CMap parser, for the package's own tests. */
export const pdfCMap = (data: Uint8Array, pace: Pace, retained: Retained): Promise<{ map: { get(length: number, code: number): string | undefined } }> =>
  parseCMap(data, pace, retained);
/** What a font's decoder is charged, for the package's own tests. */
export const pdfFontCosts = { simple: SIMPLE_FONT_COST, difference: DIFFERENCE_COST, composite: COMPOSITE_FONT_COST };
export const pdfLexer = (buf: Uint8Array, pace: Pace): { next(): unknown } => new Lexer(buf, 0, buf.length, pace);
