import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file, so the picker shows
 * exactly these people; `linkDevPersonas` reads the same array and binds each `sub` to a
 * principal in the identity directory. Neither side holds a copy of the other's list.
 *
 * Nothing here is a bypass. The issuer asserts a subject and the directory maps it to a
 * principal — the same two steps a hosted storefront performs against a real issuer. Only
 * the issuer differs, and it differs by configuration.
 *
 * The `sub` values are stable strings rather than generated ids because they are written
 * into a directory that outlives the process: a link in `.data` from last week must still
 * name the same person today.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|astrid', name: 'Astrid Kallkälla', email: 'astrid@kallkalla.se', note: 'shop-admin · hela butiken' },
  { sub: 'dev|gustav', name: 'Gustav (lager)', email: 'gustav@kallkalla.se', note: 'warehouse · lager och plock' },
  { sub: 'dev|elin', name: 'Elin – Café Pascal', email: 'elin@cafepascal.se', note: 'kund · ser bara sina egna ordrar' },
  { sub: 'dev|otto', name: 'Otto – Kontoret', email: 'otto@kontoret.se', note: 'kund · ser bara sina egna ordrar' },
  // Deliberately absent from `PERSONA_PRINCIPALS` below: picking Ny Kund is how you see the
  // self-service path a real storefront runs on. First arrival mints a principal, a customer
  // and an entity-narrowed grant; the second arrival must land on the SAME principal, which
  // is the beat that used to be broken.
  { sub: 'dev|nykund', name: 'Ny Kund', email: 'ny@exempel.se', note: 'ny besökare · TOFU vid första inloggningen' },
];

/**
 * The nav hint each login gets in the storefront and the back office. A HINT only — the
 * kernel enforces the real thing, and a wrong value here changes chrome, never access.
 * Keyed by `sub` rather than by email, because the subject is what the issuer asserts and
 * the email is a claim that a real issuer may not even send.
 *
 * Anyone not in the cast is a self-service shopper: they sign up at the issuer and TOFU
 * auto-mint gives them the `shopper` role on first arrival.
 */
export const ROLE_HINTS: Record<string, string> = {
  'dev|astrid': 'shop-admin',
  'dev|gustav': 'warehouse',
  'dev|elin': 'customer',
  'dev|otto': 'customer',
};

/** Which seeded principal each persona IS — the key into `ShopWorld`. */
export const PERSONA_PRINCIPALS: Record<string, 'astrid' | 'gustav' | 'elin' | 'otto'> = {
  'dev|astrid': 'astrid',
  'dev|gustav': 'gustav',
  'dev|elin': 'elin',
  'dev|otto': 'otto',
};
