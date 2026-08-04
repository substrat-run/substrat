/**
 * The admin dashboard's API surface — deliberately narrower than the
 * storefront's. No cart, no checkout, no browse: a back-office client that
 * cannot place an order even by accident. The kernel enforces this regardless;
 * omitting it here just means the wrong call is unwriteable, not merely denied.
 */

export interface Money {
  amount: string;
  currency: string;
}

export interface StockRow {
  productId: string;
  productName: string;
  slug: string;
  published: number;
  variantId: string;
  sku: string;
  grind: string;
  sizeLabel: string;
  price: Money;
  onHand: number;
  reserved: number;
  available: number;
}

export interface OrderRow {
  id: string;
  number: number;
  customer_id: string;
  owner: string;
  status: 'placed' | 'fulfilled' | 'closed' | 'cancelled';
  payment_method: string;
  discount_code: string | null;
  subtotal_amount: string;
  discount_amount: string;
  total_amount: string;
  currency: string;
  placed_at: string;
}

export interface OrderLineRow {
  id: string;
  sku: string;
  name: string;
  grind: string;
  size_label: string;
  qty: number;
  unit_price_amount: string;
  line_total_amount: string;
  currency: string;
}

export interface Underlag {
  id: string;
  number: number;
  customer_id: string;
  status: 'open' | 'exported';
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

export interface Me {
  authenticated: boolean;
  principal?: string;
  display?: string;
  via?: string;
  role?: string;
  customerId?: string | null;
}

/** Thrown so views can distinguish a permission wall (403) from other failures. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include', // carry the Better Auth session cookie
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `${res.status}`, res.status);
  return body;
}

/** Better Auth REST endpoints (own error shape) — used by the login screen. */
async function authCall(path: string, payload?: unknown): Promise<void> {
  const res = await fetch(`/api/auth${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(body.message ?? body.error ?? `${res.status}`, res.status);
  }
}

export const api = {
  me: () => call<Me>('/me'),
  signIn: (email: string, password: string) => authCall('/sign-in/email', { email, password }),
  signOut: () => authCall('/sign-out'),

  // catalogue & stock
  stock: () => call<StockRow[]>('/stock'),
  setStock: (variantId: string, onHand: number) =>
    call<{ variantId: string; onHand: number }>(`/variants/${variantId}/stock`, {
      method: 'POST',
      body: JSON.stringify({ onHand }),
    }),
  publishProduct: (productId: string, published: boolean) =>
    call<{ id: string; name: string; published: number }>(`/products/${productId}/publish`, {
      method: 'POST',
      body: JSON.stringify({ published }),
    }),

  // orders
  orders: () => call<OrderRow[]>('/orders'),
  order: (id: string) => call<{ order: OrderRow; lines: OrderLineRow[] }>(`/orders/${id}`),
  fulfil: (id: string) => call<OrderRow>(`/orders/${id}/fulfil`, { method: 'POST', body: '{}' }),
  close: (id: string) => call<OrderRow>(`/orders/${id}/close`, { method: 'POST', body: '{}' }),

  // reused invoicing engine
  invoicing: () => call<Underlag[]>('/invoicing'),
  underlag: (id: string) =>
    call<{ underlag: Underlag; lines: UnderlagLine[]; total: string }>(`/invoicing/${id}`),
  exportUnderlag: (id: string) => call<Underlag>(`/invoicing/${id}/export`, { method: 'POST', body: '{}' }),
};

export const kr = (amount: string): string =>
  `${Number(amount).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kr`;
