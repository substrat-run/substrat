import { describe, it, expect } from 'vitest';
import {
  isSecretBoxConfigured,
  SecretBoxUnconfiguredError,
  unconfiguredSecretBox,
  webCryptoSecretBox,
} from '../src/secret-box.js';

/**
 * `SecretBox` is the first encryption primitive in the codebase — every
 * `crypto.subtle` call before it was a one-way digest. So these assert the
 * properties a credential store rests on, not that the library works.
 */
describe('webCryptoSecretBox', () => {
  const key = new Uint8Array(32).fill(3);
  const box = webCryptoSecretBox('k1', key);

  it('round-trips a credential', async () => {
    const secret = JSON.stringify({ accessToken: 'tok', refreshToken: 'ref' });
    expect(await box.open(await box.seal(secret))).toBe(secret);
  });

  it('never produces the same ciphertext twice for the same plaintext', async () => {
    // A fresh IV per seal. GCM with a reused IV is catastrophic rather than
    // merely weak, and the tell would be identical blobs — so this is the
    // property worth pinning, not the round-trip above.
    const a = await box.seal('same');
    const b = await box.seal('same');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await box.open(a)).toBe('same');
    expect(await box.open(b)).toBe('same');
  });

  it('refuses a blob sealed by a key it does not hold', async () => {
    const other = webCryptoSecretBox('k2', new Uint8Array(32).fill(9));
    const sealed = await other.seal('secret');
    // Names both ids: an operator has to be able to tell "wrong key configured"
    // from "corrupt blob", and they are fixed very differently.
    await expect(box.open(sealed)).rejects.toThrow(/sealed by key 'k2'.*holding 'k1'/);
  });

  it('rejects a tampered ciphertext rather than returning garbage', async () => {
    // GCM authenticates. Without that, a flipped bit would decrypt to noise and
    // the JSON parse above it would be what failed — much later, and elsewhere.
    const sealed = await box.seal('secret');
    const bytes = [...atob(sealed.ciphertext)].map((c) => c.charCodeAt(0));
    // noUncheckedIndexedAccess: the seal above guarantees a non-empty buffer.
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(box.open({ keyId: 'k1', ciphertext: tampered })).rejects.toThrow();
  });

  it('refuses a key that is not 32 bytes', async () => {
    expect(() => webCryptoSecretBox('short', new Uint8Array(16))).toThrow(/must be 32 bytes/);
  });
});

describe('unconfiguredSecretBox', () => {
  it('fails closed rather than storing anything in the clear', async () => {
    // The alternative — degrading to plaintext — would make a misconfiguration
    // invisible until a credential leaked. Same rule `assertPlatformCall`
    // states: an unset secret is a failure, not a bypass.
    await expect(unconfiguredSecretBox.seal('tok')).rejects.toThrow(/no SecretBox configured/);
    await expect(
      unconfiguredSecretBox.open({ keyId: 'k', ciphertext: 'x' }),
    ).rejects.toThrow(/no SecretBox configured/);
  });

  it('throws a TYPED refusal, so a transport can answer 503 instead of 500 (#603)', async () => {
    // The message alone left every seam matching on text — and the connection route
    // matched on nothing, so a deployment fact surfaced as an unexplained server error.
    await expect(unconfiguredSecretBox.seal('tok')).rejects.toBeInstanceOf(SecretBoxUnconfiguredError);
    await expect(unconfiguredSecretBox.open({ keyId: 'k', ciphertext: 'x' })).rejects.toBeInstanceOf(
      SecretBoxUnconfiguredError,
    );
  });

  it('is what `isSecretBoxConfigured` reports on, so a caller can refuse up front', async () => {
    expect(isSecretBoxConfigured(unconfiguredSecretBox)).toBe(false);
    expect(isSecretBoxConfigured(undefined)).toBe(false);
    expect(isSecretBoxConfigured(webCryptoSecretBox('k1', new Uint8Array(32).fill(3)))).toBe(true);
  });
});
