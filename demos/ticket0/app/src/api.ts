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

export async function me(): Promise<Session | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  return res.ok ? ((await res.json()) as Session) : null;
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
