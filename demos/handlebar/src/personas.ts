import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file, so the picker shows
 * exactly these people; `linkDevPersonas` reads the same array and binds each `sub` to a
 * principal in the identity directory. Neither side holds a copy of the other's list.
 *
 * This replaced an `x-principal` header that named any principal and was believed. The
 * header was an impersonation bypass, and — in a vertical whose app had no login screen at
 * all — it was also the only "login" anybody reading this would ever have seen.
 *
 * The `sub` values are stable strings rather than generated ids because they are written
 * into a directory that outlives the process.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|greta', name: 'Greta', email: 'greta@handlebar.test', note: 'verkstadschef · workshop-admin' },
  { sub: 'dev|mans', name: 'Måns', email: 'mans@handlebar.test', note: 'mekaniker · mechanic' },
  { sub: 'dev|lisbeth', name: 'Lisbeth', email: 'lisbeth@crescent.test', note: 'portal · ser bara sin egen cykel' },
  { sub: 'dev|otto', name: 'Otto', email: 'otto@bianchi.test', note: 'portal · ser bara sin egen cykel' },
  // DEMO ONLY — the other workshop, so the cross-tenant beat has someone to be turned away
  // as. Rutger is seeded into t2/s2: a different workshop, and every one of Handlebar's rows
  // out of reach. `test/entity-checks.test.ts` leans on him.
  { sub: 'dev|rutger', name: 'Rutger (annan verkstad!)', email: 'rutger@anexverkstad.test', note: 'workshop-admin @ en ANNAN verkstad' },
];

/**
 * The identity pool these logins belong to (K-23). `central`, because one issuer serves
 * both demo tenants and `dev|rutger` is the same person in each — which is what lets
 * `listIdentityTenants` answer "which workshop is this login in?" at request time.
 *
 * Named for the pool rather than its URL on purpose: `PORT=… pnpm dev` moves the issuer's
 * origin, and a provider string carrying the port would orphan every link in `.data` the
 * moment it changed.
 */
export const DEV_PROVIDER = 'oidc:dev-issuer';

/** Which seeded principal each persona IS — the key into `BikeShopWorld`. */
export const PERSONA_PRINCIPALS: Record<string, 'greta' | 'mans' | 'lisbeth' | 'otto' | 'rutger'> = {
  'dev|greta': 'greta',
  'dev|mans': 'mans',
  'dev|lisbeth': 'lisbeth',
  'dev|otto': 'otto',
  'dev|rutger': 'rutger',
};
