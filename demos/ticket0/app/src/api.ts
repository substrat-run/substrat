/**
 * The auth seam — the only part of this client a person writes.
 *
 * Everything else is `api.generated.ts`: the types are the entities' `fields`, the
 * methods are the `http` declarations, and `pnpm lint:client` re-emits both from
 * `spec/model.ts`. What is genuinely not in the model is which identity a request
 * carries — here a session cookie set by the relying-party flow the server mounts, so
 * there is no header to add, only `credentials` to send it.
 */
import { ApiError, createClient } from './api.generated.js';

export { ApiError };
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
export type Identity = Session | 'needs-setup' | null;

export async function me(): Promise<Identity> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (!res.ok) return null;
  const body = (await res.json()) as Session | { status: 'needs-setup' };
  return 'principal' in body ? body : 'needs-setup';
}

export const auth = {
  login: (returnTo = '/') =>
    location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
  /** Sign in as somebody else — `prompt=select_account` gets past an issuer's session. */
  switchUser: () => location.assign('/api/auth/login?prompt=select_account'),
  logout: () => location.assign('/api/auth/logout'),
};

// This vertical answers problem+json (`src/routes.ts`), whose message is `detail`.
const problemDetail = (body: unknown): string | undefined =>
  typeof body === 'object' && body !== null
    ? ((body as { detail?: string; title?: string }).detail ?? (body as { title?: string }).title)
    : undefined;

export const api = createClient({
  fetch: (input, init) => fetch(input, { credentials: 'same-origin', ...init }),
  errorMessage: problemDetail,
});

/**
 * Re-read one documentation source — the one request here that is not in the model.
 *
 * The model declares operations, and reading a docs site is not one: module code may
 * not fetch, so the read is a connector-shaped route both hosts mount
 * (`harness/kb-refresh.ts`). It marks the source `ingesting`, fetches, and records
 * what it found — or that it failed, as a 502 carrying the reason — before answering,
 * so the row is worth re-reading whichever way it went. `ingestKbSource` alone only
 * records the intent, which is how "Re-read" used to leave a row spinning for good.
 */
export async function refreshKbSource(
  sourceId: string,
): Promise<{ added: number; updated: number; unchanged: number }> {
  const res = await fetch(`/api/kb/sources/${encodeURIComponent(sourceId)}/refresh`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, problemDetail(body) ?? res.statusText, body);
  return body as { added: number; updated: number; unchanged: number };
}
