export interface Money {
  amount: string;
  currency: string;
}

export interface CatalogVariant {
  id: string;
  sku: string;
  grind: string;
  sizeLabel: string;
  price: Money;
  available: number;
}
export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  origin: string;
  notes: string;
  roast: number;
  published: number;
  variants: CatalogVariant[];
}

export interface CartLine {
  lineId: string;
  variantId: string;
  sku: string;
  name: string;
  grind: string;
  sizeLabel: string;
  qty: number;
  unitPrice: Money;
  lineTotal: Money;
}
export interface Cart {
  id: string;
  lines: CartLine[];
  subtotal: Money;
}

export interface Quote {
  subtotal: Money;
  discount: Money;
  total: Money;
  discountCode: string | null;
  discountValid: boolean;
  message: string | null;
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
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `${res.status}`, res.status);
  return body;
}

export interface Me {
  authenticated: boolean;
  principal?: string;
  display?: string;
  via?: string;
  role?: string;
  customerId?: string | null;
}

/**
 * Signing in is a NAVIGATION, not a fetch: the browser leaves for the issuer, authenticates
 * there, and comes back to `/api/auth/callback` with a session cookie. There is no
 * `signUp` here on purpose — creating an account is the issuer's screen, not the shop's.
 */
export const auth = {
  login: (returnTo = '/') => location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
  logout: () => location.assign('/api/auth/logout'),
};

export const api = {
  me: () => call<Me>('/me'),

  // storefront — published rows only; drafts need catalog:manage, which is the
  // back-office's business, not the shop's.
  catalog: () => call<CatalogProduct[]>('/catalog'),
  createCart: () => call<{ id: string }>('/carts', { method: 'POST', body: '{}' }),
  cart: (id: string) => call<Cart>(`/carts/${id}`),
  addToCart: (id: string, variantId: string, qty: number, holdSeconds?: number) =>
    call<{ lineId: string; reserved: number; availableAfter: number }>(`/carts/${id}/lines`, {
      method: 'POST',
      body: JSON.stringify({ variantId, qty, ...(holdSeconds !== undefined ? { holdSeconds } : {}) }),
    }),
  setLineQty: (id: string, lineId: string, qty: number) =>
    call<{ lineId: string; qty: number; removed: boolean }>(`/carts/${id}/lines/${lineId}`, {
      method: 'PATCH',
      body: JSON.stringify({ qty }),
    }),
  removeLine: (id: string, lineId: string) =>
    call<{ released: boolean }>(`/carts/${id}/lines/${lineId}`, { method: 'DELETE' }),
  quote: (id: string, discountCode?: string) =>
    call<Quote>(`/carts/${id}/quote`, {
      method: 'POST',
      body: JSON.stringify(discountCode !== undefined ? { discountCode } : {}),
    }),
  checkout: (
    id: string,
    input: { customerId: string; paymentMethod?: 'invoice' | 'card'; discountCode?: string },
  ) => call<{ order: OrderRow; lines: OrderLineRow[] }>(`/carts/${id}/checkout`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),

  // portal — the shopper's own orders, reachable through an entity-narrowed
  // grant rather than a role. `order` is the same operation the back-office
  // calls; the kernel decides who may read which one.
  portalOrders: () => call<OrderRow[]>('/portal/orders'),
  order: (id: string) => call<{ order: OrderRow; lines: OrderLineRow[] }>(`/orders/${id}`),
};

export const kr = (amount: string): string =>
  `${Number(amount).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kr`;
