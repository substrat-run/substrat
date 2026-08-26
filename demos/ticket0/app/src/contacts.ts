/**
 * The contact directory, fetched once.
 *
 * Conversations carry a `contact_id` and the design shows a NAME everywhere — the
 * handoff's own note that a promised string needs a source table applies just as much
 * to the screen as to the model. So the app resolves ids to people in one place, and a
 * caller without `contact:read` simply gets the honest fallback.
 */
import { api, type Contact } from './api.js';

let cache: Promise<Map<string, Contact>> | null = null;

export function contacts(): Promise<Map<string, Contact>> {
  cache ??= api
    .listContacts()
    .then((p) => new Map(p.entries.map((c) => [c.id, c])))
    .catch(() => new Map<string, Contact>());
  return cache;
}

/** What to call somebody. Anonymous visitors are named as such, never as an id. */
export function nameOf(c: Contact | undefined, channel?: string): string {
  if (!c) return channel === 'widget' ? 'Anonymous visitor' : 'Contact';
  return c.display_name ?? c.email ?? (channel === 'widget' ? 'Anonymous visitor' : 'Contact');
}

export const isAnonymous = (c: Contact | undefined) => !c || (!c.display_name && !c.email);
