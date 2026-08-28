// Typed client over Manyfold. Identity is the session cookie — the same in dev and in
// production, because both entrypoints run the same relying-party flow. The active site rides
// in `x-site` (localStorage-backed) and is SELECTION, not auth: it says which of the tenant's
// scopes to run against, and the kernel re-checks your authority there regardless.
// Every op goes through /api/op/<name>, so the generic transport is exactly as safe.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const SITE_KEY = 'manyfold.site';

export const getSite = (): string => localStorage.getItem(SITE_KEY) ?? 'cafe';
export const setSite = (slug: string): void => localStorage.setItem(SITE_KEY, slug);

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  h['x-site'] = getSite(); // active site (scope) selector — auth is the session cookie
  return h;
}

export async function op<T>(name: string, input: unknown = {}): Promise<T> {
  const res = await fetch(`/api/op/${name}`, { method: 'POST', headers: headers(), credentials: 'same-origin', body: JSON.stringify(input) });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `${res.status}`, res.status);
  return body;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers(), credentials: 'same-origin' });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `${res.status}`, res.status);
  return body;
}

// OIDC-only (oidc-only-demos.md): the vertical hosts no credential endpoints. Login, sign-up,
// password, and reset all live at the issuer; the app redirects to `/api/auth/{login,logout}`
// (the relying-party flow). The first sign-in on a fresh instance still claims the owner seat
// (→ admin) via the worker's provider-agnostic sub→principal binding.
export const auth = {
  login: (returnTo = '/') => { location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`); },
  /** Sign in as somebody else. `prompt=select_account` is what makes this work past an SSO
   *  session; the local dev issuer keeps none, so its picker appears either way. */
  switchUser: (returnTo = '/') => { location.assign(`/api/auth/login?prompt=select_account&returnTo=${encodeURIComponent(returnTo)}`); },
  logout: () => { location.assign('/api/auth/logout'); },
};

// A POST to one of the worker's own JSON routes (invites / accept), not the op transport.
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: (T & { error?: string; detail?: string }) | undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // A non-JSON body (a proxy page, a cold start) still carries a status worth acting on.
    if (!res.ok) throw new ApiError(`${res.status}`, res.status);
    throw new ApiError('unexpected non-JSON response', res.status);
  }
  if (!res.ok) throw new ApiError(parsed?.detail ?? parsed?.error ?? `${res.status}`, res.status);
  return parsed as T;
}

// ── Types mirrored from the vertical (kept minimal, only what the app renders) ──

export type EntryStatus = 'draft' | 'in_review' | 'approved' | 'published' | 'unpublished' | 'archived';

export interface Site { slug: string; name: string }
export interface Caps { read: boolean; author: boolean; review: boolean; publish: boolean; admin: boolean }
export type Me =
  | { mode: 'authed'; principal: string; display: string; site: string | null; can: Caps; role: string }
  | { mode: 'needs-setup'; firstSignInOpen: boolean }
  | { mode: 'anon' };

export function capsFromRole(role: string | null): Caps {
  const r = role ?? '';
  return {
    read: true,
    author: ['author', 'editor', 'publisher', 'admin'].includes(r),
    review: ['editor', 'publisher', 'admin'].includes(r),
    publish: ['publisher', 'admin'].includes(r),
    admin: r === 'admin',
  };
}
export const roleLabel = (c: Caps): string => (c.admin ? 'admin' : c.publish ? 'publisher' : c.review ? 'editor' : c.author ? 'author' : 'viewer');
export interface EntryListItem { id: string; type_key: string; status: EntryStatus; slug: string | null; title: string; updated_at: string }
export interface FieldDef { type: string; required?: boolean; index?: boolean; options?: string[]; target?: string; source?: string; maxLen?: number }
export interface ContentTypeDef { key: string; version: number; title: string; titleField: string; slugField?: string; fields: Record<string, FieldDef> }
export interface RevisionMeta { rev_no: number; frozen: number; hash: string | null; author: string; created_at: string }
export interface EntryDetail { entry: { id: string; type_key: string; status: EntryStatus; slug: string | null; draft_rev: number; published_rev: number | null; created_at: string; updated_at: string }; body: Record<string, unknown>; revisions: RevisionMeta[] }
export interface DeliveryItem { type_key: string; slug: string | null; title: string; hash: string }
export interface Invite { principal: string; roleKey: string; email: string | null; createdAt: number }
export interface InvitesResult { roles: string[]; invites: Invite[] }
export interface CreatedInvite { principal: string; roleKey: string; email: string | null; acceptUrl: string }

export const api = {
  sites: () => get<Site[]>('/api/sites'),
  /** Request a new site (needs `content:manage-sites`). Returns the platform-request id; the new
   *  site appears in `sites()` once the platform provisions it (poll after this). */
  createSite: (slug: string, name: string) => postJson<{ requestId: string }>('/api/sites', { slug, name }),
  /** Archive a site (needs `content:manage-sites`). It leaves the switcher immediately; the platform
   *  retires the scope. */
  archiveSite: (slug: string) => postJson<{ requestId: string }>(`/api/sites/${encodeURIComponent(slug)}/archive`, {}),
  // `{status:'needs-setup'} | {key,display,site,can} | 401` — one shape, because both
  // entrypoints now answer identically. It used to also accept a `{principal,name,role}`
  // variant that only the dev server produced.
  me: async (): Promise<Me> => {
    const res = await fetch('/api/me', { headers: headers(), credentials: 'same-origin' });
    if (res.status === 401) return { mode: 'anon' };
    const b = (await res.json().catch(() => ({}))) as {
      status?: string; firstSignInOpen?: boolean; can?: Caps; key?: string; display?: string; site?: string;
    };
    if (b.status === 'needs-setup') return { mode: 'needs-setup', firstSignInOpen: b.firstSignInOpen === true };
    if (b.can) return { mode: 'authed', principal: b.key ?? '', display: b.display ?? 'You', site: b.site ?? null, can: b.can, role: roleLabel(b.can) };
    return { mode: 'anon' };
  },
  /** `me` resolved against a specific site — powers the "roles are per site" rail (K-22):
   *  the same login is a different authority in each scope. */
  meForSite: async (slug: string): Promise<{ role: string | null }> => {
    const res = await fetch('/api/me', { headers: { 'content-type': 'application/json', 'x-site': slug }, credentials: 'same-origin' });
    if (!res.ok) return { role: null };
    const b = (await res.json().catch(() => ({}))) as { can?: Caps; role?: string };
    if (b.role) return { role: b.role };
    if (b.can) return { role: roleLabel(b.can) };
    return { role: null };
  },
  listTypes: () => op<{ def: ContentTypeDef; sql: string }[]>('list-types'),
  saveType: (def: { key: string; title: string; titleField: string; slugField?: string; fields: Record<string, FieldDef> }) => op<ContentTypeDef>('save-type', def),
  deleteType: (key: string) => op<{ deleted: string }>('delete-type', { key }),
  listEntries: (input: { typeKey?: string; status?: EntryStatus } = {}) => op<EntryListItem[]>('list-entries', input),
  reviewQueue: () => op<EntryListItem[]>('review-queue'),
  getEntry: (entryId: string) => op<EntryDetail>('get-entry', { entryId }),
  createEntry: (typeKey: string, body: Record<string, unknown>) => op<EntryDetail['entry']>('create-entry', { typeKey, body }),
  saveDraft: (entryId: string, body: Record<string, unknown>) => op<EntryDetail['entry']>('save-draft', { entryId, body }),
  restore: (entryId: string, revNo: number) => op<EntryDetail['entry']>('restore-revision', { entryId, revNo }),
  submit: (entryId: string) => op('submit-for-review', { entryId }),
  approve: (entryId: string) => op('approve', { entryId }),
  reject: (entryId: string, note: string) => op('reject', { entryId, note }),
  publish: (entryId: string) => op('publish', { entryId }),
  unpublish: (entryId: string) => op('unpublish', { entryId }),
  archive: (entryId: string) => op('archive', { entryId }),
  deliver: (typeKey: string, slug: string) => op<{ type: string; slug: string | null; hash: string; publishedAt: string; body: Record<string, unknown> }>('deliver', { typeKey, slug }),
  listDelivery: (input: { typeKey?: string } = {}) => op<DeliveryItem[]>('list-delivery', input),
  // Members & invites (worker routes; 404 on the dev server).
  listInvites: () => get<InvitesResult>('/api/invites'),
  createInvite: (email: string | undefined, roleKey: string) => postJson<CreatedInvite>('/api/invites', { email, roleKey }),
  revokeInvite: (principal: string) => postJson<null>(`/api/invites/${principal}/revoke`, {}),
  acceptInvite: (token: string) => postJson<{ ok: boolean }>('/api/accept-invite', { token }),
  /** Claim the owner seat with a dashboard-minted claim link's token (#925). */
  claimOwner: (token: string) => postJson<{ ok: boolean }>('/api/claim-owner', { token }),
};
