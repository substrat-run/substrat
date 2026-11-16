/**
 * The verified-address rule (K-61 phase 3, docs/rfc/verified-address.md §5), in its own module so
 * the member directory and the owner seat (#3202) share one comparison without importing each other.
 */

/**
 * Does a session whose issuer verified `verified` (null: no address, or none it vouched for) answer
 * an invite naming `invited` (K-61 phase 3)? An invite naming NO address is a bearer link, for
 * whoever presents it: the path for an issuer that verifies no address. One naming an address is
 * for a verified holder of that address and nobody else, so a forwarded link and a sign-in whose
 * address the issuer did not verify are both refused. Compared as docs/rfc/verified-address.md §5
 * says, with surrounding space ignored and no provider's own rules applied: Unicode-normalised (NFC,
 * so two spellings of one character match) and lowercased — ASCII letters only, because a full
 * Unicode lowercase merges characters no normalisation equates (U+03F4, the theta symbol, becomes
 * U+03B8), and an address an issuer verified must not answer for another one.
 */
export function addressAdmits(invited: string | null, verified: string | null): boolean {
  if (invited === null) return true;
  return verified !== null && addressKey(invited) === addressKey(verified);
}

const addressKey = (address: string): string =>
  address.trim().normalize('NFC').replace(/[A-Z]/g, (letter) => letter.toLowerCase());
