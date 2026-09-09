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
//
// The floor lives in MEMORY, so it is only as old as the mint. A host that closes and
// reopens — or a Durable Object that is evicted and revived — starts again from the
// clock alone, and if that clock now reads behind the last id it persisted, the next
// id sorts underneath rows that are already stored. Within one mint's life the
// ordering is a guarantee; across a restart it rests on the clock moving forward.
// Closing that gap means seeding the floor from the persisted maximum, which is #1335.

// WebCrypto is a global on every WinterTC runtime (Workers, Node 18+, Bun, Deno);
// declared locally so the kernel needs no platform type packages (§5.8).
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The largest instant 48 bits can hold — `7ZZZZZZZZZ`, some time in 10889 AD. */
const MAX_ULID_TIME = 2 ** 48 - 1;

/** All 26 digits, Crockford's alphabet — `I`, `L`, `O` and `U` are not in it. */
const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const unencodable = (t: number): string =>
  `not an encodable ULID instant: ${t} (want 0..${MAX_ULID_TIME})`;

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
    // Not a clock reading at all. `NaN` (an unparseable timestamp) is the one that
    // matters: every comparison below is false for it, so it would sail through the
    // floor untouched and encode as a run of `undefined`s.
    if (!Number.isSafeInteger(now)) throw new RangeError(unencodable(now));
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
    // Judged AFTER the floor, because the floor is what a backwards clock is for:
    // rewinding to 1969 on a mint that has already stamped 2026 holds at 2026 and
    // is not an error. What no floor can rescue is an instant 48 unsigned bits do
    // not reach — before the epoch on a mint that has stamped nothing yet, or past
    // the year 10889 — and `B32[time % 32]` spells those as `undefined`.
    if (time < 0 || time > MAX_ULID_TIME) throw new RangeError(unencodable(time));
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
 * Refuses anything that is not a ULID rather than decoding a prefix: a truncated id
 * decodes to a plausible-looking number, which is worse than a throw. All 26 digits
 * are judged, not the ten this reads — an id whose random half is outside Crockford's
 * alphabet is malformed whether or not the half carrying the timestamp is fine.
 *
 * The timestamp is bounded as well as shaped. Ten base32 digits hold 50 bits and the
 * timestamp is 48, so a first digit of `8` through `Z` is not a far-future date, it is
 * not a ULID — and decoding it would hand back a millisecond nothing can have minted.
 */
export function ulidTime(id: string): number {
  // The alphabet gate: past it, every digit is in `B32` and `indexOf` cannot miss.
  if (!ULID_SHAPE.test(id)) throw new Error(`not a ULID: ${id}`);
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + B32.indexOf(ch);
  if (t > MAX_ULID_TIME) throw new Error(`not a ULID: ${id}`);
  return t;
}
