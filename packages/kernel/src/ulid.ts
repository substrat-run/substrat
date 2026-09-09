// Minimal ULID: 48-bit timestamp + 80-bit random, Crockford base32.
// Kept dependency-free; kernel IDs must be sortable and opaque.
//
// MONOTONIC within a process (the ULID spec's monotonic factory): two IDs minted
// in the same millisecond still sort in creation order — the low bits increment
// instead of being re-randomized. This is load-bearing: the audit log and the
// event outbox both document "ULID order is chronological" and order by id, so a
// non-monotonic id would make same-millisecond rows sort randomly.
//
// The monotonic state belongs to a WRITER, not to the process (#956). `ulid()` is
// the shared instance every call site has always used; `createUlid()` hands a writer
// its own, which is what lets a host mint ids from an INJECTED clock. With one
// shared floor, a `ulid(t)` for a `t` behind the wall clock is silently pulled
// forward to whatever an unrelated `ulid()` last stamped — so an event id could
// never carry a manual clock's instant. A writer with its own floor still cannot
// go backwards against ITS OWN rows, which is the invariant `ORDER BY id` needs.

// WebCrypto is a global on every WinterTC runtime (Workers, Node 18+, Bun, Deno);
// declared locally so the kernel needs no platform type packages (§5.8).
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A monotonic ULID mint. `now` is epoch milliseconds; it defaults to the wall clock. */
export type UlidMint = (now?: number) => string;

/**
 * A ULID mint with its OWN monotonic state — one writer's floor, not the process's.
 *
 * Hand one to anything that stamps ids from a clock it was given rather than from
 * `Date.now()`, so an unrelated wall-clock mint elsewhere in the isolate cannot pull
 * its timestamps forward. Everything else keeps using the shared `ulid()` below.
 */
export function createUlid(): UlidMint {
  // Monotonic state (per mint — exactly the scope where a single writer orders its
  // own rows). The random part is held as 16 base32 digits (0–31).
  let lastTime = -1;
  const lastRand: number[] = new Array<number>(16).fill(0);

  function freshRandom(): void {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (let i = 0; i < 16; i++) lastRand[i] = bytes[i]! % 32; // 256 % 32 === 0 → uniform
  }

  /** Step the 80-bit random part by one, with carry. Returns false on overflow. */
  function incrementRandom(): boolean {
    for (let i = 15; i >= 0; i--) {
      if (lastRand[i]! < 31) {
        lastRand[i]!++;
        return true;
      }
      lastRand[i] = 0;
    }
    return false; // all digits were 31 — overflowed (astronomically rare)
  }

  return (now: number = Date.now()): string => {
    let time = now;
    if (time <= lastTime) {
      // Same or backwards clock: keep the last timestamp and step the random part
      // so the id still increases. On the (impossible) overflow, bump the ms.
      time = lastTime;
      if (!incrementRandom()) {
        time = lastTime + 1;
        freshRandom();
      }
    } else {
      freshRandom();
    }
    lastTime = time;

    let ts = '';
    let t = time;
    for (let i = 0; i < 10; i++) {
      ts = B32[t % 32] + ts;
      t = Math.floor(t / 32);
    }
    let r = '';
    for (const d of lastRand) r += B32[d];
    return ts + r;
  };
}

/** The process-wide mint every id in the platform has always come from. */
const processUlid = createUlid();

export function ulid(now: number = Date.now()): string {
  return processUlid(now);
}

/**
 * The epoch-millisecond timestamp a ULID carries in its first ten characters.
 *
 * Refuses anything that is not 26 Crockford digits rather than decoding a prefix:
 * a truncated id decodes to a plausible-looking number, which is worse than a throw.
 */
export function ulidTime(id: string): number {
  if (id.length !== 26) throw new Error(`not a ULID: ${id}`);
  let t = 0;
  for (const ch of id.slice(0, 10)) {
    const d = B32.indexOf(ch);
    if (d < 0) throw new Error(`not a ULID: ${id}`);
    t = t * 32 + d;
  }
  return t;
}
