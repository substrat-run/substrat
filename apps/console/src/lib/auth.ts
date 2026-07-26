/**
 * Console staff auth. Sign-in is an OIDC redirect to the control plane's relying
 * party (AuthHero); the session is a same-origin cookie the control plane sets, so
 * `credentials: 'include'` carries it. `getSession` asks the control plane for the
 * current staff email; sign-in and sign-out are full-page redirects — the OIDC
 * round-trip needs a real navigation, not a fetch.
 */
export interface StaffSession {
  email: string;
}

export async function getSession(): Promise<StaffSession | null> {
  const res = await fetch('/api/auth/session', { credentials: 'include' });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { user?: { email?: string } | null } | null;
  return data?.user?.email ? { email: data.user.email } : null;
}

/** Redirect into the OIDC login flow; the browser comes back to the console signed in. */
export function signIn(opts: { returnTo?: string } = {}): void {
  const rt = opts.returnTo;
  window.location.href = `/api/auth/login${rt ? `?returnTo=${encodeURIComponent(rt)}` : ''}`;
}

/** Drop the session and return to the console. Always federated: signed-out visits
 * redirect straight to the IdP, so a logout that left the IdP's SSO cookie alive
 * would silently sign the user right back in. */
export function signOut(): void {
  window.location.href = '/api/auth/logout?federated';
}
