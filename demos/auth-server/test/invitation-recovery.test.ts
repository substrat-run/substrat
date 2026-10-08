import { describe, expect, it } from 'vitest';
import { recoverInvitation, saveInvitation } from '../app/src/auth/invitation-recovery.js';
function storage(): Storage {
  const values = new Map<string, string>();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); },
    removeItem: (k) => { values.delete(k); }, clear: () => values.clear(), key: () => null, get length() { return values.size; } };
}
describe('invitation recovery in the current tab', () => {
  const url = new URL('https://issuer.test/accept-invitation');
  it('retains a pending token across reload after clearing the hash', () => {
    const tab = storage();
    const pending = recoverInvitation(new URL(`${url}#token=secret-token`), tab)!;
    expect(saveInvitation(pending, tab)).toBe(true);
    expect(recoverInvitation(url, tab)).toEqual(pending);
    expect(recoverInvitation(new URL('https://issuer.test/login'), tab)).toBeNull();
  });
  it('replaces consumed tokens with setup progress, and lets a new link override it', () => {
    const tab = storage();
    saveInvitation({ phase: 'accept', token: 'consumed' }, tab);
    saveInvitation({ phase: 'choose', email: 'invitee@example.test' }, tab);
    expect(recoverInvitation(url, tab)).toEqual({ phase: 'choose', email: 'invitee@example.test' });
    expect(tab.getItem('auth-account-invitation')).not.toContain('consumed');
    expect(recoverInvitation(new URL(`${url}#token=new-token`), tab)).toEqual({ phase: 'accept', token: 'new-token' });
    saveInvitation({ phase: 'phone', email: 'invitee@example.test' }, tab);
    expect(recoverInvitation(url, tab)?.phase).toBe('phone');
  });
  it('does not reuse the token after an ambiguous acceptance failure', () => {
    const tab = storage();
    saveInvitation({ phase: 'accept', token: 'maybe-consumed' }, tab);
    saveInvitation({ phase: 'failed' }, tab);
    expect(recoverInvitation(url, tab)).toEqual({ phase: 'failed' });
    expect(tab.getItem('auth-account-invitation')).not.toContain('maybe-consumed');
  });
  it('keeps the URL path usable when tab storage is unavailable', () => {
    const tab = { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); } } as unknown as Storage;
    expect(saveInvitation({ phase: 'accept', token: 'secret' }, tab)).toBe(false);
    expect(recoverInvitation(new URL(`${url}#token=secret`), tab)).toEqual({ phase: 'accept', token: 'secret' });
    expect(recoverInvitation(url, tab)).toBeNull();
  });
});
