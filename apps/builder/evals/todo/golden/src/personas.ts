import type { DevPersona } from '@substrat-run/dev-issuer';

/** The local dev cast: the issuer and the vertical agree on who exists here. */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|markus', name: 'Markus', email: 'markus@example.com', note: 'list owner' },
  { sub: 'dev|alice', name: 'Alice', email: 'alice@example.com', note: 'invited to one list' },
  { sub: 'dev|bob', name: 'Bob', email: 'bob@example.com', note: 'no share' },
  { sub: 'dev|dana', name: 'Dana', email: 'dana@example.com', note: 'invited by email, has not joined' },
  { sub: 'dev|tess', name: 'Tess', email: 'tess@example.com', note: 'a different tenant' },
];

export const DEV_PROVIDER = 'oidc:dev-issuer';
