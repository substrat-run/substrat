import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file, so the picker shows
 * exactly these people; `linkRallyLogins` reads the same array and binds each `sub` to a
 * principal in the identity directory. Neither side holds a copy of the other's list.
 *
 * This replaced an `x-principal` header that named any principal and was believed, plus a
 * `/api/cast` route that shipped the cast — and, worse, a hardcoded persona → member-id
 * map — to the browser. That map was the player app's only way to find its own member id,
 * which made the app correct locally and broken anywhere else.
 *
 * The `sub` values are stable strings rather than generated ids because they are written
 * into a directory that outlives the process.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|astrid', name: 'Astrid', email: 'astrid@rallypoint.test', note: 'klubbchef · båda anläggningarna' },
  { sub: 'dev|ravi', name: 'Ravi', email: 'ravi@rallypoint.test', note: 'reception · endast Solna' },
  { sub: 'dev|nils', name: 'Nils', email: 'nils@rallypoint.test', note: 'tränare · Solna' },
  { sub: 'dev|elin', name: 'Elin', email: 'elin@spelare.test', note: 'spelare · medlem i Solna och Nacka' },
  { sub: 'dev|johan', name: 'Johan', email: 'johan@spelare.test', note: 'spelare · medlem i Solna och Nacka' },
  // DEMO ONLY — the other club, so the cross-tenant beat has someone to be turned away as.
  { sub: 'dev|rutger', name: 'Rutger (annan klubb!)', email: 'rutger@padelvast.test', note: 'klubbchef @ Padelcenter Väst' },
];

/**
 * The identity pool these logins belong to (K-23). `central`, because a padel player
 * belongs to several clubs and is the same human in each — which is exactly what lets the
 * directory answer "which club is this login in?" per venue at request time.
 *
 * Named for the pool rather than its URL on purpose: `PORT=… pnpm dev` moves the issuer's
 * origin, and a provider string carrying the port would orphan every link in `.data`.
 */
export const DEV_PROVIDER = 'oidc:dev-issuer';

/** Which seeded principal each persona IS — the key into `RallyWorld`. */
export const PERSONA_PRINCIPALS: Record<
  string,
  'astrid' | 'ravi' | 'nils' | 'elin' | 'johan' | 'rutger'
> = {
  'dev|astrid': 'astrid',
  'dev|ravi': 'ravi',
  'dev|nils': 'nils',
  'dev|elin': 'elin',
  'dev|johan': 'johan',
  'dev|rutger': 'rutger',
};
