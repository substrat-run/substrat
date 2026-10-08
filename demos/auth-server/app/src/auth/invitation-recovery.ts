const KEY = 'auth-account-invitation';
export type InvitationRecovery =
  | { phase: 'accept'; token: string }
  | { phase: 'choose' | 'phone' | 'done'; email: string }
  | { phase: 'failed' };

/** Keep setup progress in this tab, replacing the single-use token after acceptance. */
export function saveInvitation(state: InvitationRecovery, storage?: Storage): boolean {
  try { (storage ?? (globalThis as unknown as { sessionStorage: Storage }).sessionStorage).setItem(KEY, JSON.stringify(state)); return true; } catch { return false; }
}

/** Only invitation routes may restore the tab's pending token or setup progress. */
export function recoverInvitation(url: URL, storage?: Storage): InvitationRecovery | null {
  if (url.pathname !== '/accept-invitation') return null;
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  if (token) return { phase: 'accept', token };
  try {
    const state = JSON.parse((storage ?? (globalThis as unknown as { sessionStorage: Storage }).sessionStorage).getItem(KEY) ?? 'null') as InvitationRecovery | null;
    if (state?.phase === 'accept' && typeof state.token === 'string' && state.token) return state;
    if (state?.phase === 'failed') return state;
    if (state && ['choose', 'phone', 'done'].includes(state.phase) && 'email' in state && typeof state.email === 'string') return state;
  } catch { /* Disabled storage or malformed old state: use the normal sign-in flow. */ }
  return null;
}
