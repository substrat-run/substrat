import nacl from 'tweetnacl';
import { blake2b } from '@noble/hashes/blake2b';

/**
 * libsodium `crypto_box_seal` — the encryption GitHub REQUIRES for writing an Actions
 * secret (`PUT /repos/{repo}/actions/secrets/{name}` takes `encrypted_value` sealed to
 * the repo's public key; plaintext is unrepresentable in that API). Web Crypto has no
 * X25519+XSalsa20-Poly1305, so this is the one spot the worker leans on pure-JS crypto
 * (tweetnacl for box, noble for the BLAKE2b nonce) rather than `globalThis.crypto` —
 * host code, sealing an outbound value with GitHub's key, never at-rest storage (that
 * is SecretBox's job).
 *
 * Construction (the sealed-box spec): ephemeral X25519 keypair; nonce =
 * BLAKE2b-24(ephemeralPk ‖ recipientPk); output = ephemeralPk ‖ box(message).
 */
export function sealForGithub(message: string, recipientPublicKeyB64: string): string {
  const recipientPk = Uint8Array.from(atob(recipientPublicKeyB64), (c) => c.charCodeAt(0));
  // Ephemeral key from OUR randomness (Web Crypto), not tweetnacl's PRNG detection.
  const ephemeral = nacl.box.keyPair.fromSecretKey(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = blake2b
    .create({ dkLen: nacl.box.nonceLength })
    .update(ephemeral.publicKey)
    .update(recipientPk)
    .digest();
  const boxed = nacl.box(new TextEncoder().encode(message), nonce, recipientPk, ephemeral.secretKey);
  const sealed = new Uint8Array(ephemeral.publicKey.length + boxed.length);
  sealed.set(ephemeral.publicKey, 0);
  sealed.set(boxed, ephemeral.publicKey.length);
  return btoa(String.fromCharCode(...sealed));
}
