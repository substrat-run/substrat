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

// This vertical answers problem+json (`src/routes.ts`), whose message is `detail`.
const problemDetail = (body: unknown): string | undefined =>
  typeof body === 'object' && body !== null
    ? ((body as { detail?: string; title?: string }).detail ?? (body as { title?: string }).title)
    : undefined;

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

/**
 * The desk's people — the four requests here that are not in the model, and could not
 * be.
 *
 * An invite mints a PRINCIPAL and grants it a role, and neither is something module
 * code may do: roles live in the kernel's admin surface, which an operation deliberately
 * cannot reach. So the flow is a host surface (`harness/invites.ts`, mounted by both the
 * dev server and the worker) rather than a declared operation, and this is its client.
 *
 * The staff DIRECTORY is a different thing and is in the model: `list-agents` reads the
 * profiles, and `agents.ts` is what resolves them into names. An invite is how somebody
 * comes to have one.
 */
export interface PendingInvite {
  principal: string;
  roleKey: string;
  email: string | null;
  created_at: string;
}

export interface CreatedInvite extends PendingInvite {
  /** The one-time link to hand over. Shown once — only its hash is kept. */
  acceptUrl: string;
}

async function inviteCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, problemDetail(body) ?? res.statusText, body);
  return body as T;
}

export const invites = {
  /** The roles a person may be invited at, and who is already invited and has not arrived. */
  list: () => inviteCall<{ roles: string[]; invites: PendingInvite[] }>('/api/invites'),
  create: (input: { email?: string; roleKey: string; contactId?: string }) =>
    inviteCall<CreatedInvite>('/api/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  revoke: (principal: string) =>
    inviteCall<null>(`/api/invites/${encodeURIComponent(principal)}/revoke`, { method: 'POST' }),
  /**
   * Claim an invite with the token from its link. A 401 means "sign in first" and a
   * 400 means the link is spent — two different screens, so the status is what the
   * caller reads rather than the message.
   */
  accept: (token: string) =>
    inviteCall<{ ok: true; principal: string }>('/api/accept-invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
};

export const auth = {
  login: (returnTo = '/') =>
    location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
  /** Sign in as somebody else — `prompt=select_account` gets past an issuer's session. */
  switchUser: () => location.assign('/api/auth/login?prompt=select_account'),
  logout: () => location.assign('/api/auth/logout'),
};

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
/** `GET /api/assistant/status` — the model this install runs, beside its failed turns. */
export interface AssistantStatus {
  /** As a turn records it: `cloudflare/@cf/…`, or `offline/extractive` when the platform cannot run the model. */
  model: string;
  /** False when the desk is quoting the documentation rather than generating. */
  generative: boolean;
  /** The desk's `provider:model` setting, defaulted. */
  spec: string;
  /** Whether the platform holds what that provider needs, and what is missing when not. */
  configured: boolean;
  missing: string[];
  /** Where inference runs and what is sent there. */
  hosting: { vendor: string; location: string; host: string; dataNote: string } | null;
  health: {
    since: string;
    turns: number;
    failed: number;
    recent: {
      id: string;
      conversation_id: string;
      subject: string;
      model: string;
      error: string | null;
      created_at: string;
    }[];
  };
}

/**
 * Is the assistant working? The other request here that is not in the model, and for
 * the same reason as the one below: which model an install would answer with is a
 * fact about the host's environment, which module code cannot read. The host mounts
 * `harness/assistant-status.ts`, which invokes the declared `assistant-health` — so
 * `desk:configure` is what authorises this, exactly as for the failures it wraps.
 */
export async function assistantStatus(): Promise<AssistantStatus> {
  const res = await fetch('/api/assistant/status', { credentials: 'same-origin' });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, problemDetail(body) ?? res.statusText, body);
  return body as AssistantStatus;
}

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
