/**
 * The auth seam — the only part of this client a person writes.
 *
 * Everything else lives in `api.generated.ts`: the types are the entities'
 * `fields`, the methods are the `http` declarations, and `pnpm lint:client`
 * re-emits both from `spec/model.ts`. That file used to be written here by hand,
 * and it drifted — the app could not page and could not search for two releases
 * after the model declared both, with nothing red anywhere.
 *
 * What is left is genuinely NOT in the model: which identity a request carries.
 * That is the session cookie, set by the relying-party flow the server mounts —
 * so there is no header to add, only `credentials: 'same-origin'` to send it.
 * Switching user is a real sign-in at the issuer, which is how the permission
 * model becomes visible: the same screen, a different answer, and no filtering
 * anywhere in the app.
 */
import { createClient } from './api.generated.js';

export { ApiError } from './api.generated.js';
export type { Item, List, Owner, Paged, Share, TodoClient } from './api.generated.js';

/** Who the session cookie resolves to, or null when nobody is signed in. */
export interface Session {
  principal: string;
  display: string;
}

export async function me(): Promise<Session | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  return res.ok ? ((await res.json()) as Session) : null;
}

export const auth = {
  login: (returnTo = '/') => location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
  /** Sign in as somebody else — `prompt=select_account` gets past an issuer's SSO session. */
  switchUser: () => location.assign('/api/auth/login?prompt=select_account'),
  logout: () => location.assign('/api/auth/logout'),
};

/**
 * `errorMessage` is left at its default on purpose: this vertical's `app.onError`
 * answers `{ error }` (see `src/routes.ts`), which is the first shape the default
 * reads. An app that changes its envelope overrides it here rather than being
 * guessed at — the error body is the one part of the surface the model does not
 * declare.
 */
export const api = createClient({
  fetch: (input, init) => fetch(input, { credentials: 'same-origin', ...init }),
});
