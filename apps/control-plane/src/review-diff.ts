import { walkReviewArchive } from './review-archive.js';

/** The reader half's default budget for what it sends: the whole new text of each changed file. */
export const REVIEW_MAX_DIFF_BYTES = 256 * 1024;
/** One file over this is never sent, whatever the budget left. */
export const REVIEW_SENT_FILE_MAX_BYTES = 64 * 1024;
/** Binary means a NUL in this prefix, or text that is not UTF-8. */
const BINARY_PROBE_BYTES = 8 * 1024;

/** Why a changed file was not sent (Q3c B: the platform's own exclusions, each recorded). */
export type NotSentRule = 'lockfile' | 'generated' | 'emitted artifact' | 'binary' | 'file too large';

export interface ChangedFile {
  readonly path: string;
  readonly text: string;
}

export type ReviewDiff =
  | {
      readonly kind: 'diff';
      readonly files: readonly ChangedFile[];
      readonly deleted: readonly string[];
      readonly notSent: ReadonlyArray<{ readonly path: string; readonly rule: NotSentRule }>;
      readonly bytes: number;
      readonly fullTree: boolean;
    }
  | { readonly kind: 'too large'; readonly bytes: number; readonly limit: number };

const LOCKFILES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'composer.lock', 'go.sum', 'uv.lock',
]);
const EMITTED = new Set(['model.json', 'openapi.json', 'PERMISSIONS.md', 'MIGRATIONS.md']);

/** The platform exclusion a path falls under by name alone, or null. */
export function excludedByName(path: string): NotSentRule | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (LOCKFILES.has(name)) return 'lockfile';
  if (/\.generated\./.test(name)) return 'generated';
  if (EMITTED.has(name)) return 'emitted artifact';
  return null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The file's text, or null when it is binary. */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class OverBudget extends Error {}

export interface ArchiveSource {
  stream(): ReadableStream<Uint8Array>;
  readonly size: number;
}

/**
 * What changed between two stored archives, streamed and capped. Pass 1 hashes the base (a file
 * over the per-file limit is remembered by size alone, since it is never sent); pass 2 walks the
 * source and keeps each new or changed text file under the budget. No base is a full-tree review
 * under the same budget. Over the budget the walk stops: nothing is sent and the size so far is
 * reported, which is a lower bound.
 */
export async function diffReview(
  input: { source: ArchiveSource; base: ArchiveSource | null },
  limits: { maxDiffBytes?: number; maxFileBytes?: number } = {},
): Promise<ReviewDiff> {
  const maxDiffBytes = limits.maxDiffBytes ?? REVIEW_MAX_DIFF_BYTES;
  const maxFileBytes = limits.maxFileBytes ?? REVIEW_SENT_FILE_MAX_BYTES;
  const baseFiles = new Map<string, string>();
  if (input.base) {
    await walkReviewArchive({ stream: input.base.stream(), size: input.base.size }, async (path, size, read) => {
      baseFiles.set(path, size > maxFileBytes ? `size:${size}` : await sha256Hex(await read()));
    });
  }
  const files: ChangedFile[] = [];
  const notSent: Array<{ path: string; rule: NotSentRule }> = [];
  const seen = new Set<string>();
  let bytes = 0;
  try {
    await walkReviewArchive({ stream: input.source.stream(), size: input.source.size }, async (path, size, read) => {
      seen.add(path);
      const before = baseFiles.get(path);
      if (size > maxFileBytes) {
        if (before !== `size:${size}`) notSent.push({ path, rule: 'file too large' });
        return;
      }
      const content = await read();
      if (before !== undefined && before === await sha256Hex(content)) return;
      const named = excludedByName(path);
      if (named) {
        notSent.push({ path, rule: named });
        return;
      }
      const text = textOf(content);
      if (text === null) {
        notSent.push({ path, rule: 'binary' });
        return;
      }
      bytes += content.byteLength;
      if (bytes > maxDiffBytes) throw new OverBudget();
      files.push({ path, text });
    });
  } catch (error) {
    if (error instanceof OverBudget) return { kind: 'too large', bytes, limit: maxDiffBytes };
    throw error;
  }
  const deleted = [...baseFiles.keys()].filter((path) => !seen.has(path)).sort();
  return { kind: 'diff', files, deleted, notSent, bytes, fullTree: input.base === null };
}
