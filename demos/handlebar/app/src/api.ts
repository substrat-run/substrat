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
 *  - **Who the caller is.** `x-principal` is the dev persona seam the node server
 *    authenticates on — a fact about this harness, not about the model.
 *  - **`/cast`**, the persona list the dev server serves. Not an operation.
 *  - **Two operations deliberately left unbound.** `protocol/list-for-entity` takes
 *    an entity-agnostic `entityType`; binding it to a URL would let a caller list
 *    the protocols on any entity at all. The server supplies that constant by hand,
 *    which is exactly where the vertical stops being entity-agnostic (see
 *    `handlebarProtocolRoutes`). `bike-shop/timeline` shared that reason until #890
 *    bounded its type field to `['workorder', 'protocol']`; it stays hand-mounted
 *    for the ordinary reason instead — the screen reads a repair's entries
 *    unpaginated, and binding it means adopting the generated paged client.
 */
import { createClient, type HandlebarClient, type ProtocolInstance } from './api.generated';

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

export interface CastMember {
  name: string;
  role: string;
  principal: string;
}

/**
 * What `GET /repairs/{id}/timeline` answers — the kernel's `timelineEntry` (#800).
 * Hand-written here because the ROUTE is hand-mounted, not because the shape is
 * this app's: `readTimeline` owns it, and `actor` is the spine's union rather
 * than the raw JSON the outbox column holds.
 */
export interface TimelineEntry {
  /** The event's ULID — and the repair's version at that point (#901). */
  id: string;
  type: string;
  occurredAt: string;
  actor: string | { system: string } | { connection: string };
}

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

export function currentPrincipal(): string | null {
  return localStorage.getItem('bike-shop-principal');
}

export function setPrincipal(principal: string | null): void {
  if (principal) localStorage.setItem('bike-shop-principal', principal);
  else localStorage.removeItem('bike-shop-principal');
}

/**
 * The generated client, carrying this harness's persona header.
 *
 * `errorMessage` is left at its default: the server answers `{ error }`, which is the
 * first shape it reads. The error envelope is the one part of the surface the model
 * does not declare.
 */
export const api = createClient({
  headers: (): Record<string, string> => {
    const principal = currentPrincipal();
    return principal ? { 'x-principal': principal } : {};
  },
});

/**
 * The one non-operation route and the two unbound operations, sharing the generated
 * client's transport rather than a second fetch wrapper.
 */
const raw = async <T>(path: string): Promise<T> => {
  const principal = currentPrincipal();
  const res = await fetch(`/api${path}`, {
    headers: principal ? { 'x-principal': principal } : {},
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
};

export const extra = {
  /** The dev harness's persona list. Not an operation — the node server owns it. */
  cast: () => raw<Record<string, CastMember>>('/cast'),
  /** `bike-shop/timeline`, unbound: the route pins `entityType` (see the header). */
  timeline: (id: string) => raw<TimelineEntry[]>(`/repairs/${id}/timeline`),
  /** `protocol/list-for-entity`, unbound for the same reason. */
  repairProtocols: (repairId: string) => raw<ProtocolSummary[]>(`/repairs/${repairId}/protocols`),
};
