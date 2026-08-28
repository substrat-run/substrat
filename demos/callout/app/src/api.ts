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
 *    — the route supplies `entityType` so the screen does not have to. It is still
 *    a PAGED read on the wire and is walked as one (see `walk` below); what the
 *    route saves the app is a constant, not the pagination.
 *    `callout/whoami` has no screen.
 *
 * There is no auth mode here any more. Both backends — the node dev server and the
 * Worker — authenticate the same way: a session cookie from the same relying-party
 * flow, against whatever issuer each is pointed at. The `x-principal` header and the
 * persona list it needed are gone; locally the picker lives at the dev issuer, where
 * it belongs.
 */
import type { TimelineEntry } from '@substrat-run/contracts';
import {
  createClient,
  type CalloutClient,
  type Paged,
  type ProtocolInstance,
} from './api.generated';

/**
 * The kernel's shape, not a copy of it (#800).
 *
 * `readTimeline` decides what an entry is — `actor` in particular is the spine's
 * union rather than the raw JSON the outbox column holds — so the route being
 * hand-mounted is a fact about request binding and says nothing about the
 * response type. A local interface here would be a second description of a
 * contract the kernel already owns, free to drift from it silently, which is the
 * failure #800 exists to end. The import is type-only: nothing of
 * `@substrat-run/contracts` reaches the bundle.
 */
export type { TimelineEntry };

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
    if (!res.ok) return null;
    const body = (await res.json()) as Session | NeedsSetup;
    // An unclaimed owner seat is a 200 that is not a session (#925) — `whoAmI` below reads it.
    return 'principal' in body ? body : null;
  } catch {
    return null;
  }
}

/** A freshly-provisioned instance whose owner seat nobody has claimed yet (#925). */
export interface NeedsSetup {
  status: 'needs-setup';
  /** Whether a plain sign-in still claims the seat — it closes on a window after provision;
   *  after that only a claim link from the dashboard binds the owner. */
  firstSignInOpen: boolean;
}

/** `/api/me` as a three-way answer: a session, an unclaimed seat, or nobody. */
export async function whoAmI(): Promise<Session | NeedsSetup | null> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()) as Session | NeedsSetup;
    return 'principal' in body ? body : { status: 'needs-setup', firstSignInOpen: body.firstSignInOpen === true };
  } catch {
    return null;
  }
}

/**
 * Claim the owner seat with the token from a dashboard-minted claim link (#925). Throws with
 * the status so the screen can tell "sign in first" (401) from a dead link (400).
 */
export async function claimOwner(token: string): Promise<void> {
  const res = await fetch('/api/claim-owner', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw Object.assign(new Error(body?.error ?? `${res.status}`), { status: res.status });
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
/**
 * A hand-mounted paged read, walked to the end.
 *
 * The route answers ONE page and names the next in a `Link` header (#829). Reading
 * only the body is how a strip silently stops at `LIST_PAGE_DEFAULT` — twenty
 * events, which a work order passes without anything looking wrong: the list
 * renders, it is just missing its own history from the twenty-first event on. That
 * is the same class of quiet loss as meridian's `occurred_at` cursor, one layer up.
 *
 * `api.follow` is the generated client's own walk, so the Link parsing, the
 * credentials and the error envelope stay in one place rather than being written a
 * second time here. It collects rather than exposing page controls because the
 * caller asked for the timeline, not for a page of it — a history strip shows a
 * whole history.
 */
async function walk<T>(path: string): Promise<T[]> {
  const entries: T[] = [];
  let next: string | null = `/api${path}`;
  while (next !== null) {
    const page: Paged<T> = await api.follow<T>(next);
    entries.push(...page.entries);
    next = page.next;
  }
  return entries;
}

export const extra = {
  /** `callout/timeline`, unbound: the route pins `entityType` (see api.ts header). */
  timeline: (id: string) => walk<TimelineEntry>(`/workorders/${id}/timeline`),
  /** `protocol/list-for-entity`, unbound for the same reason. */
  orderProtocols: (orderId: string) => call<ProtocolSummary[]>(`/workorders/${orderId}/protocols`),
};

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
