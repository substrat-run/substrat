import { z } from 'zod';

// The one money representation (K-14). Decimal strings, never floats — the
// Tier 1 ↔ Tier 2 reconciliation guarantee (plan §5.3) needs uniform,
// exact money handling across every engine. Multi-currency from day one
// (SEK/NOK evidence in the FSM survey).

export const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/) // ISO 4217
  .brand<'CurrencyCode'>();
export type CurrencyCode = z.infer<typeof currencyCode>;

export const moneyAmount = z
  .string()
  .regex(/^-?\d+(\.\d{1,6})?$/)
  .brand<'MoneyAmount'>();
export type MoneyAmount = z.infer<typeof moneyAmount>;

export const money = z.object({
  amount: moneyAmount,
  currency: currencyCode,
});
export type Money = z.infer<typeof money>;

// ---------------------------------------------------------------------------
// Exact decimal arithmetic on micro-units (6 dp, bigint) — the ONLY sanctioned
// way engines compute with money. Half-up rounding at the 6th decimal.
// ---------------------------------------------------------------------------

const SCALE = 1_000_000n;

function toMicro(decimal: string): bigint {
  const negative = decimal.startsWith('-');
  const parts = (negative ? decimal.slice(1) : decimal).split('.');
  const intPart = parts[0] ?? '0';
  const fracPart = parts[1] ?? '';
  const micro = BigInt(intPart) * SCALE + BigInt(fracPart.padEnd(6, '0').slice(0, 6));
  return negative ? -micro : micro;
}

function fromMicro(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const intPart = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}`;
}

/** quantity × unit price, half-up at 6 dp. Both args are decimal strings. */
export function mulDecimal(qty: string, amount: string): string {
  const product = toMicro(qty) * toMicro(amount);
  const sign = product < 0n ? -1n : 1n;
  const abs = product < 0n ? -product : product;
  return fromMicro(sign * ((abs + SCALE / 2n) / SCALE));
}

export function addDecimal(a: string, b: string): string {
  return fromMicro(toMicro(a) + toMicro(b));
}

/**
 * a × b ÷ divisor, half-up at 6 dp, rounded once at the end. For a rate quoted per many units
 * (USD per million rows): dividing either side first would round a small quantity to zero.
 * `divisor` is a positive integer.
 */
export function mulDivDecimal(a: string, b: string, divisor: number | bigint): string {
  const d = BigInt(divisor);
  if (d <= 0n) throw new RangeError(`divisor must be a positive integer, got ${String(divisor)}`);
  const product = toMicro(a) * toMicro(b);
  const sign = product < 0n ? -1n : 1n;
  const abs = product < 0n ? -product : product;
  const den = SCALE * d;
  return fromMicro(sign * ((abs + den / 2n) / den));
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const [ma, mb] = [toMicro(a), toMicro(b)];
  return ma < mb ? -1 : ma > mb ? 1 : 0;
}

export function moneyOf(amount: string, currency: string): Money {
  return money.parse({ amount, currency });
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return moneyOf(addDecimal(a.amount, b.amount), a.currency);
}

export function mulMoney(qty: string, unitPrice: Money): Money {
  return moneyOf(mulDecimal(qty, unitPrice.amount), unitPrice.currency);
}
