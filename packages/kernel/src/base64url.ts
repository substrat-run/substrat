/**
 * base64url (RFC 4648 §5, unpadded) over Web-standard `btoa`/`atob` — the same call in
 * workerd, node and browsers. The kernel's lib is ES-only, so the globals are declared.
 */
declare const btoa: (input: string) => string;
declare const atob: (input: string) => string;

/** The alphabet, whole: what `toBase64url` can emit and `fromBase64url` will accept. */
export const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function toBase64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes, or `undefined` for a string outside the alphabet or of an impossible length. */
export function fromBase64url(s: string): Uint8Array | undefined {
  if (!BASE64URL.test(s) || s.length % 4 === 1) return undefined;
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
