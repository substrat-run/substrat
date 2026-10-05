/**
 * What every parser in this package shares: the runtime's web-standard decoders, the errors a
 * FILE can cause (each answered `{ failed }` with a content-free reason), and `Pace`, the
 * cooperation with the kernel's time budget. `index.ts` says what the bounds are and why.
 */
import { EXTRACTION_STRIDE, type ExtractionSignal } from '@substrat-run/kernel';

export interface Decoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

/** A decompression stream, typed by the members the parsers use. */
interface Inflater {
  readonly writable: {
    getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };
  };
  readonly readable: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
    };
  };
}

// Web-standard and present in Node >= 18 and workerd; typed here because the package builds
// without DOM typings, as the kernel types `TextEncoder`. Read off `globalThis` rather than
// declared ambient, so a module that imports them gets the runtime's own constructors.
const web = globalThis as unknown as {
  TextDecoder: new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) => Decoder;
  DecompressionStream: new (format: 'deflate-raw' | 'deflate') => Inflater;
};
export const TextDecoder = web.TextDecoder;
export const DecompressionStream = web.DecompressionStream;

declare function setTimeout(fn: () => void, ms: number): unknown;

/** Raised when a bound refuses the work. Distinct so the answer can say which bound. */
export class ExtractionBoundExceeded extends Error {}

/** A file that is not what its type says, or is damaged. Carries a content-free reason. */
export class MalformedInput extends Error {}

/** The kernel's budget ran out and aborted the signal: the extraction stops where it is. */
export class ExtractionAborted extends Error {}

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
export async function checkpoint(signal: ExtractionSignal): Promise<void> {
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
export class Pace {
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

/** A per-file inflate budget, shared by every part or stream one extraction reads. */
export interface InflateBudget {
  remaining: number;
}
