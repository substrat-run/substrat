import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file, so the picker shows
 * exactly these people; `seedDemo` reads the same array and links each `sub` to a principal
 * in the identity directory. Neither side has a copy of the other's list, which is what
 * keeps them from drifting.
 *
 * Nothing here is a bypass. The issuer asserts a subject and the directory maps it to a
 * principal — the same two steps a hosted instance performs against a real issuer. Only the
 * issuer differs, and it differs by configuration.
 *
 * The `sub` values are stable strings rather than generated ids because they are written
 * into a directory that outlives the process: a link in `.data` from last week must still
 * name the same person today, and someone reading `_substrat_identities` should be able to
 * tell who `dev|harald` is.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|anna', name: 'Anna (kontor)', email: 'anna@elmontage.test', note: 'office-admin · ElMontage AB' },
  { sub: 'dev|harald', name: 'Harald (tekniker)', email: 'harald@elmontage.test', note: 'technician · ElMontage Stockholm' },
  { sub: 'dev|berit', name: 'Berit (portal)', email: 'berit@brfgrunden.test', note: 'portal · BRF Grunden' },
  { sub: 'dev|styrbjorn', name: 'Styrbjörn (portal)', email: 'styrbjorn@kontorshotellet.test', note: 'portal · Kontorshotellet AB' },
  // DEMO ONLY — the other firm, so the cross-tenant beat has someone to be turned away as.
  // Picking Mallory lands in t2/s2: a different tenant, a different scope, and every one of
  // ElMontage's rows out of reach. That beat is the reason a persona carries its own node.
  { sub: 'dev|mallory', name: 'Mallory (annan firma!)', email: 'mallory@rorservice.test', note: 'office-admin · RörService AB' },
];

/**
 * The identity pool these logins belong to (K-23). `central`, because one issuer serves both
 * demo tenants and `dev|anna` is the same person in each — which is exactly what lets
 * `listIdentityTenants` answer "which company is this login in?" at request time.
 *
 * Named for the pool rather than its URL on purpose: `PORT=… pnpm dev` moves the issuer's
 * origin, and a provider string carrying the port would orphan every link in `.data` the
 * moment it changed.
 */
export const DEV_PROVIDER = 'oidc:dev-issuer';
