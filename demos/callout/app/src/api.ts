/**
 * What the model does NOT declare — and nothing else.
 *
 * Every typed call lives in `api.generated.ts`, emitted from `src/entities.ts` +
 * `src/operations.ts` and the three composed engines by `pnpm lint:client`. The
 * 305 lines this file used to be were a second description of that model: the
 * `WorkOrder`/`Customer`/`Protocol*` interfaces were the engines' published
 * schemas retyped by hand, and the method list was the route table retyped again.
 *
 * What survives here is what genuinely has no declaration behind it:
 *
 *  - **Which identity a request carries.** Two backends share this app — the node
 *    dev server authenticates the `x-principal` persona header, the Worker
 *    authenticates a session cookie — and choosing between them is a fact about
 *    the deployment, not about the model.
 *  - **The four routes that are not operations.** `/cast` is the persona list the
 *    dev harness serves; `/me` is the auth probe; `/api/auth/login` and `/logout`
 *    redirect to the issuer. None is a `ScopeStub` invoke, so none can be declared.
 *  - **The three operations deliberately left unbound.** `callout/timeline` and
 *    `protocol/list-for-entity` both take an entity-agnostic `entityType`, and
 *    binding either to a URL would let a caller name any entity at all — the
 *    engine is entity-agnostic and this is exactly where the vertical stops being
 *    (see `calloutProtocolRoutes`). `callout/whoami` has no screen.
 */
import { createClient, type CalloutClient, type ProtocolInstance } from './api.generated';

export { ApiError } from './api.generated';
export type {
  BillableLine,
  Customer,
  Facility,
  MaterialLine,
  Money,
  Price,
  Protocol,
  ProtocolInstance,
  ProtocolResponse,
  ProtocolSignature,
  ProtocolTemplateRow as ProtocolTemplate,
  Underlag,
  UnderlagLine,
  UnderlagListRow,
  WorkOrder,
} from './api.generated';

/**
 * Shapes a screen names, pointed AT the generated client rather than retyped.
 *
 * `protocolGet` returns an inline object — it is an operation's output, not an
 * entity, so it has no interface of its own. Naming it by indexing the generated
 * method keeps the alias derived: change the operation's output and this follows,
 * where a hand-written `interface ProtocolDetail` would quietly disagree.
 */
export type ProtocolDetail = Awaited<ReturnType<CalloutClient['protocolGet']>>;
/** A checklist row. `content` is a union — only the checklist arm has sections. */
type ChecklistContent = Extract<ProtocolDetail['template']['content'], { kind: 'checklist' }>;
export type ProtocolItem = ChecklistContent['sections'][number]['items'][number];
export type CompletedOrder = Awaited<ReturnType<CalloutClient['completeWorkorder']>>;

/**
 * A customer WITH its facilities — what `callout/list-customers` answers.
 *
 * Not the `customer` entity: the operation joins the facilities on, so its output is
 * a shape of its own. Indexed off the generated method for the same reason as
 * `ProtocolDetail` — the join is declared, so the alias should follow it.
 */
export type CustomerWithFacilities =
  Awaited<ReturnType<CalloutClient['listCustomers']>>['entries'][number];

export interface CastMember {
  name: string;
  role: string;
  principal: string;
}

export function currentPrincipal(): string | null {
  return localStorage.getItem('fsm-principal');
}

export function setPrincipal(principal: string | null): void {
  if (principal) localStorage.setItem('fsm-principal', principal);
  else localStorage.removeItem('fsm-principal');
}

/**
 * Two backends share this app. The node/sqlite dev server authenticates via the
 * `x-principal` header (persona picker); the Cloudflare Worker authenticates via
 * a Better Auth session cookie. In Better-Auth mode we must NOT send x-principal
 * (the cookie is the identity), so App probes `/api/me` on mount and calls
 * `setHeaderAuth` to pick the mode. Defaults to header mode for the node demo.
 */
let headerAuth = true;
export function setHeaderAuth(on: boolean): void {
  headerAuth = on;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const principal = currentPrincipal();
  const sendHeader = headerAuth && principal;
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(sendHeader ? { 'x-principal': principal } : {}),
      ...init?.headers,
    },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}

/** The resolved Better-Auth identity behind the current cookie (from `GET /api/me`). */
export interface Session {
  principal: string;
  display: string;
  role: string;
  via: string;
}

/**
 * Probe which backend/auth mode we're talking to:
 *  - 200 → Better Auth, signed in (`session` set)
 *  - 401 → Better Auth, not signed in (`session` null)
 *  - 404 / network fail → node dev server (no `/api/me` route) → header mode
 */
export type MeResult =
  | { mode: 'better-auth'; session: Session | null }
  | { mode: 'header' };

export async function me(): Promise<MeResult> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.status === 404) return { mode: 'header' };
    if (res.status === 401) return { mode: 'better-auth', session: null };
    if (res.ok) return { mode: 'better-auth', session: (await res.json()) as Session };
    // Route exists (Better Auth) but returned another status → treat as no session.
    return { mode: 'better-auth', session: null };
  } catch {
    // Network failure / no backend reachable → fall back to the node header flow.
    return { mode: 'header' };
  }
}

// OIDC-only (oidc-only-demos.md): the vertical hosts no credential endpoints. Sign-in,
// sign-up, password, and reset all live at the issuer; the SPA redirects to `/api/auth/login`
// (see the LoginScreen in App.tsx). There is no `signIn` client here any more.

/** Send the browser to the issuer to sign in, returning to `returnTo` on this origin. */
export function loginAt(returnTo = '/'): void {
  window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}

/** Sign out at the issuer (clears the session cookie), then land back on this origin. */
export function signOut(): void {
  window.location.assign('/api/auth/logout');
}


/**
 * The four non-operation routes, and the three operations left unbound.
 *
 * They share the generated client's transport (`call` above) rather than a second
 * fetch wrapper, so auth-mode selection and error handling stay in one place.
 */
export const extra = {
  /** The dev harness's persona list. Not an operation — the node server owns it. */
  cast: () => call<Record<string, CastMember>>('/cast'),
  /** `callout/timeline`, unbound: `entityType` is entity-agnostic (see api.ts header). */
  timeline: (id: string) => call<TimelineEntry[]>(`/workorders/${id}/timeline`),
  /** `protocol/list-for-entity`, unbound for the same reason. */
  orderProtocols: (orderId: string) => call<ProtocolSummary[]>(`/workorders/${orderId}/protocols`),
};

export interface TimelineEntry {
  type: string;
  occurred_at: string;
  actor: string;
}

/** What `GET /workorders/{id}/protocols` answers — a hand-mounted route's own shape. */
export interface ProtocolSummary {
  instance: ProtocolInstance;
  title: string;
  answered: number;
  total: number;
  signedBy: string | null;
  signedAt: string | null;
}

/**
 * The generated client, wired to this app's two auth modes.
 *
 * `errorMessage` is the default: callout's routes answer `{ error }`, which is the
 * first shape it reads.
 */
export const api = createClient({
  headers: (): Record<string, string> => {
    const principal = currentPrincipal();
    return headerAuth && principal ? { 'x-principal': principal } : {};
  },
  fetch: (input, init) => fetch(input, { credentials: 'same-origin', ...init }),
});
