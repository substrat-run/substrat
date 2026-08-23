import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file: a real OpenID Connect
 * provider whose only shortcut is that `/authorize` lists names instead of asking for a
 * password. `linkDevPersonas` reads the same array and binds each `sub` to a principal in
 * the identity directory. Neither side holds a copy of the other's list.
 *
 * Nothing here is a bypass, and that is the point. The issuer asserts a subject and the
 * directory maps it to a principal — the same two steps a deployed instance performs against
 * a real issuer, so the login you exercise all day is the login your users will run. What
 * stood here before was an `x-principal` header: a name the server was simply told and
 * believed, which is an impersonation bypass, and which meant the dev login was one no
 * deployment ever ran.
 *
 * Add or rename people here freely — this is your world. Keep the `sub` values stable and
 * readable: they end up in an identity directory that outlives a restart.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|greta', name: 'Greta', email: 'greta@kedja.test', note: 'workshop-admin' },
  { sub: 'dev|mans', name: 'Måns', email: 'mans@kedja.test', note: 'mechanic' },
  { sub: 'dev|lisbeth', name: 'Lisbeth', email: 'lisbeth@example.test', note: 'portal customer' },
  { sub: 'dev|otto', name: 'Otto', email: 'otto@example.test', note: 'portal customer' },
  // The other shop, so the cross-tenant beat has someone to be turned away as.
  { sub: 'dev|rutger', name: 'Rutger', email: 'rutger@trampolin.test', note: 'admin at a DIFFERENT shop' },
];

/**
 * The identity pool these logins belong to (K-23). `central`: one issuer serves both demo
 * tenants, so the same subject is the same person in each. Named for the pool rather than
 * its URL, so moving the issuer's port does not orphan every link in `.data`.
 */
export const DEV_PROVIDER = 'oidc:dev-issuer';
