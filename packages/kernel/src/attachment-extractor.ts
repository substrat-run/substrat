/**
 * The attachment extractor seam (#1575, K-43): where file formats stop and text begins.
 *
 * **The kernel indexes attachment text; it does not parse file formats** (K-43). Every
 * parser — text and HTML decoding, the zip reader and its inflate budget, DOCX/XLSX/PPTX,
 * and later PDF and OCR — lives behind this seam in a host-side package
 * (`@substrat-run/attachment-extractors`), which neither the kernel nor an adapter imports.
 * Whoever constructs the host passes the extractors in; a host given none records every
 * type `unsupported`, with that reason, which is a valid configuration rather than a broken
 * one. `lint:deps` refuses an import of that package from the kernel or an adapter.
 *
 * The parsers are the riskiest code in the feature — a zip reader exists to be handed hostile
 * input — so this file holds them to the guarantees that protect the SCOPE, whatever an
 * extractor does:
 *
 * - **The input bound is judged before a byte is fetched**, on the RECORDED size, against the
 *   smaller of the kernel's ceiling and the extractor's own `maxInputBytes`.
 * - **A time budget.** An extractor that has not answered within `timeoutMs` is recorded
 *   `failed`. (A synchronous loop cannot be interrupted from here; the runtime's CPU limit is
 *   the backstop for that, and the extractor package's own budgets are the first line.)
 * - **A throw is an outcome, not a retry.** An extractor that throws records `failed`, so a
 *   file that crashes its parser cannot fail its job forever. The thrown message is NOT
 *   recorded: it is the parser's text, and it may quote the file.
 * - **The result is validated.** Anything but `{ text }` or `{ failed }` is `failed`.
 * - **The output cap is enforced here, after the extractor returns** — normalized, then cut to
 *   `maxTextBytes` of UTF-8 on a code point boundary and recorded `truncated`. An extractor
 *   is told the cap as a hint (so it can stop reading early) and cannot exceed it.
 */

declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new (label?: string) => { decode(input?: Uint8Array): string };
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** What an extractor is handed. `maxTextBytes` is the kernel's output cap, as a hint. */
export interface AttachmentExtractorInput {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
  /** The kernel cuts the text to this many UTF-8 bytes anyway; an extractor may stop early. */
  readonly maxTextBytes: number;
}

/**
 * What an extractor answers: the file's text, or a reason it has none. `failed` is for a
 * file that is not what it says or that broke a bound; its reason is recorded verbatim, so it
 * must never quote the file. `truncated` says the extractor itself stopped early.
 */
export type AttachmentExtractorResult = { text: string; truncated?: boolean } | { failed: string };

/**
 * One format's parser (K-43). The host is handed a list; the first that `accepts` a file
 * extracts it.
 */
export interface AttachmentExtractor {
  /** Recorded as the row's `extractor` — `text`, `html`, `docx`. Unique within a host. */
  readonly name: string;
  /**
   * The largest file this extractor will be handed, judged on the recorded size BEFORE the
   * bytes are fetched. The kernel's own ceiling applies as well; the smaller one wins.
   */
  readonly maxInputBytes?: number;
  /** Whether this extractor reads a file of this declared type (and name). */
  accepts(contentType: string, filename: string): boolean;
  extract(input: AttachmentExtractorInput): Promise<AttachmentExtractorResult>;
}

/** What one extraction recorded. `indexed` is the only outcome that carries text. */
export type ExtractionOutcome =
  | { status: 'indexed'; extractor: string; text: string; truncated: boolean }
  | { status: 'empty'; extractor: string }
  | { status: 'unsupported'; detail: string }
  | { status: 'failed'; extractor: string | null; detail: string };

/** The bounds the kernel holds every extractor to. */
export interface AttachmentTextBounds {
  /** The ceiling on a file's recorded size; an extractor may declare a lower one. */
  readonly maxInputBytes: number;
  /** UTF-8 bytes of text one attachment may contribute to the index. */
  readonly maxTextBytes: number;
  /** How long one extraction may take before it is recorded `failed`. */
  readonly timeoutMs: number;
}

/**
 * The defaults. `maxTextBytes` is 512 KiB of UTF-8 — a few hundred pages of prose, and a
 * quarter of the ~2 MB a Durable Object row holds. 32 MiB of input is what a Worker can hold
 * as bytes beside what it decodes from them.
 */
export const DEFAULT_ATTACHMENT_TEXT_BOUNDS: AttachmentTextBounds = {
  maxInputBytes: 32 * 1024 * 1024,
  maxTextBytes: 512 * 1024,
  timeoutMs: 30_000,
};

/** `Text/Plain; charset=UTF-8` → `text/plain`. */
export function mediaTypeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/** Refuse a host's extractor list it could not record honestly: a nameless or repeated name. */
export function assertAttachmentExtractors(extractors: readonly AttachmentExtractor[]): void {
  const seen = new Set<string>();
  for (const e of extractors) {
    if (typeof e.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(e.name)) {
      throw new Error(`attachment extractor name '${String(e.name)}' is not a short lowercase identifier`);
    }
    if (seen.has(e.name)) throw new Error(`attachment extractor '${e.name}' is registered twice`);
    seen.add(e.name);
  }
}

/** The first extractor that reads this file, or none. An `accepts` that throws reads as a no. */
export function chooseAttachmentExtractor(
  extractors: readonly AttachmentExtractor[],
  contentType: string,
  filename: string,
): AttachmentExtractor | undefined {
  return extractors.find((e) => {
    try {
      return e.accepts(contentType, filename) === true;
    } catch {
      return false;
    }
  });
}

const utf8 = new TextEncoder();

/**
 * Cut `text` to at most `maxBytes` of UTF-8, on a code point boundary.
 *
 * Encodes once and backs off over continuation bytes (`10xxxxxx`), so a cut never splits
 * a multi-byte character into a replacement character at the end of the index.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = utf8.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  return { text: new TextDecoder('utf-8').decode(bytes.subarray(0, cut)), truncated: true };
}

/**
 * Whitespace collapsed, control characters dropped, line structure kept.
 *
 * For the index whitespace is noise, and for the cap it is worse: a spreadsheet's padding
 * or an HTML file's indentation would spend the per-attachment budget on nothing.
 */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // C0 controls other than tab and newline, DEL, and the C1 range.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const TIMED_OUT = Symbol('timed out');

/** A recorded reason is short: an extractor's `failed` is cut, never trusted to be. */
const DETAIL_MAX = 500;

/**
 * Run one extractor and turn whatever it does into an outcome the kernel can record: the
 * time budget, the throw, the shape and the output cap, all judged here, after it returns.
 */
export async function runAttachmentExtractor(
  extractor: AttachmentExtractor,
  input: { body: Uint8Array; contentType: string; filename: string },
  bounds: AttachmentTextBounds = DEFAULT_ATTACHMENT_TEXT_BOUNDS,
): Promise<ExtractionOutcome> {
  const failed = (detail: string): ExtractionOutcome => ({
    status: 'failed',
    extractor: extractor.name,
    detail: detail.slice(0, DETAIL_MAX),
  });
  let timer: unknown;
  let result: unknown;
  try {
    result = await Promise.race([
      // Called inside the race, so a synchronous throw lands in the catch below too.
      Promise.resolve().then(() => extractor.extract({ ...input, maxTextBytes: bounds.maxTextBytes })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), bounds.timeoutMs);
      }),
    ]);
  } catch (err) {
    // The message is the parser's text and may quote the file; only its kind is recorded.
    const kind = err instanceof Error && /^[A-Za-z][\w$]{0,63}$/.test(err.name) ? err.name : 'a value';
    return failed(`extractor '${extractor.name}' threw (${kind})`);
  } finally {
    clearTimeout(timer);
  }
  if (result === TIMED_OUT) return failed(`extractor '${extractor.name}' did not answer within ${bounds.timeoutMs} ms`);
  const r = result as Record<string, unknown> | null;
  if (r !== null && typeof r === 'object' && typeof r.failed === 'string' && !('text' in r)) return failed(r.failed);
  if (
    r === null ||
    typeof r !== 'object' ||
    typeof r.text !== 'string' ||
    // Both answers at once is no answer: neither half can be trusted over the other.
    'failed' in r ||
    (r.truncated !== undefined && typeof r.truncated !== 'boolean')
  ) {
    return failed(`extractor '${extractor.name}' returned an unreadable result`);
  }
  const cut = truncateUtf8(normalizeExtractedText(r.text), bounds.maxTextBytes);
  if (cut.text.length === 0) return { status: 'empty', extractor: extractor.name };
  return { status: 'indexed', extractor: extractor.name, text: cut.text, truncated: cut.truncated || r.truncated === true };
}
