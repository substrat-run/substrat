import { runtimeSha256, witnessedStream } from '@substrat-run/kernel';

export const REVIEW_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
export const REVIEW_TREE_MAX_BYTES = 128 * 1024 * 1024;
export const REVIEW_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const REVIEW_ENTRY_MAX = 10_000;

const BLOCK = 512;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function field(block: Uint8Array, at: number, length: number): string {
  const bytes = block.subarray(at, at + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function octal(block: Uint8Array, at: number, length: number): number {
  const value = field(block, at, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('invalid tar number');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error('tar number is too large');
  return number;
}

function archivePath(path: string, seen: Set<string>): void {
  const checked = path.endsWith('/') ? path.slice(0, -1) : path;
  // This first intake accepts the portable USTAR name set. It can be widened with a
  // reviewed format change when the controlled builder has an input contract.
  if (!/^[\x20-\x7e]+$/.test(checked) || checked.includes('\\') || checked.startsWith('/') ||
      checked.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('archive path is not a portable relative path');
  }
  const folded = checked.normalize('NFC').toLowerCase();
  if (seen.has(folded)) throw new Error('archive paths collide');
  seen.add(folded);
}

/** Read a gzip/USTAR archive as data. No file is ever extracted or executed. */
export async function validateReviewArchive(file: File, expectedSha256: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('archive digest must be a full SHA-256');
  if (file.size === 0 || file.size > REVIEW_ARCHIVE_MAX_BYTES) throw new Error('archive exceeds the compressed size limit');
  const makeDigest = runtimeSha256();
  if (!makeDigest) throw new Error('streaming SHA-256 is unavailable');
  const witnessed = witnessedStream({ stream: file.stream(), length: file.size }, makeDigest());
  const inflated = (witnessed.body.stream as ReadableStream<Uint8Array>).pipeThrough(new DecompressionStream('gzip'));
  const reader = inflated.getReader();
  let pending = new Uint8Array(0);
  let expanded = 0;
  const pull = async (): Promise<boolean> => {
    const next = await reader.read();
    if (next.done) return false;
    expanded += next.value.byteLength;
    if (expanded > REVIEW_TREE_MAX_BYTES) throw new Error('archive exceeds the expanded size limit');
    const joined = new Uint8Array(pending.byteLength + next.value.byteLength);
    joined.set(pending);
    joined.set(next.value, pending.byteLength);
    pending = joined;
    return true;
  };
  const read = async (length: number): Promise<Uint8Array> => {
    while (pending.byteLength < length) {
      if (!(await pull())) throw new Error('archive is truncated');
    }
    const out = pending.subarray(0, length);
    pending = pending.slice(length);
    return out;
  };
  const discard = async (length: number): Promise<void> => {
    let left = length;
    while (left > 0) {
      if (pending.byteLength === 0 && !(await pull())) throw new Error('archive is truncated');
      const n = Math.min(left, pending.byteLength);
      pending = pending.slice(n);
      left -= n;
    }
  };
  const seen = new Set<string>();
  let entries = 0;
  let ended = false;
  try {
    for (;;) {
      const block = await read(BLOCK);
      if (block.every((byte) => byte === 0)) {
        const second = await read(BLOCK);
        if (!second.every((byte) => byte === 0)) throw new Error('archive has one end block');
        ended = true;
        break;
      }
      if (field(block, 257, 6) !== 'ustar') throw new Error('archive is not USTAR');
      const recorded = octal(block, 148, 8);
      let checksum = 0;
      for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : block[i]!;
      if (recorded !== checksum) throw new Error('archive header checksum differs');
      const size = octal(block, 124, 12);
      const mode = octal(block, 100, 8);
      if ((mode & ~0o777) !== 0) throw new Error('archive has special mode bits');
      const type = block[156];
      if (type !== 0 && type !== 48 && type !== 53) throw new Error('archive has a link or special entry');
      if (type === 53 && size !== 0) throw new Error('archive directory carries data');
      if (type !== 53 && size > REVIEW_FILE_MAX_BYTES) throw new Error('archive file exceeds the size limit');
      const name = field(block, 0, 100);
      const prefix = field(block, 345, 155);
      archivePath(prefix ? `${prefix}/${name}` : name, seen);
      if (++entries > REVIEW_ENTRY_MAX) throw new Error('archive has too many entries');
      await discard(Math.ceil(size / BLOCK) * BLOCK);
    }
    if (pending.some((byte) => byte !== 0)) throw new Error('archive has data after its end');
    pending = new Uint8Array(0);
    // Only zero padding may follow USTAR's two end blocks. Drain so the
    // compressed digest witnesses the complete upload, not just its prefix.
    for (;;) {
      const tail = await reader.read();
      if (tail.done) break;
      expanded += tail.value.byteLength;
      if (expanded > REVIEW_TREE_MAX_BYTES) throw new Error('archive exceeds the expanded size limit');
      if (tail.value.some((byte) => byte !== 0)) throw new Error('archive has data after its end');
    }
    if (!ended || entries === 0) throw new Error('archive has no files');
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (witnessed.witness().sha256 !== expectedSha256) throw new Error('archive digest differs');
}
