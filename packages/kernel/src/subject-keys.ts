/**
 * Per-subject data keys — the mechanism under `piiClass` (#37, master-plan §5.3).
 *
 * The classification has been enforced at the type level since the contracts package
 * existed: an event carrying PII cannot be declared without a `subjectId`, on the stated
 * grounds that *"crypto-shredding must be able to key the erasure"*. This is the erasure.
 *
 * **Why crypto at all, when a database has DELETE.** It is not needed for the live scope
 * — Tier 1 is mutable, so erasing there is an ordinary redaction. It is needed for the
 * copies the platform KEEPS and cannot rewrite: a reap backup, a stored dump, and (when it
 * lands) the Tier-2 event lake. Those are full-fidelity on purpose — *"a backup that cannot
 * restore is a false promise"* (`backups.ts`) — which is exactly why a DELETE can never
 * reach into one. Sealing each subject's payloads under their own key at the moment the
 * copy is written turns "erase from every copy we hold" into "destroy one key".
 *
 * **The two-key structure.** A per-subject DEK does the sealing; the host's `SecretBox`
 * wraps the DEK for storage. So the directory holds wrapped keys, the master key lives
 * wherever the deployment's `SecretBox` is bound (Web Crypto locally, Secrets Store or a
 * KMS when hosted), and a stolen directory dump yields neither plaintext nor usable keys.
 * `SecretBox` already gives us AES-256-GCM, a fresh IV per seal, and `keyId` rotation —
 * this file adds the per-subject layer and nothing else.
 *
 * **The tombstone is the load-bearing part.** Destroying a key is only an erasure if
 * nothing mints a replacement. `destroy` keeps the row with `wrappedDek` cleared, and
 * `sealMany` refuses any subject holding one. A key store that forgets who was erased can
 * erase them exactly once, and the second export undoes the first shred.
 */

import {
  fromBase64,
  toBase64,
  webCryptoSecretBox,
  type SealedSecret,
  type SecretBox,
} from './secret-box.js';

// Web Crypto is a runtime global everywhere this runs; declared locally for the same
// reason `secret-box.ts` does it — the kernel pulls in no platform types.
declare const crypto: { getRandomValues(array: Uint8Array): Uint8Array };

/** One subject's key row, as the adapter's directory holds it. */
export interface SubjectKeyRow {
  keyId: string | null;
  wrappedDek: string | null;
  /** Non-null ⇒ tombstoned. The key is gone and no new one may be minted. */
  shreddedAt: string | null;
}

/**
 * The storage port each adapter fills with its own directory table.
 *
 * Split out so the CRYPTO lives here once and the two adapters differ only in how they
 * read and write a row — the same division `SecretBox` itself draws. Sync or async: a
 * SQLite adapter answers immediately, a Durable Object does not.
 */
export interface SubjectKeyRecords {
  read(subjectId: string): Promise<SubjectKeyRow | undefined> | SubjectKeyRow | undefined;
  insert(subjectId: string, row: { keyId: string; wrappedDek: string; createdAt: string }): Promise<void> | void;
  /** Clear the key, keep the row, stamp the time. `existed` reports whether a key was there to destroy. */
  tombstone(subjectId: string, at: string): Promise<{ existed: boolean }> | { existed: boolean };
}

export interface SubjectKeys {
  /** Positional: result `i` belongs to `items[i]`. `null` ⇒ the subject is tombstoned; refuse. */
  sealMany(
    items: readonly { subjectId: string; plaintext: string }[],
  ): Promise<(SealedSecret | null)[]>;
  /** Positional. `null` ⇒ no key (shredded, or never minted); the payload stays unreadable. */
  openMany(
    items: readonly { subjectId: string; sealed: SealedSecret }[],
  ): Promise<(string | null)[]>;
  destroy(subjectId: string, at: string): Promise<{ existed: boolean }>;
}

/**
 * The keyId written into every envelope this subject's key seals.
 *
 * Self-describing on purpose: a sealed cell sitting in a backup names the subject whose
 * key opens it, so a restore needs no side manifest to route each payload to the right
 * key. The subjectId is a ULID and already pseudonymous — it is the one identifier §5.3
 * keeps in the clear precisely so facts stay linkable after the PII is gone.
 */
const subjectKeyId = (subjectId: string): string => `subject:${subjectId}`;

export function createSubjectKeys(box: SecretBox, records: SubjectKeyRecords): SubjectKeys {
  // One unwrap per subject per call, not per row: a dump can carry thousands of events for
  // one person, and unwrapping is the expensive half.
  const openDek = async (
    cache: Map<string, SecretBox | null>,
    subjectId: string,
    mint: boolean,
  ): Promise<SecretBox | null> => {
    const hit = cache.get(subjectId);
    if (hit !== undefined) return hit;
    const row = await records.read(subjectId);
    let resolved: SecretBox | null = null;
    if (row?.shreddedAt) {
      // Tombstoned. Refused for BOTH directions, and for seal that refusal is the whole
      // point — minting here would hand a shredded subject a working key again.
      resolved = null;
    } else if (row?.wrappedDek && row.keyId) {
      const dek = await box.open({ keyId: row.keyId, ciphertext: row.wrappedDek });
      resolved = webCryptoSecretBox(subjectKeyId(subjectId), fromBase64(dek));
    } else if (mint) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const wrapped = await box.seal(toBase64(bytes));
      await records.insert(subjectId, {
        keyId: wrapped.keyId,
        wrappedDek: wrapped.ciphertext,
        createdAt: new Date().toISOString(),
      });
      resolved = webCryptoSecretBox(subjectKeyId(subjectId), bytes);
    }
    cache.set(subjectId, resolved);
    return resolved;
  };

  return {
    async sealMany(items) {
      const cache = new Map<string, SecretBox | null>();
      const out: (SealedSecret | null)[] = [];
      for (const item of items) {
        const dek = await openDek(cache, item.subjectId, true);
        out.push(dek ? await dek.seal(item.plaintext) : null);
      }
      return out;
    },
    async openMany(items) {
      const cache = new Map<string, SecretBox | null>();
      const out: (string | null)[] = [];
      for (const item of items) {
        // `mint: false` — opening never creates. A missing key means the payload is
        // unreadable, which after a shred is the correct and permanent answer.
        const dek = await openDek(cache, item.subjectId, false);
        if (!dek) {
          out.push(null);
          continue;
        }
        try {
          out.push(await dek.open(item.sealed));
        } catch {
          // Sealed by a key this store cannot open — a rotated master key, or a dump from
          // a different deployment. Reported as unreadable rather than thrown: one bad
          // cell must not abort the restore of a whole scope.
          out.push(null);
        }
      }
      return out;
    },
    async destroy(subjectId, at) {
      return records.tombstone(subjectId, at);
    },
  };
}
