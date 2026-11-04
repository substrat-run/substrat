/**
 * A Swedish organisationsnummer, read the way Bolagsverket's register keys it.
 *
 * Accepted spellings: `NNNNNN-NNNN`, ten bare digits, or twelve digits with the century
 * prefix `16` that a legal entity's number carries in twelve-digit form, any of them with
 * surrounding whitespace. The canonical form is the ten bare digits, which is what the
 * API is asked with and what a result names.
 *
 * **Legal entities only.** A sole trader's organisation number is their personnummer, so
 * a lookup by it sends a person's identity number to a third party and lands it in the
 * scope that asked. v1 refuses one locally instead: a personnummer has a month (01–12,
 * or 61–72 on a samordningsnummer's day, which leaves the month alone) in digits three
 * and four, while a legal entity's number has 20 or more there. The same holds for the
 * twelve-digit spelling, whose `19`/`20` century prefix only a person's number carries.
 *
 * A refused number is never sent: a typo answered "not found" by the provider would read
 * as a fact about the register, and a typo answered by a checksum is a fact about the
 * input.
 */

declare const orgnrBrand: unique symbol;
/** Ten digits, Luhn-valid, a legal entity's: only {@link parseOrgnr} makes one. */
export type Orgnr = string & { readonly [orgnrBrand]: true };

/** Why a number was refused before it reached the provider. */
export type OrgnrRefusal = 'format' | 'checksum' | 'personnummer';

export type OrgnrParse = { ok: true; orgnr: Orgnr } | { ok: false; reason: OrgnrRefusal };

/** The Luhn check over ten digits, the check digit included. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = digits.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function parseOrgnr(input: string): OrgnrParse {
  const m = /^(\d{2})?(\d{6})-?(\d{4})$/.exec(input.trim());
  if (!m) return { ok: false, reason: 'format' };
  const [, century, head, tail] = m;
  const digits = `${head}${tail}`;
  if (!luhnValid(digits)) return { ok: false, reason: 'checksum' };
  if (century === '19' || century === '20' || digits.charCodeAt(2) < 50) {
    return { ok: false, reason: 'personnummer' };
  }
  if (century !== undefined && century !== '16') return { ok: false, reason: 'format' };
  return { ok: true, orgnr: digits as Orgnr };
}
