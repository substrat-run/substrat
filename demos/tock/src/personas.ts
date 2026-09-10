import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file; `seedDemo` reads the same
 * array and links each `sub` to a principal. Neither holds a copy of the other's list.
 *
 * The roles are in the note rather than in the data: what a principal may do is the scope's
 * own tuples, and a role written here would be a second description of the seed's.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|ines', name: 'Ines Delgado', email: 'ines@fjord.test', note: 'admin · Fjord Audio' },
  { sub: 'dev|tomas', name: 'Tomas Reuter', email: 'tomas@fjord.test', note: 'analyst · uploads and counts, cannot write a schema' },
  { sub: 'dev|wren', name: 'Wren Okafor', email: 'wren@fjord.test', note: 'viewer · reads counts, never rows' },
  { sub: 'dev|petra', name: 'Petra Halvorsen', email: 'petra@backlot.test', note: 'admin · Backlot Media — a nobody at Fjord' },
];

/** The identity pool these logins belong to. */
export const DEV_PROVIDER = 'oidc:dev-issuer';
