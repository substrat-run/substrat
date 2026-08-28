/**
 * The auth seam — the only part of this client a person writes.
 *
 * Everything else is `api.generated.ts`: the types are the entities' `fields`, the
 * methods are the `http` declarations, and `pnpm lint:client` re-emits both from
 * `spec/model.ts`. What is genuinely not in the model is which identity a request
 * carries — here a session cookie set by the relying-party flow the server mounts, so
 * there is no header to add, only `credentials` to send it.
 */
import { createClient } from './api.generated.js';

export { ApiError } from './api.generated.js';
export type {
  AgentProfile,
  AiTurn,
  Contact,
  Conversation,
  KbArticle,
  KbSource,
  Message,
  Notification,
  Paged,
  SavedReply,
  Ticket0Client,
} from './api.generated.js';

export interface Session {
  principal: string;
  display: string;
}

/**
 * A desk whose owner seat is unclaimed answers **200** `{ status: 'needs-setup' }`
 * rather than a bare 401 — so it is a distinct third answer here, not a session.
 * Reading it as one is how a fresh hosted desk came up showing the signed-in shell
 * with nobody signed in, and no way to reach the login at all.
 */
export interface NeedsSetup {
  status: 'needs-setup';
  /** Whether a plain sign-in still claims the seat (#925) — it closes on a window after
   *  provision; after that only a claim link from the dashboard binds the owner. */
  firstSignInOpen: boolean;
}
export type Identity = Session | NeedsSetup | null;

export async function me(): Promise<Identity> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (!res.ok) return null;
  const body = (await res.json()) as Session | NeedsSetup;
  return 'principal' in body ? body : { status: 'needs-setup', firstSignInOpen: body.firstSignInOpen === true };
}

/**
 * Claim the desk's owner seat with the token from a dashboard-minted claim link (#925).
 * Throws with the status so the screen can tell "sign in first" (401) from a dead link (400).
 */
export async function claimOwner(token: string): Promise<void> {
  const res = await fetch('/api/claim-owner', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
    throw Object.assign(new Error(body?.detail ?? body?.error ?? `${res.status}`), { status: res.status });
  }
}

export const auth = {
  login: (returnTo = '/') =>
    location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
  /** Sign in as somebody else — `prompt=select_account` gets past an issuer's session. */
  switchUser: () => location.assign('/api/auth/login?prompt=select_account'),
  logout: () => location.assign('/api/auth/logout'),
};

export const api = createClient({
  fetch: (input, init) => fetch(input, { credentials: 'same-origin', ...init }),
  // This vertical answers problem+json (`src/routes.ts`), whose message is `detail`.
  errorMessage: (body) =>
    typeof body === 'object' && body !== null
      ? ((body as { detail?: string; title?: string }).detail ??
        (body as { title?: string }).title)
      : undefined,
});
