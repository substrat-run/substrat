import { describe, expect, it } from 'vitest';
import { quickXorHash } from '../src/quickxor.js';

/**
 * QuickXorHash against a second implementation written the way Microsoft's reference is: three
 * 64-bit cells, a running shift, and input fed in several calls. The connector's version folds
 * bytes by index and touches the register 160 times; agreeing on random inputs of every length
 * class — under, at and over 160 bytes, fed whole and in pieces — is what this proves. Agreement
 * with SharePoint itself is the live-tenant check.
 */
function reference() {
  const WIDTH = 160;
  const SHIFT = 11;
  const MASK = (1n << 64n) - 1n;
  const data = [0n, 0n, 0n];
  let shiftSoFar = 0;
  let lengthSoFar = 0n;
  return {
    update(array: Uint8Array) {
      const cbSize = array.length;
      let vectorArrayIndex = Math.floor(shiftSoFar / 64);
      let vectorOffset = shiftSoFar % 64;
      const iterations = Math.min(cbSize, WIDTH);
      for (let i = 0; i < iterations; i += 1) {
        const isLastCell = vectorArrayIndex === data.length - 1;
        const bitsInVectorCell = isLastCell ? WIDTH % 64 : 64;
        if (vectorOffset <= bitsInVectorCell - 8) {
          for (let j = i; j < cbSize; j += WIDTH) {
            data[vectorArrayIndex] = (data[vectorArrayIndex]! ^ (BigInt(array[j]!) << BigInt(vectorOffset))) & MASK;
          }
        } else {
          const index1 = vectorArrayIndex;
          const index2 = isLastCell ? 0 : vectorArrayIndex + 1;
          const low = bitsInVectorCell - vectorOffset;
          let xored = 0;
          for (let j = i; j < cbSize; j += WIDTH) xored ^= array[j]!;
          data[index1] = (data[index1]! ^ (BigInt(xored) << BigInt(vectorOffset))) & MASK;
          data[index2] = (data[index2]! ^ (BigInt(xored) >> BigInt(low))) & MASK;
        }
        vectorOffset += SHIFT;
        while (vectorOffset >= bitsInVectorCell) {
          vectorArrayIndex = isLastCell ? 0 : vectorArrayIndex + 1;
          vectorOffset -= bitsInVectorCell;
        }
      }
      shiftSoFar = (shiftSoFar + SHIFT * (cbSize % WIDTH)) % WIDTH;
      lengthSoFar += BigInt(cbSize);
    },
    digest(): string {
      const rgb = new Uint8Array(20);
      for (let i = 0; i < data.length; i += 1) {
        for (let b = 0; b < Math.min(rgb.length - i * 8, 8); b += 1) rgb[i * 8 + b] = Number((data[i]! >> BigInt(8 * b)) & 0xffn);
      }
      for (let b = 0; b < 8; b += 1) rgb[12 + b]! ^= Number((lengthSoFar >> BigInt(8 * b)) & 0xffn);
      return Buffer.from(rgb).toString('base64');
    },
  };
}

const random = (n: number, seed: number) => {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
};

describe('quickXorHash', () => {
  it('hashes nothing to twenty zero bytes', () => {
    expect(quickXorHash(new Uint8Array())).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  });

  it.each([1, 2, 7, 8, 9, 63, 64, 65, 159, 160, 161, 319, 320, 321, 1000, 4096, 100_003])(
    'agrees with the reference for %i bytes, fed whole and in pieces',
    (n) => {
      const bytes = random(n, n + 17);
      const whole = reference();
      whole.update(bytes);
      const pieces = reference();
      for (let at = 0; at < n; at += 37) pieces.update(bytes.subarray(at, Math.min(at + 37, n)));
      expect(whole.digest()).toBe(pieces.digest());
      expect(quickXorHash(bytes)).toBe(whole.digest());
    },
  );

  it('tells two files of one size apart', () => {
    const a = random(5000, 1);
    const b = a.slice();
    b[4321]! ^= 1;
    expect(quickXorHash(a)).not.toBe(quickXorHash(b));
  });
});
