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
// reopens — or a Durable Object that is evicted and revived — would start again from the
// clock alone, and if that clock now read behind the last id it persisted, the next id
// would sort underneath rows that are already stored. `seedFrom()` (#1335) is how a
// writer closes that gap: it hands the mint an id it has ALREADY persisted, and the
// floor is raised to it before the first mint of the new life. The mint cannot read
// storage itself — it has no idea what its writer's rows live in — so the durability
// half is the caller's, and each adapter seeds from `SELECT MAX(id) FROM
// _substrat_outbox` for the scope it is about to mint into.

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
export interface UlidMint {
  (now?: number): string;
  /**
   * Raise the floor to an id this writer has already persisted (#1335), so the next
   * mint is strictly greater than it whatever the clock now says.
   *
   * The floor only ever goes UP: seeding with an id below where the mint already
   * stands is a no-op, so a seed racing an in-flight mint cannot undo it, and seeding
   * twice is harmless. Both halves of the state are taken — the timestamp AND the
   * random digits — because an id minted in the same millisecond has to beat the
   * seed's random half too, and re-randomizing could land below it.
   *
   * Refuses anything that is not a ULID, for `ulidTime`'s reason: a floor decoded
   * from a prefix is a plausible-looking number and would silently sit in the wrong
   * place. Callers read the id back out of their own storage, where the only writer
   * is a mint like this one.
   */
  seedFrom(id: string): void;
}

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

  const mint = ((now: number = Date.now()): string => {
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
  }) as UlidMint;

  mint.seedFrom = (id: string): void => {
    const time = ulidTime(id); // refuses anything that is not a ULID
    if (time < lastTime) return;
    // The random half, as the same 16 base32 digits the mint holds. Past `ulidTime`'s
    // alphabet gate every digit is in `B32`, so `indexOf` cannot miss.
    const rand: number[] = [];
    for (const ch of id.slice(10)) rand.push(B32.indexOf(ch));
    if (time === lastTime) {
      // Same millisecond: only adopt the seed's random half if it is the higher one,
      // or the next `incrementRandom()` would step from below where this mint stands.
      let ahead = false;
      for (let i = 0; i < 16; i++) {
        if (rand[i]! !== lastRand[i]!) {
          ahead = rand[i]! > lastRand[i]!;
          break;
        }
      }
      if (!ahead) return;
    }
    lastTime = time;
    for (let i = 0; i < 16; i++) lastRand[i] = rand[i]!;
  };

  return mint;
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
