/**
 * Exact money arithmetic for the club's two units.
 *
 * Prices are `Money` — decimal strings, per `@substrat-run/contracts`. The wallet
 * ledger is integer öre (minor units), which is already exact. What used to sit
 * between them was `Number(amount) * 100` and `(ore / 100).toFixed(2)`: a float
 * round-trip that is wrong for exactly the amounts a price list contains
 * (`1.005 * 100 === 100.49999…`). Everything here is string and bigint work.
 */
import { moneyOf, type Money } from '@substrat-run/contracts';

const MINOR_UNITS = 2;
const MICRO_PER_UNIT = 1_000_000n;
const MICRO_PER_ORE = 10_000n; // 6 dp → 2 dp

/** A `MoneyAmount` (up to 6 dp) as micro-units — the contracts package's own scale. */
function toMicro(amount: string): bigint {
  const negative = amount.startsWith('-');
  const [intPart = '0', fracPart = ''] = (negative ? amount.slice(1) : amount).split('.');
  const micro = BigInt(intPart) * MICRO_PER_UNIT + BigInt(fracPart.padEnd(6, '0').slice(0, 6));
  return negative ? -micro : micro;
}

/** Integer division, rounded half away from zero. */
function divRoundHalfUp(n: bigint, d: bigint): bigint {
  const negative = n < 0n !== d < 0n;
  const [an, ad] = [n < 0n ? -n : n, d < 0n ? -d : d];
  const q = (an + ad / 2n) / ad;
  return negative ? -q : q;
}

/** A price as integer öre, half-up at the 2nd decimal. `"17.5"` → `1750`. */
export function oreOf(m: Money): number {
  return Number(divRoundHalfUp(toMicro(m.amount), MICRO_PER_ORE));
}

/**
 * Integer öre back to `Money`. Whole kronor render without decimals (`1700` →
 * `"17"`), everything else with the two the unit has (`1750` → `"17.50"`).
 */
export function moneyFromOre(ore: number, currency = 'SEK'): Money {
  if (!Number.isInteger(ore)) throw new Error(`ore must be an integer, got ${ore}`);
  const negative = ore < 0;
  const abs = String(Math.abs(ore)).padStart(MINOR_UNITS + 1, '0');
  const intPart = abs.slice(0, -MINOR_UNITS);
  const frac = abs.slice(-MINOR_UNITS);
  const amount = `${negative ? '-' : ''}${intPart}${frac === '00' ? '' : `.${frac}`}`;
  return moneyOf(amount, currency);
}

/**
 * One player's share of a court, in WHOLE currency units, half-up — the club
 * quotes "170 kr each", never "113.33". `340 / 3` → `"113"`, `345 / 2` → `"173"`.
 */
export function shareOf(price: Money, fillTarget: number): Money {
  const parts = BigInt(Math.max(1, Math.trunc(fillTarget)));
  const units = divRoundHalfUp(toMicro(price.amount), parts * MICRO_PER_UNIT);
  return moneyOf(units.toString(), price.currency);
}
