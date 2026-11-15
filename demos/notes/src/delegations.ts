/**
 * What the dev issuer lets Todo do for a person here (`--delegations`, #3161), read off Notes' own
 * manifest so the two cannot drift. Hosted, the dashboard delivers the same declaration to the
 * team's auth-server, keyed by app; locally there is no place registry, so each app's OIDC client
 * id is its slug, and the two below are what each side's `devLogin` signs in as.
 */
import type { DevDelegation } from '@substrat-run/dev-issuer';
import { notesManifest } from './manifest.js';

export const NOTES_CLIENT_ID = 'notes';
export const TODO_CLIENT_ID = 'todo';

export const DELEGATIONS: DevDelegation[] = (notesManifest.delegations ?? []).map((d) => ({
  host: NOTES_CLIENT_ID,
  actor: d.actor,
  permissions: [...d.permissions],
  ...(d.channels ? { channels: [...d.channels] } : {}),
}));
