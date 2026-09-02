/**
 * What the model does NOT declare — and nothing else.
 *
 * Every typed call lives in `api.generated.ts`, emitted from `src/entities.ts` +
 * `src/operations.ts` and the three composed engines by `pnpm lint:client`. The
 * 234 lines this file used to be were a second description of that model: sixteen
 * interfaces retyping the engines' published schemas, and twenty-six methods
 * retyping the route table.
 *
 * The first thing generating it found was a live drift — `bike-shop/price-list`
 * declared `GET /price-list` while the server has always served `/prices`. Nothing
 * checked, because Handlebar mounts its routes by hand and the declaration was
 * decorative. A client generated from it would have 404'd on the first request.
 *
 * What survives here has no declaration behind it:
 *
 *  - **Who the caller is.** `/api/me` and the relying-party redirects are facts about
 *    this deployment's issuer, not about the model.
 *  - **Two operations deliberately left unbound.** `protocol/list-for-entity` takes
 *    an entity-agnostic `entityType`; binding it to a URL would let a caller list
 *    the protocols on any entity at all. The server supplies that constant by hand,
 *    which is exactly where the vertical stops being entity-agnostic (see
 *    `handlebarProtocolRoutes`). `bike-shop/timeline` shared that reason until #890
 *    bounded its type field to `['workorder', 'protocol']`; it stays hand-mounted
 *    for the ordinary reason instead — the screen reads a repair's entries
 *    unpaginated, and binding it means adopting the generated paged client.
 */
import type { TimelineEntry } from '@substrat-run/contracts';
import {
  createClient,
  type HandlebarClient,
  type Paged,
  type ProtocolInstance,
} from './api.generated';

/**
 * The kernel's shape, not a copy of it (#800).
 *
 * `readTimeline` owns what an entry is — `actor` in particular is the spine's
 * union rather than the raw JSON the outbox column holds — so the route being
 * hand-mounted is a fact about request binding and says nothing about the response
 * type. A local interface would be a second description of a contract the kernel
 * already owns, free to drift from it silently, which is the failure #800 exists
 * to end. Type-only: nothing of `@substrat-run/contracts` reaches the bundle.
 */
export type { TimelineEntry };

export { ApiError } from './api.generated';
export type {
  BillableLine,
  Bike,
  Customer,
  MaterialLine,
  Money,
  Price,
  ProtocolInstance,
  ProtocolResponse,
  ProtocolSignature,
  UnderlagLine,
  UnderlagListRow,
  WorkOrder,
} from './api.generated';

/**
 * Shapes a screen names, pointed AT the generated client rather than retyped.
 *
 * These are operation OUTPUTS, not entities, so they have no interface of their own —
 * `listCustomers` joins the bikes on, `protocolGet` assembles five rows. Indexing the
 * generated method keeps the alias derived: change the operation and this follows,
 * where a hand-written interface would quietly disagree.
 */
export type Repair = Awaited<ReturnType<HandlebarClient['workorderGet']>>['order'];
export type RepairDetail = Awaited<ReturnType<HandlebarClient['workorderGet']>>;
export type CustomerWithBikes =
  Awaited<ReturnType<HandlebarClient['listCustomers']>>['entries'][number];
export type ProtocolDetail = Awaited<ReturnType<HandlebarClient['protocolGet']>>;
export type CompletedRepair = Awaited<ReturnType<HandlebarClient['completeRepair']>>;

/** A checklist row. `content` is a union — only the checklist arm has sections. */
type ChecklistContent = Extract<ProtocolDetail['template']['content'], { kind: 'checklist' }>;
export type ProtocolItem = ChecklistContent['sections'][number]['items'][number];

/** What `GET /repairs/{id}/protocols` answers — likewise. */
export interface ProtocolSummary {
  instance: ProtocolInstance;
  title: string;
  answered: number;
  total: number;
  signedBy: string | null;
  signedAt: string | null;
  countersignedBy: string | null;
  countersignedAt: string | null;
}

/**
 * Signing in is a NAVIGATION, not a fetch: the browser leaves for the issuer,
 * authenticates there, and comes back to `/api/auth/callback` with a session cookie.
 * This app hosts no sign-up — accounts live at the issuer.
 */
export const auth = {
  login: (returnTo = '/') => location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
  logout: () => location.assign('/api/auth/logout'),
};

/** Who is signed in. 401 while nobody is — the caller renders the sign-in screen. */
export interface Me {
  principal: string;
  display: string;
}

/**
 * The generated client. The session rides in a cookie, so there are no headers to add;
 * `credentials` is same-origin, which is what the Vite proxy makes this.
 *
 * `errorMessage` is left at its default: the server answers `{ error }`, which is the
 * first shape it reads. The error envelope is the one part of the surface the model
 * does not declare.
 */
export const api = createClient();

/**
 * The one non-operation route and the two unbound operations, sharing the generated
 * client's transport rather than a second fetch wrapper.
 */
const raw = async <T>(path: string): Promise<T> => {
  const res = await fetch(`/api${path}`);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
};

/**
 * A hand-mounted paged read, walked to the end.
 *
 * The route answers ONE page and names the next in a `Link` header (#829). Reading
 * only the body is how a strip silently stops at `LIST_PAGE_DEFAULT` — twenty
 * events, which a repair passes without anything looking wrong: the list renders,
 * it is just missing its own history from the twenty-first event on.
 *
 * `api.follow` is the generated client's own walk, so the Link parsing and the error
 * envelope stay in one place rather than being written a second time here. It collects rather than exposing page controls because the
 * caller asked for the timeline, not for a page of it.
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
  /** Who is signed in. Not an operation — the RP half of this server owns it. */
  me: () => raw<Me>('/me'),
  /** `bike-shop/timeline`, unbound: the route pins `entityType` (see the header). */
  timeline: (id: string) => walk<TimelineEntry>(`/repairs/${id}/timeline`),
  /** `protocol/list-for-entity`, unbound for the same reason. */
  repairProtocols: (repairId: string) => raw<ProtocolSummary[]>(`/repairs/${repairId}/protocols`),
};
