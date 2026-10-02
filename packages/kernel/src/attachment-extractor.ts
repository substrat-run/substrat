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
 * - **Declarations are checked when the host is built** (`assertAttachmentExtractors`): a
 *   name, `accepts` and `extract`, and a `maxInputBytes` that is a positive integer if it is
 *   given at all. A host refuses a list it could not honour rather than misreading it later.
 * - **The input bound is judged before a byte is fetched**, on the RECORDED size: the kernel's
 *   ceiling FIRST and on its own, then the extractor's declared bound if it is a valid one.
 *   Neither can widen the other — a declaration that slipped past the check (a `NaN`) is
 *   ignored, never allowed to disable the ceiling.
 * - **A throw is an outcome, not a retry.** An extractor that throws records `failed`, so a
 *   file that crashes its parser cannot fail its job forever. The thrown message is NOT
 *   recorded: it is the parser's text, and it may quote the file.
 * - **The result is validated.** Anything but exactly one of `{ text }` or `{ failed }` is
 *   `failed`.
 * - **The output cap is enforced here, after the extractor returns** — normalized, then cut to
 *   `maxTextBytes` of UTF-8 on a code point boundary and recorded `truncated`. An extractor
 *   is told the cap as a hint (so it can stop reading early) and cannot exceed it.
 *
 * ## The time budget is cooperative, and what that means
 *
 * An extractor that has not answered within `timeoutMs` is recorded `failed`, its `signal` is
 * aborted, and anything it answers afterwards is DISCARDED — including an answer that arrives
 * "late" because the extractor never yielded: after it returns, the kernel gives the timer the
 * turn it was owed, and a result the deadline passed is never indexed.
 *
 * What the kernel cannot do from inside one isolate is STOP code that does not yield. A
 * synchronous loop holds the thread until it returns, timer or not; the abort is a request,
 * honoured by an extractor that checks its `signal` and yields a turn at least every
 * `EXTRACTION_STRIDE` units of work (the bundled parsers do, every native search included).
 * So the guarantee is: a cooperative extractor stops
 * promptly, an uncooperative one cannot get its late answer indexed, and only the runtime's
 * own CPU limit ends it sooner. A hard deadline on uncooperative code needs process or
 * isolate isolation — a host can provide it by running its extractors in a separate worker
 * and handing the kernel a thin extractor that calls it. Under K-43 an extractor is
 * HOST-supplied code, trusted as the host is; the budget protects the scope from a slow or
 * broken parser, not from a hostile one, and the bundled parsers bound their own CPU by
 * construction (linear scans under fixed input caps — their package says how far).
 */

declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new (label?: string) => { decode(input?: Uint8Array): string };
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare const AbortController: new () => { readonly signal: ExtractionSignal; abort(): void };

/**
 * How much work a cooperative extractor does between two checks of its `signal`: 256 Ki
 * units, a unit being a character scanned or decoded, or a byte inflated or decoded. Part of
 * the seam's contract rather than of any one parser, because it is what "stops promptly"
 * means above — and the one number both sides of the seam cite.
 */
export const EXTRACTION_STRIDE = 256 * 1024;

/**
 * The cancellation an extractor is handed — the runtime's own `AbortSignal`, typed here by the
 * one member the kernel promises: once `aborted` is true, nothing the extractor answers will be
 * used, and it should stop.
 */
export interface ExtractionSignal {
  readonly aborted: boolean;
}

/** What an extractor is handed. `maxTextBytes` is the kernel's output cap, as a hint. */
export interface AttachmentExtractorInput {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
  /** The kernel cuts the text to this many UTF-8 bytes anyway; an extractor may stop early. */
  readonly maxTextBytes: number;
  /** Aborted when the time budget runs out. A cooperative extractor checks it and yields. */
  readonly signal: ExtractionSignal;
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
   * bytes are fetched — a positive integer. The kernel's own ceiling applies first, whatever
   * this says.
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

/** The bounds the kernel holds every extractor to — each a positive integer. */
export interface AttachmentTextBounds {
  /** The ceiling on a file's recorded size, applied before any extractor's own. */
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

/** A bound that means something: a positive integer. `NaN`, `Infinity`, `0`, `-1` and `'8'` do not. */
export function isPositiveIntegerBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** `Text/Plain; charset=UTF-8` → `text/plain`. */
export function mediaTypeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/** Refuse bounds the kernel could not honour: each must be a positive integer. */
export function assertAttachmentTextBounds(bounds: AttachmentTextBounds): void {
  for (const key of ['maxInputBytes', 'maxTextBytes', 'timeoutMs'] as const) {
    if (!isPositiveIntegerBound(bounds[key])) {
      throw new Error(`attachment text bound ${key} must be a positive integer, not ${String(bounds[key])}`);
    }
  }
}

/**
 * Refuse, when the host is built, an extractor list it could not honour: a missing or
 * repeated name, an `accepts` or `extract` that is not a function, or a `maxInputBytes` that
 * is not a positive integer. Failing here, once, is the alternative to misreading the
 * declaration on every job.
 */
export function assertAttachmentExtractors(extractors: readonly AttachmentExtractor[]): void {
  const seen = new Set<string>();
  for (const e of extractors) {
    if (typeof e?.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(e.name)) {
      throw new Error(`attachment extractor name '${String(e?.name)}' is not a short lowercase identifier`);
    }
    if (typeof e.accepts !== 'function' || typeof e.extract !== 'function') {
      throw new Error(`attachment extractor '${e.name}' must have accepts() and extract()`);
    }
    if (e.maxInputBytes !== undefined && !isPositiveIntegerBound(e.maxInputBytes)) {
      throw new Error(
        `attachment extractor '${e.name}' declares maxInputBytes ${String(e.maxInputBytes)}, ` +
          'which is not a positive integer',
      );
    }
    if (seen.has(e.name)) throw new Error(`attachment extractor '${e.name}' is registered twice`);
    seen.add(e.name);
  }
}

/**
 * Why a file of `size` bytes may not be handed to `extractor`, or null when it may.
 *
 * The kernel's ceiling is judged FIRST and on its own, then the extractor's declaration —
 * and only a valid declaration, so one that slipped past `assertAttachmentExtractors` can
 * narrow nothing and widen nothing. Never a `Math.min` over the two: a `NaN` there makes every
 * comparison false, which is the ceiling switched off.
 */
export function inputBoundRefusal(
  size: number,
  extractor: Pick<AttachmentExtractor, 'maxInputBytes'>,
  bounds: Pick<AttachmentTextBounds, 'maxInputBytes'>,
): string | null {
  if (!(size <= bounds.maxInputBytes)) {
    return `the file is ${size} bytes, over the ${bounds.maxInputBytes}-byte input bound`;
  }
  const declared = extractor.maxInputBytes;
  if (isPositiveIntegerBound(declared) && size > declared) {
    return `the file is ${size} bytes, over the extractor's ${declared}-byte input bound`;
  }
  return null;
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

/**
 * One turn of the event loop — a macrotask, so a due timer runs before what follows. A
 * `setTimeout` on purpose, not the cheaper `setImmediate` the parsers yield with: timers run in
 * order of when they are due, so this one cannot run before a deadline that has already
 * passed, whichever phase of the loop the extractor returned in. It runs once per extraction.
 */
const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const TIMED_OUT = Symbol('timed out');

/** A recorded reason is short: an extractor's `failed` is cut, never trusted to be. */
const DETAIL_MAX = 500;

/**
 * Run one extractor and turn whatever it does into an outcome the kernel can record: the
 * time budget, the throw, the shape and the output cap, all judged here, after it returns.
 * See this file's header for what the budget can and cannot stop.
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
  const timeout = failed(`extractor '${extractor.name}' did not answer within ${bounds.timeoutMs} ms`);
  const controller = new AbortController();
  let timedOut = false;
  let onTimeout: (value: typeof TIMED_OUT) => void = () => {};
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    onTimeout(TIMED_OUT);
  }, bounds.timeoutMs);
  // Called inside a promise chain, so a synchronous throw lands in the catch below too. Its
  // eventual rejection is handled here, so an extractor abandoned at the deadline that fails
  // later cannot surface as an unhandled rejection.
  const work = Promise.resolve().then(() =>
    extractor.extract({ ...input, maxTextBytes: bounds.maxTextBytes, signal: controller.signal }),
  );
  work.catch(() => {});
  let result: unknown;
  let threw: unknown = undefined;
  let didThrow = false;
  try {
    result = await Promise.race([work, new Promise<typeof TIMED_OUT>((resolve) => (onTimeout = resolve))]);
  } catch (err) {
    didThrow = true;
    threw = err;
  }
  // A SYNCHRONOUS extractor returns before its timer can run, however long it took. Give the
  // timer the turn it was owed: if the deadline passed meanwhile, the answer is discarded.
  if (!timedOut) await nextTurn();
  clearTimeout(timer);
  if (timedOut || result === TIMED_OUT) return timeout;
  if (didThrow) {
    // The message is the parser's text and may quote the file; only its kind is recorded.
    const kind = threw instanceof Error && /^[A-Za-z][\w$]{0,63}$/.test(threw.name) ? threw.name : 'a value';
    return failed(`extractor '${extractor.name}' threw (${kind})`);
  }
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
