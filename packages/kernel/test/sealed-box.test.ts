import { describe, it, expect } from 'vitest';
import {
  generateSealingKeyPair,
  openSealed,
  sealTo,
  SealedKeyUnavailableError,
} from '../src/sealed-box.js';

/**
 * The carrier in design/signature-contact-carrier.md rests on exactly the
 * properties below, so these assert those and not that Web Crypto works.
 *
 * The one that matters most is the last pair: an envelope is readable ONLY by
 * the named private half, and relabelling it to name another key does not make
 * another key open it. That is what lets a ciphertext sit in `_substrat_outbox`
 * forever without the spine holding a delivery address.
 */
describe('sealed-box', () => {
  it('round-trips a contact through the public half alone', async () => {
    const kp = await generateSealingKeyPair('connection:01J:01K');
    const contact = JSON.stringify({ email: 'signatory@example.se' });
    // The sender is handed ONLY the public half — the shape a projection carries.
    const sealed = await sealTo({ keyId: kp.keyId, publicKey: kp.publicKey }, contact);

    expect(sealed.keyId).toBe(kp.keyId);
    expect(sealed.ciphertext).not.toContain('signatory');
    expect(await openSealed({ [kp.keyId]: kp.privateKey }, sealed)).toBe(contact);
  });

  it('seals the same value to different bytes each time', async () => {
    // A fresh ephemeral keypair per seal, for the reason SecretBox mints a fresh
    // IV: two parties at the same address must not be linkable by ciphertext
    // equality, and GCM under a repeated key+IV is catastrophic.
    const kp = await generateSealingKeyPair('k1');
    const a = await sealTo(kp, 'ola@example.se');
    const b = await sealTo(kp, 'ola@example.se');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses an envelope naming a key it does not hold, and says which', async () => {
    // The expected answer for a ciphertext whose key was destroyed by rotation
    // (D-5) — it has to read as "the key is gone", not as a corrupt payload.
    const kp = await generateSealingKeyPair('retired');
    const sealed = await sealTo(kp, 'x');
    const err = await openSealed({ current: kp.privateKey }, sealed).catch((e) => e);
    expect(err).toBeInstanceOf(SealedKeyUnavailableError);
    expect(String(err)).toContain('retired');
    expect(String(err)).toContain('current');
  });

  it('does not open under a different keypair that happens to share the keyId', async () => {
    const mine = await generateSealingKeyPair('k1');
    const theirs = await generateSealingKeyPair('k1');
    await expect(openSealed({ k1: theirs.privateKey }, await sealTo(mine, 'secret'))).rejects.toThrow();
  });

  it('does not open a relabelled envelope', async () => {
    // keyId is bound into both the derivation and the GCM additional data, so
    // rewriting the label in a spine row cannot redirect an envelope.
    const kp = await generateSealingKeyPair('k1');
    const sealed = await sealTo(kp, 'secret');
    await expect(
      openSealed({ k9: kp.privateKey }, { ...sealed, keyId: 'k9' }),
    ).rejects.toThrow();
  });
});
