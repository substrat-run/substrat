export interface CastMember {
  name: string;
  role: string;
  principal: string;
}

export interface WorkOrder {
  id: string;
  number: number;
  facility: { entityType: string; entityId: string };
  customer: { entityType: string; entityId: string };
  kind: string;
  title: string;
  description: string | null;
  status: 'planned' | 'in_progress' | 'completed' | 'closed';
  assignedTo: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Money {
  amount: string;
  currency: string;
}

export interface BillableLine {
  article: string;
  description: string;
  qty: string;
  unit: string;
  unitPrice: Money;
  lineTotal: Money;
}

export interface Facility {
  id: string;
  name: string;
  address: string | null;
  access_note: string | null;
}

export interface Customer {
  id: string;
  number: string;
  name: string;
  org_ref: string | null;
  facilities: Facility[];
}

export interface Price {
  article: string;
  description: string;
  unit: string;
  price_amount: string;
  currency: string;
  min_qty: string | null;
  internal: number;
}

export interface Underlag {
  id: string;
  number: number;
  customer_id: string;
  status: 'open' | 'exported';
  created_at: string;
  total: string;
}

export interface UnderlagLine {
  id: string;
  document_type: string;
  document_id: string;
  source_type: string | null;
  source_id: string | null;
  article: string;
  description: string;
  qty: string;
  unit: string;
  unit_price_amount: string;
  currency: string;
  line_total_amount: string;
}

export interface TimelineEntry {
  type: string;
  occurred_at: string;
  actor: string;
}

export interface ProtocolItem {
  key: string;
  label: string;
  type: 'check' | 'value' | 'text';
  unit?: string;
}

export interface ProtocolTemplate {
  id: string;
  key: string;
  version: number;
  title: string;
  content_json: string;
}

export interface ProtocolInstance {
  id: string;
  template_key: string;
  template_version: number;
  entity_type: string;
  entity_id: string;
  status: 'open' | 'signed' | 'voided';
  created_by: string;
  created_at: string;
  voided_reason: string | null;
}

export interface ProtocolResponse {
  id: string;
  item_key: string;
  value_json: string;
  note: string | null;
  responded_by: string;
  responded_at: string;
}

export interface ProtocolSignature {
  id: string;
  signed_by: string;
  method: string;
  content_hash: string;
  signed_at: string;
}

export interface ProtocolSummary {
  instance: ProtocolInstance;
  title: string;
  answered: number;
  total: number;
  signedBy: string | null;
  signedAt: string | null;
}

export interface ProtocolDetail {
  instance: ProtocolInstance;
  template: {
    key: string;
    version: number;
    title: string;
    content: { sections: { title: string; items: ProtocolItem[] }[] };
  };
  responses: ProtocolResponse[];
  latest: Record<string, ProtocolResponse>;
  signature: ProtocolSignature | null;
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

export const api = {
  cast: () => call<Record<string, CastMember>>('/cast'),
  customers: () => call<Customer[]>('/customers'),
  workorders: () => call<WorkOrder[]>('/workorders'),
  workorder: (id: string) =>
    call<{ order: WorkOrder; time: { id: string; hours: string; note: string | null }[]; material: { id: string; article: string; qty: string }[] }>(
      `/workorders/${id}`,
    ),
  timeline: (id: string) => call<TimelineEntry[]>(`/workorders/${id}/timeline`),
  createOrder: (input: { facilityId: string; kind: string; title: string; description?: string }) =>
    call<WorkOrder>('/workorders', { method: 'POST', body: JSON.stringify(input) }),
  assign: (id: string, technician: string) =>
    call<WorkOrder>(`/workorders/${id}/assign`, { method: 'POST', body: JSON.stringify({ technician }) }),
  start: (id: string) => call<WorkOrder>(`/workorders/${id}/start`, { method: 'POST', body: '{}' }),
  reportTime: (id: string, hours: string, note?: string) =>
    call(`/workorders/${id}/time`, { method: 'POST', body: JSON.stringify({ hours, note }) }),
  reportMaterial: (id: string, article: string, qty: string) =>
    call(`/workorders/${id}/material`, { method: 'POST', body: JSON.stringify({ article, qty }) }),
  complete: (id: string) =>
    call<{ order: WorkOrder; billable: BillableLine[]; total: Money }>(
      `/workorders/${id}/complete`,
      { method: 'POST', body: '{}' },
    ),
  close: (id: string) => call<WorkOrder>(`/workorders/${id}/close`, { method: 'POST', body: '{}' }),
  portalOrders: () => call<WorkOrder[]>('/portal/orders'),
  invoicing: () => call<Underlag[]>('/invoicing'),
  underlag: (id: string) =>
    call<{ underlag: Underlag; lines: UnderlagLine[]; total: string }>(`/invoicing/${id}`),
  exportUnderlag: (id: string) => call<Underlag>(`/invoicing/${id}/export`, { method: 'POST', body: '{}' }),
  prices: () => call<Price[]>('/prices'),
  createCustomer: (input: { number: string; name: string; orgRef?: string }) =>
    call<Omit<Customer, 'facilities'>>('/customers', { method: 'POST', body: JSON.stringify(input) }),
  createFacility: (customerId: string, input: { name: string; address?: string; accessNote?: string }) =>
    call<Facility>(`/customers/${customerId}/facilities`, { method: 'POST', body: JSON.stringify(input) }),
  upsertPrice: (input: {
    article: string;
    description: string;
    unit: string;
    priceAmount: string;
    minQty?: string;
    internal?: boolean;
  }) => call<Price>('/prices', { method: 'POST', body: JSON.stringify(input) }),
  protocolTemplates: () => call<ProtocolTemplate[]>('/protocol-templates'),
  orderProtocols: (orderId: string) => call<ProtocolSummary[]>(`/workorders/${orderId}/protocols`),
  instantiateProtocol: (orderId: string, templateKey: string) =>
    call<ProtocolInstance>(`/workorders/${orderId}/protocols`, {
      method: 'POST',
      body: JSON.stringify({ templateKey }),
    }),
  protocol: (id: string) => call<ProtocolDetail>(`/protocols/${id}`),
  fillProtocol: (id: string, itemKey: string, value: boolean | string, note?: string) =>
    call<ProtocolResponse>(`/protocols/${id}/responses`, {
      method: 'POST',
      body: JSON.stringify({ itemKey, value, note }),
    }),
  signProtocol: (id: string) =>
    call<{ instance: ProtocolInstance; signature: ProtocolSignature }>(`/protocols/${id}/sign`, {
      method: 'POST',
      body: '{}',
    }),
  voidProtocol: (id: string, reason: string) =>
    call<ProtocolInstance>(`/protocols/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
};
