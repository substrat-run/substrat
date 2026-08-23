import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file, so the picker shows
 * exactly these people; `seedDemo` reads the same array and links each `sub` to a principal
 * in the identity directory. Neither side holds a copy of the other's list.
 *
 * Nothing here is a bypass: the issuer asserts a subject and the directory maps it to a
 * principal, which is the pair of steps a hosted instance performs against a real issuer.
 * What the persona IS — their role, their country, the employee record they are attached to —
 * is not recorded here at all. That comes from `hr/whoami`, out of the scope's own data, in
 * dev exactly as in production. The dev cast used to carry it, which made the employee app's
 * chrome true locally and guesswork everywhere else.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|elin', name: 'Elin Ek', email: 'elin@nordljus.se', note: 'employee · Sweden' },
  { sub: 'dev|pablo', name: 'Pablo Ruiz', email: 'pablo@nordljus.es', note: 'employee · Spain' },
  { sub: 'dev|mats', name: 'Mats Lund', email: 'mats@nordljus.se', note: 'team lead · Sweden' },
  { sub: 'dev|hedda', name: 'Hedda Ohlsson', email: 'hedda@nordljus.se', note: 'HR admin · both countries' },
  { sub: 'dev|petra', name: 'Petra Nyström', email: 'petra@nordljus.se', note: 'payroll · Sweden' },
  // DEMO ONLY — the other company, so the cross-tenant beat has someone to be turned away as.
  { sub: 'dev|mallory', name: 'Mallory', email: 'mallory@othercorp.test', note: 'HR admin · another company!' },
];

/**
 * The identity pool these logins belong to (K-23). `central`, because one issuer serves both
 * demo tenants. Named for the pool rather than its URL: `ISSUER_PORT=…` moves the origin, and
 * a provider string carrying the port would orphan every link in `.data` the moment it moved.
 */
export const DEV_PROVIDER = 'oidc:dev-issuer';
