import { currencyCode, moneyAmount, type CurrencyCode, type MoneyAmount } from '@substrat-run/contracts';

/**
 * Money between Substrat's decimal strings and Stripe's integer minor units, exactly.
 *
 * Stripe takes and answers every amount as an integer count of the currency's smallest unit: öre
 * for SEK, cents for EUR, whole yen for JPY. A wrong exponent charges a buyer a hundred times too
 * much or too little, so this module refuses rather than guesses:
 *
 * - **No rounding.** An amount with more decimals than the currency carries is refused unless the
 *   extra digits are zeros (`'12.500'` SEK is 1250; `'12.505'` SEK is refused).
 * - **No float.** Digits are moved as text and summed as `BigInt`.
 * - **No special case.** Stripe documents a handful of currencies whose API exponent is not their
 *   ISO one (ISK, HUF, TWD, UGX) and five three-decimal ones it rounds (BHD, JOD, KWD, OMR, TND).
 *   They are refused by name, so a charge in one of them fails here with a sentence instead of
 *   being off by a factor at the buyer's bank.
 *
 * The exponent table is Stripe's "zero-decimal currencies" list; every other currency Stripe
 * supports is two-decimal.
 */

const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const REFUSED = new Set(['ISK', 'HUF', 'TWD', 'UGX', 'BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** Stripe's largest amount for one charge: eight digits of minor units. */
export const STRIPE_MAX_AMOUNT = 99_999_999;

export class StripeMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeMoneyError';
  }
}

/** How many decimals Stripe's minor unit has for `currency`; throws for one this module refuses. */
export function stripeExponent(currency: string): 0 | 2 {
  const code = currency.toUpperCase();
  if (REFUSED.has(code)) {
    throw new StripeMoneyError(
      `${code} is one of the currencies Stripe amounts differently from its ISO exponent; the connector does not charge in it`,
    );
  }
  return ZERO_DECIMAL.has(code) ? 0 : 2;
}

/** A non-negative decimal string as Stripe's integer minor units, or a refusal. */
export function toMinorUnits(amount: MoneyAmount | string, currency: CurrencyCode | string): number {
  const exponent = stripeExponent(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) throw new StripeMoneyError(`'${amount}' is not a non-negative decimal amount`);
  const whole = match[1]!;
  const fraction = match[2] ?? '';
  const kept = fraction.slice(0, exponent);
  if (/[^0]/.test(fraction.slice(exponent))) {
    throw new StripeMoneyError(`${amount} ${currency.toUpperCase()} has more decimals than the currency carries; it is never rounded`);
  }
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(kept.padEnd(exponent, '0') || '0');
  if (minor > BigInt(STRIPE_MAX_AMOUNT)) {
    throw new StripeMoneyError(`${amount} ${currency.toUpperCase()} is more than Stripe takes in one amount`);
  }
  return Number(minor);
}

/** Stripe's integer minor units as a decimal string with the currency's decimals. */
export function fromMinorUnits(minor: number, currency: string): MoneyAmount {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new StripeMoneyError(`Stripe answered an amount that is not a whole number of minor units: ${minor}`);
  const exponent = stripeExponent(currency);
  const digits = String(minor).padStart(exponent + 1, '0');
  const text = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  return moneyAmount.parse(text);
}

/** Stripe's lowercase currency as an ISO code. */
export function currencyOf(stripeCurrency: string): CurrencyCode {
  const parsed = currencyCode.safeParse(stripeCurrency.toUpperCase());
  if (!parsed.success) throw new StripeMoneyError(`Stripe answered a currency that is not an ISO 4217 code: '${stripeCurrency}'`);
  return parsed.data;
}
