/**
 * `SecretBox` — the seal/open adapter the connection store rests on (#101,
 * design/connections.md §3.3).
 *
 * **Bucket 2 in D-18's triage**, which names the KMS as an adapter explicitly.
 * The kernel decides that per-tenant credentials are encrypted at rest and that
 * plaintext never touches the directory; *what* does the encrypting is swappable
 * — Web Crypto locally, a Cloudflare Secrets Store binding or an external KMS
 * when hosted.
 *
 * Before this existed there was no encryption primitive in the codebase at all:
 * every `crypto.subtle` call was a one-way digest, and every secret was a
 * plaintext Worker binding. Nothing was per-tenant, nothing was rotatable.
 */

import { SubstratError } from '@substrat-run/contracts';

/**
 * Sealed bytes plus the id of the key that sealed them.
 *
 * `keyId` is what makes rotation possible: a new key seals new writes while old
 * blobs stay openable, so re-sealing is a background sweep rather than a
 * flag-day. A `SecretBox` that cannot name its key can only ever have one.
 */
export interface SealedSecret {
  keyId: string;
  /** Opaque to everything above this interface. Base64 for the Web Crypto impl. */
  ciphertext: string;
}

export interface SecretBox {
  seal(plaintext: string): Promise<SealedSecret>;
  /** Throws if the blob was sealed by a key this box does not hold. */
  open(sealed: SealedSecret): Promise<string>;
}

// Web Crypto is a runtime global everywhere this runs (Node ≥ 18, Workers,
// browsers). Declared locally so the kernel needs no platform types, and never a
// node-only import.
declare const crypto: {
  getRandomValues(array: Uint8Array): Uint8Array;
  subtle: {
    importKey(
      format: 'raw',
      keyData: Uint8Array,
      algorithm: string,
      extractable: boolean,
      usages: string[],
    ): Promise<CryptoKeyLike>;
    encrypt(
      algorithm: { name: 'AES-GCM'; iv: Uint8Array },
      key: CryptoKeyLike,
      data: Uint8Array,
    ): Promise<ArrayBuffer>;
    decrypt(
      algorithm: { name: 'AES-GCM'; iv: Uint8Array },
      key: CryptoKeyLike,
      data: Uint8Array,
    ): Promise<ArrayBuffer>;
  };
};
interface CryptoKeyLike {
  readonly type: string;
}
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new () => { decode(input: Uint8Array): string };
// Web-standard and present in Node >= 16, Workers and browsers alike; declared
// here for the same reason as the rest — the kernel pulls in no platform types.
declare const btoa: (input: string) => string;
declare const atob: (input: string) => string;

/**
 * Exported for `subject-keys.ts`, which has to move raw key BYTES through a string-shaped
 * `SecretBox` (a DEK is 32 bytes; `seal` takes text). Deliberately not a general-purpose
 * utility export — nothing else should need to reach below this file's abstraction.
 */
export const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** The inverse; see `toBase64` above for why it is exported. */
export const fromBase64 = (b64: string): Uint8Array => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
};

/**
 * AES-256-GCM over Web Crypto — the default for dev, CI and self-hosting.
 *
 * `key` is 32 raw bytes. A fresh 96-bit IV per seal is prepended to the
 * ciphertext, which is what makes it safe to seal the same credential twice;
 * GCM with a reused IV is catastrophic rather than merely weak.
 *
 * **Fails closed when unconfigured.** A host built without a `SecretBox` cannot
 * store a credential at all, rather than storing one in the clear. That is the
 * rule `assertPlatformCall` already states — *"an unset secret is a failure, not
 * a bypass"* — applied to the thing it most obviously protects. Note the router
 * secret does the opposite; it is not a precedent to copy here.
 */
export function webCryptoSecretBox(keyId: string, key: Uint8Array): SecretBox {
  if (key.length !== 32) {
    throw new Error(`SecretBox key must be 32 bytes (AES-256), got ${key.length}`);
  }
  const imported = crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return {
    async seal(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          await imported,
          new TextEncoder().encode(plaintext),
        ),
      );
      const joined = new Uint8Array(iv.length + body.length);
      joined.set(iv, 0);
      joined.set(body, iv.length);
      return { keyId, ciphertext: toBase64(joined) };
    },
    async open(sealed) {
      if (sealed.keyId !== keyId) {
        // Naming the ids is safe and is the only way an operator can tell
        // "wrong key configured" from "corrupt blob".
        throw new Error(
          `SecretBox cannot open a secret sealed by key '${sealed.keyId}' (holding '${keyId}')`,
        );
      }
      const joined = fromBase64(sealed.ciphertext);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: joined.slice(0, 12) },
        await imported,
        joined.slice(12),
      );
      return new TextDecoder().decode(new Uint8Array(plain));
    },
  };
}

/**
 * The refusal a host without a `SecretBox` raises (#603).
 *
 * Typed rather than a plain `Error` because it is a **deployment fact**, not a
 * fault in the request: the caller sent a well-formed credential to a host that
 * was started without a seal key. A transport that cannot tell the two apart
 * answers 500 and sends the operator hunting through a worker tail for a fact
 * the process knew at boot. Every seam that can raise it maps it to a typed
 * 503 naming the missing key.
 */
export class SecretBoxUnconfiguredError extends SubstratError {
  constructor(message: string) {
    super('unavailable', message);
    // Kept, not generalised — `mapError` matches this class today, and contracts'
    // `CODE_BY_ERROR_NAME` reads the name back as `unavailable` across a boundary.
    this.name = 'SecretBoxUnconfiguredError';
  }
}

/**
 * The box a host gets when none was configured: every call throws.
 *
 * Deliberately not "store it in the clear" and not "silently disable
 * connections" — either would make a misconfiguration invisible until a
 * credential leaked. Reading the error tells an operator exactly what to set.
 */
export const unconfiguredSecretBox: SecretBox = {
  seal() {
    return Promise.reject(
      new SecretBoxUnconfiguredError(
        'no SecretBox configured: this host cannot store credentials. ' +
          'Pass one to the host (webCryptoSecretBox with a 32-byte key) — ' +
          'storing a credential unsealed is not an option.',
      ),
    );
  },
  open() {
    return Promise.reject(
      new SecretBoxUnconfiguredError('no SecretBox configured: cannot open a stored credential'),
    );
  },
};

/**
 * Whether a host can seal at all — the question a caller asks BEFORE doing work
 * whose only purpose is to produce something to store (#603).
 *
 * Identity against `unconfiguredSecretBox` rather than a flag on the interface:
 * "unconfigured" is exactly the one box this module hands out, and keeping the
 * `SecretBox` interface at two methods means an external KMS adapter has nothing
 * extra to implement.
 */
export const isSecretBoxConfigured = (box: SecretBox | undefined): boolean =>
  box !== undefined && box !== unconfiguredSecretBox;
