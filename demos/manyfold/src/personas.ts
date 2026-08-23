import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file; `seedDemo` reads the
 * same array and links each `sub` to a principal. Neither holds a copy of the other's list.
 *
 * Manyfold's twist is that a person's ROLE differs per site — Emil publishes at the café,
 * authors at the padel club and only reads at the law firm — so no role appears here. The
 * link binds a login to a principal; what that principal may do in the site you have
 * selected is `manyfold/whoami`'s answer, per site, from the scope's own tuples.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|maja', name: 'Maja Lindqvist', email: 'maja@nordlys.test', note: 'owner · every site' },
  { sub: 'dev|emil', name: 'Emil Berg', email: 'emil@nordlys.test', note: 'publisher · café, author · padel, viewer · law' },
  { sub: 'dev|sofia', name: 'Sofia Ruiz', email: 'sofia@nordlys.test', note: 'author · café' },
];

/** The identity pool these logins belong to (K-23) — see the note in callout's personas.ts. */
export const DEV_PROVIDER = 'oidc:dev-issuer';
