/**
 * The address an account carries when nobody has given it one.
 *
 * Better Auth's `user.email` is required and unique, and an identity-only sign-in has no
 * address to put there, so the account gets one under `.invalid` (RFC 2606): it can never
 * receive mail and can never collide with a real person's.
 *
 * Dependency-free on purpose, as `user-import-wire.ts` is: the admin app imports it too.
 */

const PLACEHOLDER_SUFFIX = '.placeholder.invalid';

/** Is this an address nobody can receive mail at — so nothing a relying party or an operator
 *  should treat as an address? */
export function isPlaceholderAddress(email: string): boolean {
  return email.trim().toLowerCase().endsWith(PLACEHOLDER_SUFFIX);
}

/**
 * A BankID account's address. Random, and never derived from the person: this column is what
 * the `email` claim, the console and every export read, and a personal number is a sensitive
 * identifier that belongs in `account.account_id` alone.
 */
export function bankidPlaceholderAddress(): string {
  return `bankid-${crypto.randomUUID()}@bankid${PLACEHOLDER_SUFFIX}`;
}
