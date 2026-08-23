import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file; `linkDevPersonas` reads
 * the same array and binds each `sub` to a principal in the identity directory. Cleo lives in
 * a second tenant, which is the whole point of her: signing in as Cleo lands somewhere else
 * entirely, and no amount of guessing a list id reaches back.
 *
 * Todo is the smallest vertical that is still a real one, and it has no worker — this Node
 * server is all there is. That makes the login here worth getting right rather than faking:
 * it is the only one anybody reading this vertical will see.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|ada', name: 'Ada', email: 'ada@example.com', note: 'member' },
  { sub: 'dev|bjorn', name: 'Björn', email: 'bjorn@example.com', note: 'member · same tenant as Ada' },
  { sub: 'dev|cleo', name: 'Cleo', email: 'cleo@example.com', note: 'member · a different tenant' },
];

/** The identity pool these logins belong to (K-23). Central: one issuer, both demo tenants. */
export const DEV_PROVIDER = 'oidc:dev-issuer';
