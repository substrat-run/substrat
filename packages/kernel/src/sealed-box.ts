/**
 * `SealedBox` — the ASYMMETRIC sibling of `SecretBox` (#687,
 * design/signature-contact-carrier.md Option E).
 *
 * `SecretBox` answers "store this where only the holder of the key can read it".
 * This answers a different question, and it is the one a scope cannot otherwise
 * ask: **"hand this to a recipient I cannot talk to."**
 *
 * A hosted vertical's scope has no channel to a connector. Every path from a
 * scope outward is a spine row — the outbox, the platform-request payload — so a
 * symmetric key minted in-scope would have to travel the same rows as the value
 * it protects, which relocates the problem rather than solving it. What breaks
 * the deadlock is that the recipient's PUBLIC half may be projected down (#37's
 * guarantee is about SECRET keys), and a public key is enough to write with.
 *
 * So: the connection holds a keypair, the public half is projected into the
 * scope, module code seals to it before `ctx.emit`, and the connector opens the
 * envelope at egress with the private half — which never leaves the directory.
 * Nothing re-enters the scope actor, which is what sank the read-back design
 * (D-2's verified deadlock).
 *
 * **The envelope is a `SealedSecret`, deliberately.** It is the same cell shape
 * the credential store already writes, and it carries `keyId` for the same
 * reason: a cell that cannot name its key can only ever have ONE key, and every
 * ciphertext already written becomes ambiguous the day a second one exists.
 * Rotation mechanics are deferred (D-4); the envelope that permits them is not.
 *
 * **Crypto here, storage in the adapter** — the division `createSubjectKeys`
 * draws. This file mints, seals and opens; which table the private half sleeps
 * in is the adapter's business.
 */

import { fromBase64, toBase64, type SealedSecret } from './secret-box.js';

// Web Crypto is a runtime global everywhere this runs (Node >= 18, Workers,
// browsers). Declared locally so the kernel needs no platform types, and never a
// node-only import — the same move `secret-box.ts` makes, widened to the
// asymmetric verbs.
declare const crypto: {
  getRandomValues(array: Uint8Array): Uint8Array;
  subtle: {
    generateKey(
      algorithm: { name: 'ECDH'; namedCurve: 'P-256' },
      extractable: boolean,
      usages: string[],
    ): Promise<{ publicKey: CryptoKeyLike; privateKey: CryptoKeyLike }>;
    exportKey(format: 'raw' | 'pkcs8' | 'spki', key: CryptoKeyLike): Promise<ArrayBuffer>;
    importKey(
      format: 'raw' | 'pkcs8',
      keyData: Uint8Array,
      algorithm: { name: 'ECDH'; namedCurve: 'P-256' } | string,
      extractable: boolean,
      usages: string[],
    ): Promise<CryptoKeyLike>;
    deriveBits(
      algorithm: { name: 'ECDH'; public: CryptoKeyLike },
      baseKey: CryptoKeyLike,
      length: number,
    ): Promise<ArrayBuffer>;
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
    encrypt(
      algorithm: { name: 'AES-GCM'; iv: Uint8Array; additionalData?: Uint8Array },
      key: CryptoKeyLike,
      data: Uint8Array,
    ): Promise<ArrayBuffer>;
    decrypt(
      algorithm: { name: 'AES-GCM'; iv: Uint8Array; additionalData?: Uint8Array },
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

/**
 * One recipient keypair, both halves base64 and neither of them JWK.
 *
 * Raw formats rather than JWK because both halves have to survive as STRINGS:
 * the private one goes through `SecretBox.seal`, which takes text, and the
 * public one rides a projection row and an HTTP body. A JWK would be a JSON
 * object inside a JSON field — one more encoding to get wrong, and nothing
 * gained, since the curve is fixed.
 */
export interface SealingKeyPair {
  /** Names this keypair in every envelope it opens. See `SealedSecret.keyId`. */
  keyId: string;
  /** SEC1 uncompressed point (65 bytes), base64. Safe to project, log, or print. */
  publicKey: string;
  /** PKCS#8, base64. Never leaves the directory unsealed. */
  privateKey: string;
}

/** The public half alone — what a recipient publishes and a sender needs. */
export interface SealingPublicKey {
  keyId: string;
  publicKey: string;
}

/** Envelope version. One byte, first byte, so a future scheme is distinguishable. */
const ENVELOPE_V1 = 0x01;
/** ECDH P-256 shared secret: 256 bits. */
const SHARED_BITS = 256;

const ecdhParams = { name: 'ECDH', namedCurve: 'P-256' } as const;

/**
 * Mint a recipient keypair.
 *
 * `keyId` is the caller's to choose and the caller's to keep: it is what a
 * ciphertext written today names when it is opened tomorrow, so it must be
 * stable and unique within whatever set the opener holds. The connection store
 * uses `connection:<id>:<ulid>` — self-describing, and unique across a rotation.
 */
export async function generateSealingKeyPair(keyId: string): Promise<SealingKeyPair> {
  const pair = await crypto.subtle.generateKey(ecdhParams, true, ['deriveBits']);
  const [pub, priv] = await Promise.all([
    crypto.subtle.exportKey('raw', pair.publicKey),
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
  ]);
  return {
    keyId,
    publicKey: toBase64(new Uint8Array(pub)),
    privateKey: toBase64(new Uint8Array(priv)),
  };
}

/**
 * Derive the message key from an ECDH shared secret.
 *
 * HKDF would be the textbook answer; SHA-256 over the shared point plus the
 * ephemeral public key and a fixed label is what this uses, because the kernel's
 * Web Crypto declaration stays small and the properties that matter here are
 * met: the shared point is already uniformly random over the curve, the key is
 * single-use (a fresh ephemeral per seal), and the label domain-separates this
 * envelope from any other use of the same keypair. Every input is bound into the
 * digest, so an attacker who swaps the ephemeral key changes the message key.
 */
const deriveMessageKey = async (
  shared: Uint8Array,
  ephemeralPublic: Uint8Array,
  keyId: string,
): Promise<CryptoKeyLike> => {
  const label = new TextEncoder().encode(`substrat/sealed-box/v1/${keyId}`);
  const material = new Uint8Array(shared.length + ephemeralPublic.length + label.length);
  material.set(shared, 0);
  material.set(ephemeralPublic, shared.length);
  material.set(label, shared.length + ephemeralPublic.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

/**
 * Seal `plaintext` so ONLY the holder of `key`'s private half can read it.
 *
 * ECDH P-256 with a fresh ephemeral keypair per call → AES-256-GCM. The
 * ephemeral public key rides in the envelope, which is what makes the recipient
 * able to derive the same message key without ever having spoken to the sender.
 * Fresh per call for the reason `SecretBox` mints a fresh IV: sealing the same
 * contact twice must not produce the same bytes, and GCM under a reused key+IV
 * is catastrophic rather than merely weak.
 *
 * The `keyId` is bound into the key derivation AND into the GCM additional data,
 * so an envelope cannot be relabelled to point at a different key without the
 * open failing.
 *
 * Callable from MODULE CODE. Web Crypto is a web standard available in every
 * runtime the platform targets, which is exactly the exemption module code has
 * (`globalThis.crypto`); this adds no import a vertical may not make.
 */
export async function sealTo(key: SealingPublicKey, plaintext: string): Promise<SealedSecret> {
  const recipient = await crypto.subtle.importKey(
    'raw',
    fromBase64(key.publicKey),
    ecdhParams,
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey(ecdhParams, true, ['deriveBits']);
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: recipient },
      ephemeral.privateKey,
      SHARED_BITS,
    ),
  );
  const messageKey = await deriveMessageKey(shared, ephemeralPublic, key.keyId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(key.keyId) },
      messageKey,
      new TextEncoder().encode(plaintext),
    ),
  );
  const joined = new Uint8Array(2 + ephemeralPublic.length + iv.length + body.length);
  joined[0] = ENVELOPE_V1;
  joined[1] = ephemeralPublic.length;
  joined.set(ephemeralPublic, 2);
  joined.set(iv, 2 + ephemeralPublic.length);
  joined.set(body, 2 + ephemeralPublic.length + iv.length);
  return { keyId: key.keyId, ciphertext: toBase64(joined) };
}

/**
 * The refusal raised when an envelope names a key the opener does not hold.
 *
 * Typed for the reason `SecretBoxUnconfiguredError` is: it is an OPERATIONAL
 * fact, not a corrupt payload. After rotation-as-erasure (D-5) it is also the
 * *expected* answer for an old ciphertext — a scope restored from a backup can
 * resurrect a pending request whose key has since been destroyed, and that must
 * read as "the key is gone", not as a mystery in a worker tail.
 */
export class SealedKeyUnavailableError extends Error {
  constructor(
    readonly keyId: string,
    message: string,
  ) {
    super(message);
    this.name = 'SealedKeyUnavailableError';
  }
}

/**
 * Open an envelope with whichever held key it names.
 *
 * **Takes a keyId-indexed MAP, not a key** — even when the map has exactly one
 * member. D-4: widening a single-key column into a set later is a migration
 * against live connections, and starting with the map is free. The lookup is
 * also the only thing that makes `keyId` load-bearing rather than decorative.
 */
export async function openSealed(
  privateKeys: Readonly<Record<string, string>>,
  sealed: SealedSecret,
): Promise<string> {
  const priv = privateKeys[sealed.keyId];
  if (!priv) {
    const held = Object.keys(privateKeys);
    throw new SealedKeyUnavailableError(
      sealed.keyId,
      `no private key '${sealed.keyId}' to open this envelope (holding: ${
        held.length > 0 ? held.join(', ') : 'none'
      })`,
    );
  }
  const joined = fromBase64(sealed.ciphertext);
  if (joined[0] !== ENVELOPE_V1) {
    throw new Error(`unknown sealed-box envelope version ${joined[0]} (this build reads v1)`);
  }
  const ephemeralLength = joined[1] ?? 0;
  const ephemeralPublic = joined.slice(2, 2 + ephemeralLength);
  const iv = joined.slice(2 + ephemeralLength, 2 + ephemeralLength + 12);
  const body = joined.slice(2 + ephemeralLength + 12);
  const [sender, recipient] = await Promise.all([
    crypto.subtle.importKey('raw', ephemeralPublic, ecdhParams, false, []),
    crypto.subtle.importKey('pkcs8', fromBase64(priv), ecdhParams, false, ['deriveBits']),
  ]);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, recipient, SHARED_BITS),
  );
  const messageKey = await deriveMessageKey(shared, ephemeralPublic, sealed.keyId);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(sealed.keyId) },
    messageKey,
    body,
  );
  return new TextDecoder().decode(new Uint8Array(plain));
}

/**
 * The refusal `ctx.sealToConnection` raises when no key for that provider has
 * been projected into the scope (#687).
 *
 * Typed, and separate from `SealedKeyUnavailableError`, because it is a
 * DEPLOYMENT fact about the write side rather than a fault in a payload: either
 * the tenant has no live connection for the provider, or the scope was
 * provisioned before the projection carried keys and has not been reconciled.
 * Both are fixed by an operator doing something specific, and the message says
 * which — the same argument `SecretBoxUnconfiguredError` makes.
 *
 * **Failing here is the point.** The alternative — emit the request with the
 * contact silently dropped — is today's invisible failure wearing a new hat: a
 * document starts at the provider and reaches nobody, and nothing in the system
 * says so. §7 point 2 of the carrier design makes the deploy order (control
 * plane and key projection first, vertical second) safe precisely because this
 * throws rather than degrades.
 */
export class ConnectionSealingKeyUnavailableError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionSealingKeyUnavailableError';
  }
}

/**
 * The message every adapter raises for a missing projected key, written once so
 * the pure adapter and the DO adapter cannot drift into two different
 * explanations of one deployment fact.
 */
export const noSealingKeyMessage = (provider: string, scopeId: string): string =>
  `no '${provider}' sealing key is available to scope ${scopeId}, so a value cannot be sealed ` +
  `to that connector. Either this tenant has no live '${provider}' connection — connect it — ` +
  `or it has one whose public key has not reached this scope, which a reconcile of this ` +
  `instance delivers. Refusing rather than emitting the value unsealed or dropping it, ` +
  `because a request nobody can be reached through is the failure this carrier exists to end.`;
