/**
 * SharePoint's QuickXorHash (`file.hashes.quickXorHash` on a business drive item), so a write can
 * tell "the file its own lost upload left" from "a different file under the same name" (#2101).
 *
 * The algorithm, as Microsoft specifies it: a 160-bit register, and byte `i` of the input XORed in
 * at bit `11·i mod 160`, wrapping round the register; then the input's length as a little-endian
 * 64-bit integer XORed into the register's last eight bytes; base64 of the 20 bytes. Bytes whose
 * index agrees mod 160 land at the same offset, so they are folded together first and the register
 * is touched 160 times however long the input is.
 */
const WIDTH = 160;
const SHIFT = 11;

/**
 * The hash over bytes that arrive in pieces (#2514): each piece is folded in at its offset in the
 * whole, so a stream is hashed as it passes and never held. 160 bytes of state, whatever the length.
 */
export class QuickXorHash {
  private readonly folded = new Uint8Array(WIDTH);
  private length = 0;

  update(bytes: Uint8Array): void {
    const start = this.length % WIDTH;
    for (let i = 0; i < bytes.length; i += 1) this.folded[(start + i) % WIDTH]! ^= bytes[i]!;
    this.length += bytes.length;
  }

  digest(): string {
    const register = new Uint8Array(WIDTH / 8);
    for (let k = 0; k < WIDTH; k += 1) {
      const v = this.folded[k]!;
      if (!v) continue;
      const bit = (SHIFT * k) % WIDTH;
      const at = bit >> 3;
      const off = bit & 7;
      register[at]! ^= (v << off) & 0xff;
      if (off) register[(at + 1) % register.length]! ^= v >> (8 - off);
    }
    // The length, little-endian, into the last eight bytes — by division, since a length past 2^32
    // does not survive a 32-bit shift.
    let length = this.length;
    for (let i = 0; i < 8; i += 1) {
      register[register.length - 8 + i]! ^= length % 256;
      length = Math.floor(length / 256);
    }
    let binary = '';
    for (const b of register) binary += String.fromCharCode(b);
    return btoa(binary);
  }
}

export function quickXorHash(bytes: Uint8Array): string {
  const hash = new QuickXorHash();
  hash.update(bytes);
  return hash.digest();
}
