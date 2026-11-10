import type { SqlExec } from './introspect.js';
import { mergeText, sanitizeTheme, type ClientTheme } from './theme-wire.js';

export { sanitizeTheme, type ClientTheme };

/**
 * Per-client theming for the hosted OIDC pages (`/login`, `/signup`, `/consent`).
 *
 * A relying party's operator styles the screens their users are sent to by putting a
 * `theme` object into the client's free-form `metadata` — the column the registry already
 * has, written through the existing admin PATCH, so there is no second write path and no
 * migration. This module is the READ side both runtimes share (the Durable Object and the
 * node dev server), exactly as `admin-api.ts` is for the admin surface.
 *
 * The vocabulary is deliberately Clerk-shaped (`colorPrimary`, `borderRadius`, …): it is
 * the best-known theming contract in the auth space, and a developer who has themed Clerk
 * should not need docs here. Each key maps onto one CSS custom property in the SPA's
 * `tokens.css` (the mapping lives in `app/src/theme-apply.ts`). The vocabulary and its checks
 * are in `theme-wire.ts`.
 *
 * An issuer has a theme of its own too (`ISSUER_THEME`, a declared config key like every other
 * setting): it is what every screen starts from, and the only theme a screen with no relying
 * party behind it — an invitation, a password reset — has to go on. A client's keys win over it
 * one at a time.
 *
 * Two decisions that are security posture, not style:
 *
 *  - **The public read returns ONLY the sanitized theme** — never the client's name, icon
 *    or existence. `public-client-prelogin` resolves a client id to a name only inside a
 *    validly SIGNED authorize query, precisely so the registry cannot be enumerated by a
 *    stranger; a branding endpoint that answered "unknown client" differently from "no
 *    theme" would be the oracle that design refused. So unknown, disabled and unthemed
 *    clients all answer with the issuer's theme alone, indistinguishably.
 *  - **Every value is validated on the way out, key by key.** Metadata is operator-written
 *    JSON; these values land in CSS custom properties and an <img src>. A key that fails
 *    its check is dropped while the rest survive — a typo in one color must not turn the
 *    whole login screen back to defaults.
 */

/** The declared key holding the issuer's own theme, as one JSON document. */
export const ISSUER_THEME = 'ISSUER_THEME';

/** The issuer's theme from its config value. Anything that does not parse is no theme. */
export function issuerTheme(value: string | undefined): ClientTheme {
  if (!value) return {};
  try {
    return sanitizeTheme(JSON.parse(value));
  } catch {
    return {};
  }
}

/**
 * The public branding answer for a client id: `{ theme }`, always 200-shaped, the client's
 * keys over the issuer's one by one. Unknown id, disabled client, absent or malformed metadata
 * all yield the issuer's theme alone — deliberately indistinguishable (see the header).
 */
export function clientBranding(
  sql: SqlExec,
  clientId: string | null | undefined,
  issuerThemeValue: string | undefined,
): { theme: ClientTheme } {
  const issuer = issuerTheme(issuerThemeValue);
  const own = ownTheme(sql, clientId);
  const text = mergeText(issuer.text, own.text);
  return { theme: { ...issuer, ...own, ...(text ? { text } : {}) } };
}

function ownTheme(sql: SqlExec, clientId: string | null | undefined): ClientTheme {
  if (!clientId) return {};
  const row = sql
    .exec('SELECT metadata, disabled FROM oauth_client WHERE client_id = ?', clientId)
    .toArray()[0] as { metadata: string | null; disabled: number | null } | undefined;
  if (!row || row.disabled) return {};
  if (!row.metadata) return {};
  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    return {};
  }
  const theme = (metadata as Record<string, unknown> | null)?.theme;
  return sanitizeTheme(theme);
}
