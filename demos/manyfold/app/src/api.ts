// Typed client over the Manyfold dev server. The dev persona rides in `x-principal`
// and the active site in `x-site` (both localStorage-backed); in production these become
// a real session + the routed node. Every op goes through /api/op/<name> — the kernel
// checks permissions inside each operation, so the generic transport is exactly as safe.

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

// Better Auth via the worker → the tenant's IdentityDO. A successful call sets the
// same-origin session cookie; the app reloads and /api/me resolves. The FIRST sign-in on a
// fresh instance claims the owner seat (→ admin).
async function authPost(path: string, body: unknown): Promise<void> {
  const res = await fetch(`/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(b.message ?? b.error ?? `Auth failed (${res.status})`, res.status);
  }
}
export const auth = {
  signUp: (email: string, password: string, name: string) => authPost('sign-up/email', { email, password, name }),
  /** Sign up WITH an invite token — allowed even after open sign-up has closed. */
  signUpWithInvite: (email: string, password: string, name: string, token: string) =>
    authPost(`sign-up/email?invite=${encodeURIComponent(token)}`, { email, password, name }),
  signIn: (email: string, password: string) => authPost('sign-in/email', { email, password }),
  signOut: () => authPost('sign-out', {}),
};

// A POST to one of the worker's own JSON routes (invites / accept), not the op transport.
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  const text = await res.text();
  const parsed = (text ? JSON.parse(text) : undefined) as (T & { error?: string }) | undefined;
  if (!res.ok) throw new ApiError(parsed?.error ?? `${res.status}`, res.status);
  return parsed as T;
}

// ── Types mirrored from the vertical (kept minimal, only what the app renders) ──

export type EntryStatus = 'draft' | 'in_review' | 'approved' | 'published' | 'unpublished' | 'archived';

export interface Site { slug: string; name: string }
export interface Caps { read: boolean; author: boolean; review: boolean; publish: boolean; admin: boolean }
export type Me =
  | { mode: 'authed'; principal: string; display: string; site: string | null; can: Caps; role: string }
  | { mode: 'needs-setup' }
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
  // Normalizes both the dev server ({principal,name,site,role}) and the worker
  // ({status:'needs-setup'} | {key,display,site,can} | 401) into one shape.
  me: async (): Promise<Me> => {
    const res = await fetch('/api/me', { headers: headers(), credentials: 'same-origin' });
    if (res.status === 401) return { mode: 'anon' };
    const b = (await res.json().catch(() => ({}))) as {
      status?: string; can?: Caps; key?: string; display?: string; site?: string; principal?: string; name?: string; role?: string;
    };
    if (b.status === 'needs-setup') return { mode: 'needs-setup' };
    if (b.can) return { mode: 'authed', principal: b.key ?? '', display: b.display ?? 'You', site: b.site ?? null, can: b.can, role: roleLabel(b.can) };
    if (b.principal) { const can = capsFromRole(b.role ?? null); return { mode: 'authed', principal: b.principal, display: b.name ?? 'You', site: b.site ?? null, can, role: b.role ?? roleLabel(can) }; }
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
};
