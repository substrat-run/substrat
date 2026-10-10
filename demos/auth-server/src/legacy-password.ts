import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword } from 'better-auth/crypto';

/**
 * Password hashing that also accepts the hashes another issuer left behind.
 *
 * An issuer moving its people here from somewhere else brings their passwords as that
 * system's hashes — for an Auth0-shaped issuer, bcrypt (`$2a$`/`$2b$`/`$2y$`). Better Auth
 * hashes with scrypt and its default verify knows nothing else, so an imported hash would
 * be a password nobody can ever sign in with: every migrated person would be sent through
 * a reset.
 *
 * So verify reads the hash's own prefix and checks it with the scheme it names. Hashing is
 * untouched: a new password, a reset or a change always writes scrypt, so a bcrypt row
 * stops existing the first time its owner sets a password here. A bcrypt hash is never
 * WRITTEN by this issuer — only `POST /__admin/users/import` stores one, and it refuses
 * any hash this function would not recognise.
 *
 * `bcryptjs` rather than a native binding: it is pure JS, so it runs in workerd and node
 * alike, and a hand-rolled bcrypt would be the thing the repo's rules forbid.
 */

/**
 * `$2a$10$` + 53 characters of salt and digest — the only legacy shape this issuer accepts.
 *
 * The cost is capped at 12, and that cap is a denial-of-service guard, not a style choice:
 * `bcrypt.compare` runs in pure JS inside the issuer's single-threaded Durable Object, so a
 * cost-25 hash would let anybody who knows that address stall sign-in for the whole issuer by
 * posting wrong passwords at it. Cost 12 is a few hundred milliseconds; every common issuer
 * default (10, 12) fits under it. A hash above it is refused at import, never stored.
 */
const BCRYPT = /^\$2[aby]\$(0[4-9]|1[0-2])\$[./A-Za-z0-9]{53}$/;

export function isBcryptHash(hash: string): boolean {
  return BCRYPT.test(hash);
}

export const legacyAwarePassword = {
  hash: (password: string): Promise<string> => hashPassword(password),
  verify: ({ hash, password }: { hash: string; password: string }): Promise<boolean> =>
    isBcryptHash(hash) ? bcrypt.compare(password, hash) : verifyPassword({ hash, password }),
};
