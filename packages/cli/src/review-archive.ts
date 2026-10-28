import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const BLOCK = 512;
const MAX_COMPRESSED = 32 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

function git(args: string[], cwd: string, input?: Buffer): Buffer {
  return execFileSync('git', args, { cwd, input, maxBuffer: MAX_EXPANDED + 1024 * 1024 });
}

function putText(block: Uint8Array, at: number, size: number, value: string): void {
  const bytes = Buffer.from(value);
  if (bytes.length > size) throw new Error('archive path is too long for USTAR');
  block.set(bytes, at);
}

function putOctal(block: Uint8Array, at: number, size: number, value: number): void {
  const digits = value.toString(8).padStart(size - 1, '0');
  if (digits.length !== size - 1) throw new Error('archive number is too large');
  putText(block, at, size, digits);
}

function pathFields(path: string): { name: string; prefix: string } {
  if (!/^[\x20-\x7e]+$/.test(path) || path.includes('\\') || path.startsWith('/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('archive path is not a portable relative path');
  }
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  const slash = path.lastIndexOf('/');
  if (slash < 0 || slash > 155 || path.length - slash - 1 > 100) {
    throw new Error('archive path is too long for USTAR');
  }
  return { prefix: path.slice(0, slash), name: path.slice(slash + 1) };
}

function header(path: string, mode: number, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const fields = pathFields(path);
  putText(block, 0, 100, fields.name);
  putOctal(block, 100, 8, mode);
  putOctal(block, 108, 8, 0);
  putOctal(block, 116, 8, 0);
  putOctal(block, 124, 12, size);
  putOctal(block, 136, 12, 0);
  block.fill(32, 148, 156);
  block[156] = 48; // regular file
  putText(block, 257, 6, 'ustar');
  putText(block, 263, 2, '00');
  putText(block, 345, 155, fields.prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  putText(block, 148, 6, sum.toString(8).padStart(6, '0'));
  block[154] = 0;
  block[155] = 32;
  return block;
}

/** The committed tree as canonical USTAR + gzip, independent of git archive's PAX header. */
export function reviewArchive(cwd: string, ref: string): { bytes: Uint8Array; sha256: string } {
  const rows = git(['ls-tree', '-r', '-z', ref], cwd).toString('utf8').split('\0').filter(Boolean);
  if (rows.length === 0 || rows.length > MAX_ENTRIES) throw new Error('archive entry count is out of bounds');
  const files = rows.map((row) => {
    const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/.exec(row);
    if (!match) throw new Error('review tree contains a link, submodule or unsupported entry');
    return { mode: match[1] === '100755' ? 0o755 : 0o644, oid: match[2]!, path: match[3]! };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const seen = new Set<string>();
  for (const file of files) {
    pathFields(file.path);
    const folded = file.path.normalize('NFC').toLowerCase();
    if (seen.has(folded)) throw new Error('review tree has colliding paths');
    seen.add(folded);
  }
  const input = Buffer.from(files.map((file) => `${file.oid}\n`).join(''));
  const batch = git(['cat-file', '--batch'], cwd, input);
  let at = 0;
  let expanded = 2 * BLOCK;
  const blocks: Uint8Array[] = [];
  for (const file of files) {
    const newline = batch.indexOf(10, at);
    if (newline < 0) throw new Error('git object batch is incomplete');
    const line = batch.toString('ascii', at, newline);
    const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(line);
    if (!match || match[1] !== file.oid) throw new Error('git object batch differs from tree');
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > MAX_FILE) throw new Error('review file exceeds the size limit');
    at = newline + 1;
    const content = batch.subarray(at, at + size);
    if (content.byteLength !== size || batch[at + size] !== 10) throw new Error('git object batch is truncated');
    at += size + 1;
    expanded += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (expanded > MAX_EXPANDED) throw new Error('review tree exceeds the expanded size limit');
    blocks.push(header(file.path, file.mode, size), content);
    if (size % BLOCK) blocks.push(new Uint8Array(BLOCK - size % BLOCK));
  }
  blocks.push(new Uint8Array(2 * BLOCK));
  const compressed = gzipSync(Buffer.concat(blocks), { level: 9 });
  if (compressed.byteLength > MAX_COMPRESSED) throw new Error('review archive exceeds the compressed size limit');
  return { bytes: compressed, sha256: createHash('sha256').update(compressed).digest('hex') };
}

/** A staff branch review only describes the committed source. */
export function assertCleanReviewTree(cwd: string): void {
  if (git(['status', '--porcelain', '--untracked-files=all'], cwd).byteLength) {
    throw new Error('commit the branch before uploading it for review');
  }
}
