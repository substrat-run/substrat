/** Private, short-lived positions for a per-row-filtered walk (#2074). */
import { PAGE_CURSOR_RESTART, substratError } from '@substrat-run/contracts';
import { fromBase64, toBase64, webCryptoSecretBox, type SealedSecret } from './secret-box.js';
import { isPlainPageCursor } from './list-index.js';

declare const crypto: {
  getRandomValues<T extends Uint8Array>(bytes: T): T;
  subtle: { digest(name: 'SHA-256', bytes: Uint8Array): Promise<ArrayBuffer> };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

const TOKEN_PREFIX = 'sc1';
const TOKEN_PLAINTEXT_LENGTH = 192;
const LIFETIME_MS = 15 * 60_000;
const ROTATION_MS = 24 * 60 * 60_000;
export const CONTINUATION_POSITION_CAP = 256;
/** Remove this migration window at the next cursor-breaking release. */
const ACCEPT_LEGACY_VISIBLE_CURSORS = true;

export interface ContinuationKey {
  id: string;
  /** Raw AES-256 key, base64 encoded only inside adapter-private storage. */
  material: string;
  createdAt: number;
}

export interface ContinuationKeys {
  active: ContinuationKey;
  previous?: ContinuationKey;
}

export interface ContinuationPosition {
  sealed: SealedSecret;
  expiresAt: number;
}

/** Neither keys nor positions may be stored in module-readable scope SQL or a dump. */
export interface ContinuationStore {
  keys(): Promise<ContinuationKeys | null>;
  setKeys(keys: ContinuationKeys): Promise<void>;
  position(id: string, expiresAt: number): Promise<ContinuationPosition | null>;
  setPosition(id: string, position: ContinuationPosition): Promise<void>;
}

/** Everything that makes the position mean the same walk, with no raw input kept. */
export interface ContinuationBinding {
  scopeId: string;
  principal: string;
  operation: string;
  list: string;
  query: unknown;
}

const restart = () => substratError(
  'validation_failed',
  'list: this cursor cannot continue this walk — restart paging from the first page, without a cursor',
  { reason: PAGE_CURSOR_RESTART },
);

const random = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size));
const base64url = (bytes: Uint8Array): string => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const unbase64url = (text: string): Uint8Array => fromBase64(text.replace(/-/g, '+').replace(/_/g, '/'));
const key = (now: number): ContinuationKey => ({ id: base64url(random(9)), material: toBase64(random(32)), createdAt: now });

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Set) return `[${[...value].map(canonical).sort().join(',')}]`;
  if (value instanceof Map) return `{${[...value].map(([k, v]) => [canonical(k), canonical(v)] as const)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join(',')}}`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** SQL IN filters are sets; request order and duplicates must not change a walk's identity. */
function normalizeFilter(value: unknown): unknown {
  if (Array.isArray(value)) {
    const members = new Map(value.map((item) => {
      const normalized = normalizeFilter(item);
      return [canonical(normalized), normalized] as const;
    }));
    return [...members.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
  }
  if (value && typeof value === 'object' && !(value instanceof Set) && !(value instanceof Map)) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalizeFilter(item)]));
  }
  return value;
}

async function bindingHash(binding: ContinuationBinding): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(binding));
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function box(material: ContinuationKey) {
  const bytes = fromBase64(material.material);
  if (bytes.length !== 32) throw restart();
  return webCryptoSecretBox(material.id, bytes);
}

/** Full visible pages are stateless; only a hidden budget stop needs a private locator. */
export function visibleContinuation(
  store: ContinuationStore,
  binding: ContinuationBinding,
  now: () => number = Date.now,
  legacyUsed?: () => void,
  writable = true,
) {
  // Pagination mechanics do not change the rows in the walk. Every other input,
  // including a grant constraint, does; bind it without retaining its raw value.
  const query = binding.query && typeof binding.query === 'object' && !Array.isArray(binding.query)
    ? Object.fromEntries(Object.entries(binding.query).filter(([name]) =>
        !['cursor', 'limit', 'rowCursors', 'total'].includes(name)))
    : binding.query ?? {};
  if (query && typeof query === 'object' && !Array.isArray(query) && 'filters' in query) {
    query.filters = normalizeFilter(query.filters);
  }
  let fingerprint: Promise<string> | undefined;
  const hash = () => (fingerprint ??= bindingHash({ ...binding, query }));
  const readKeys = async (): Promise<ContinuationKeys | null> => {
    try { return await store.keys(); } catch { throw restart(); }
  };
  return {
    async seal(position: string, hidden = true): Promise<string | null> {
      // A read-only invocation (including a copy) cannot persist a hidden
      // position. It keeps the former bounded-walk result at this budget stop.
      if (hidden && !writable) return null;
      try {
        const at = now();
        let keys = await readKeys();
        if (!writable && !keys) return null;
        if (writable && (!keys || at - keys.active.createdAt >= ROTATION_MS)) {
          keys = { active: key(at), ...(keys ? { previous: keys.active } : {}) };
          await store.setKeys(keys);
        }
        if (!keys) return null;
        const expiresAt = at + LIFETIME_MS;
        let payload: string;
        if (hidden) {
          const id = base64url(random(16));
          const sealed = await box(keys.active).seal(JSON.stringify({ id, position }));
          await store.setPosition(id, { sealed, expiresAt });
          payload = JSON.stringify({ i: id, e: expiresAt, b: await hash() });
          if (payload.length > TOKEN_PLAINTEXT_LENGTH) throw restart();
          payload = payload.padEnd(TOKEN_PLAINTEXT_LENGTH, ' ');
        } else {
          payload = JSON.stringify({ p: position, e: expiresAt, b: await hash() });
        }
        const token = await box(keys.active).seal(payload);
        return `${TOKEN_PREFIX}.${keys.active.id}.${base64url(fromBase64(token.ciphertext))}`;
      } catch {
        if (!writable) return null;
        throw restart();
      }
    },
    async open(cursor: string): Promise<string> {
      if (!cursor.startsWith(`${TOKEN_PREFIX}.`)) {
        try {
          if (ACCEPT_LEGACY_VISIBLE_CURSORS && isPlainPageCursor(cursor)) {
            legacyUsed?.();
            return cursor;
          }
        } catch { /* All invalid legacy cursors have the same restart response. */ }
        throw restart();
      }
      try {
        const parts = cursor.split('.');
        if (parts.length !== 3 || !/^[A-Za-z0-9_-]{12}$/.test(parts[1]!) ||
            !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) throw restart();
        const keys = await readKeys();
        const selected = [keys?.active, keys?.previous].find((candidate) => candidate?.id === parts[1]);
        if (!selected) throw restart();
        const decoded = await box(selected).open({ keyId: selected.id, ciphertext: toBase64(unbase64url(parts[2]!)) });
        const payload = JSON.parse(decoded.trimEnd()) as { i?: unknown; p?: unknown; e?: unknown; b?: unknown };
        if (typeof payload.e !== 'number' || payload.e <= now() || payload.b !== await hash()) throw restart();
        if ('p' in payload) {
          if (typeof payload.p !== 'string') throw restart();
          return payload.p;
        }
        if (decoded.length !== TOKEN_PLAINTEXT_LENGTH ||
            typeof payload.i !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(payload.i)) throw restart();
        const record = await store.position(payload.i, payload.e);
        if (!record || record.expiresAt !== payload.e || record.expiresAt <= now()) throw restart();
        const opened = JSON.parse(await box(selected).open(record.sealed)) as { id?: unknown; position?: unknown };
        if (opened.id !== payload.i || typeof opened.position !== 'string') throw restart();
        return opened.position;
      } catch {
        // No parsing, key, authentication, expiry or binding detail reaches a caller.
        throw restart();
      }
    },
  };
}
