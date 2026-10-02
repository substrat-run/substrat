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

/**
 * The directory, plus every id in `ids` it did not hold (#1086).
 *
 * The directory is one PAGE, and the people a conversation names need not be on it: a CC
 * copied in a minute ago is the newest contact the desk has. So an id the page missed is
 * read on its own (`get-contact`) and kept, and an id that cannot be read — the caller
 * holds no `contact:read`, or it was deleted — is simply absent, the same honest fallback
 * the rest of the app gets.
 */
export async function contactsWith(ids: readonly (string | null | undefined)[]): Promise<Map<string, Contact>> {
  const directory = await contacts();
  const missing = [...new Set(ids.filter((id): id is string => typeof id === 'string' && !directory.has(id)))];
  await Promise.all(
    missing.map((contactId) =>
      api
        .getContact({ contactId })
        .then((c) => void directory.set(c.id, c))
        .catch(() => undefined),
    ),
  );
  return directory;
}

/** What to call somebody. Anonymous visitors are named as such, never as an id. */
export function nameOf(c: Contact | undefined, channel?: string): string {
  if (!c) return channel === 'widget' ? 'Anonymous visitor' : 'Contact';
  return c.display_name ?? c.email ?? (channel === 'widget' ? 'Anonymous visitor' : 'Contact');
}

export const isAnonymous = (c: Contact | undefined) => !c || (!c.display_name && !c.email);
