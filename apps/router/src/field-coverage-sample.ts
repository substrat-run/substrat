/**
 * #1923: which dispatched requests the router arms the per-response field walk for. Router
 * policy, so it lives here; the header it sends is the shared vocabulary
 * (`FIELD_COVERAGE_HEADER` in contracts), which the vertical's stamp reads.
 */

/**
 * The router's sample rate, read from its `FIELD_COVERAGE_SAMPLE_RATE` var: a fraction of
 * requests in `(0, 1]`, written as a decimal (`0.01` is one request in a hundred).
 *
 * Strict, and every doubt is off: absent, empty, unparseable, `NaN`, infinite, negative or
 * ABOVE `1` reads as `0`. Above one is refused rather than clamped because the likely
 * meaning of `50` is "one in fifty" or "fifty percent", and clamping either to every request
 * would be the most expensive reading of a typo. The walk is off by default; a router nobody
 * configured arms nothing.
 */
export function fieldCoverageSampleRate(value: unknown): number {
  const rate = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : 0;
}

/**
 * Whether one request is in the sample. `random` is `Math.random` in the router and a fixed
 * value in a test. A rate of `0` never samples and never draws.
 */
export function fieldCoverageSampled(rate: number, random: () => number = Math.random): boolean {
  return rate > 0 && rate <= 1 && (rate === 1 || random() < rate);
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A dispatch id for a sampled request: a ULID (48-bit time, 80 random bits), minted here
 * rather than with the kernel's `ulid`, which the router does not depend on. It needs no
 * monotonic order and no secrecy. What it carries is that the router's own line for the
 * request names it beside the tenant and app the router resolved, and only platform code
 * writes that line.
 */
export function mintDispatchId(now: number = Date.now()): string {
  let time = '';
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) time = B32[t % 32] + time;
  let rand = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) rand += B32[byte % 32];
  return time + rand;
}
