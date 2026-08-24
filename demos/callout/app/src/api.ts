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
 *  - **The three routes that are not operations.** `/me` is the session, and
 *    `/api/auth/login` and `/logout` redirect to the issuer. None is a `ScopeStub`
 *    invoke, so none can be declared.
 *  - **The three operations deliberately left unbound.** `protocol/list-for-entity`
 *    takes an entity-agnostic `entityType` — the engine is entity-agnostic and
 *    binding it would let a caller list the protocols on anything at all, which is
 *    exactly where the vertical stops being (see `calloutProtocolRoutes`).
 *    `callout/timeline` used to be unbound for the same reason and is no longer:
 *    #890 bounded its `entityType` to `['workorder', 'protocol']`, so a caller
 *    could choose between two declared types rather than name any entity. What
 *    keeps it unbound now is smaller and worth stating as the smaller thing it is
 *    — the screen wants an order's entries, and binding it means the app taking
 *    the generated paged client for a read it makes unpaginated.
 *    `callout/whoami` has no screen.
 *
 * There is no auth mode here any more. Both backends — the node dev server and the
 * Worker — authenticate the same way: a session cookie from the same relying-party
 * flow, against whatever issuer each is pointed at. The `x-principal` header and the
 * persona list it needed are gone; locally the picker lives at the dev issuer, where
 * it belongs.
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}

/** The resolved identity behind the current session cookie (from `GET /api/me`). */
export interface Session {
  principal: string;
  display: string;
  role: string;
  via: string;
}

/**
 * The session behind the current cookie, or null when nobody is signed in.
 *
 * One question with one answer, because there is one auth path now. This used to also
 * have to work out WHICH backend was answering — a 404 meant the node dev server and
 * put the whole app into a second, header-authenticated mode that no deployment ever
 * ran. Anything other than a 200 is simply "not signed in".
 */
export async function me(): Promise<Session | null> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as Session) : null;
  } catch {
    return null;
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
 * The non-operation routes, and the three operations left unbound.
 *
 * They share the generated client's transport (`call` above) rather than a second
 * fetch wrapper, so error handling stays in one place.
 */
export const extra = {
  /** `callout/timeline`, unbound: the route pins `entityType` (see api.ts header). */
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
 * The generated client. The session cookie is the identity, so there are no auth headers
 * to add — only `credentials: 'same-origin'`, which is what sends it.
 *
 * `errorMessage` is the default: callout's routes answer `{ error }`, which is the
 * first shape it reads.
 */
export const api = createClient({
  fetch: (input, init) => fetch(input, { credentials: 'same-origin', ...init }),
});
