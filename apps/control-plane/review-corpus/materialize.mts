/**
 * A seed made real: its base files read from the pinned commit, its patch applied, and both
 * packed as the review archives the CLI uploads, so the corpus is read through the same diff the
 * hosted job takes (`diffReview`). Needs the repository's history, which CI's checks job has.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffReview, type ArchiveSource, type ReviewDiff } from '../src/review-diff.js';
import { tar } from '../test/review-fixtures.js';
import type { Seed } from './corpus.mts';

/**
 * The archive walker hashes as it reads, through the runtime's own streaming SHA-256 (workerd's
 * `crypto.DigestStream`, found by the kernel's `runtimeSha256`). Node has none, so the corpus,
 * which runs under Node, supplies one over Node's own `createHash`.
 */
const webCrypto = globalThis.crypto as Crypto & { DigestStream?: unknown };
webCrypto.DigestStream ??= class NodeDigestStream {
  readonly digest: Promise<ArrayBuffer>;
  readonly #hash = createHash('sha256');
  #done!: (digest: ArrayBuffer) => void;
  constructor(algorithm: string) {
    if (algorithm !== 'SHA-256') throw new Error(`unsupported digest ${algorithm}`);
    this.digest = new Promise((resolve) => { this.#done = resolve; });
  }
  getWriter() {
    return {
      write: async (chunk: Uint8Array) => { this.#hash.update(chunk); },
      close: async () => { this.#done(new Uint8Array(this.#hash.digest()).buffer); },
    };
  }
};

export const CORPUS_DIR = dirname(fileURLToPath(import.meta.url));
export const SEEDS_DIR = join(CORPUS_DIR, 'seeds');
const REPO_ROOT = join(CORPUS_DIR, '..', '..', '..');

export interface SeedTree {
  readonly base: ReadonlyMap<string, string>;
  readonly head: ReadonlyMap<string, string>;
}

function walk(dir: string, root = dir, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out.set(relative(root, path), readFileSync(path, 'utf8'));
  }
  return out;
}

/** The seed's files before and after its change. Throws when the commit is absent or the patch does not apply. */
export function materialize(seed: Seed): SeedTree {
  const base = new Map(seed.base.files.map((file) => [
    file,
    execFileSync('git', ['show', `${seed.base.commit}:${seed.base.root}/${file}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 << 20 }),
  ]));
  const work = mkdtempSync(join(tmpdir(), `review-corpus-${seed.id}-`));
  try {
    for (const [file, text] of base) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), text);
    }
    // Outside any repository, `git apply` is a plain patch tool; `-p1` strips the patch's `a/` and `b/`.
    execFileSync('git', ['apply', '-p1', '--whitespace=nowarn', join(SEEDS_DIR, seed.id, 'change.patch')], { cwd: work, stdio: ['ignore', 'ignore', 'pipe'] });
    return { base, head: walk(work) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function source(files: ReadonlyMap<string, string>): Promise<ArchiveSource> {
  const raw = tar([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text) })));
  const gz = new Uint8Array(await new Response(new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', gz))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { open: async () => new Blob([gz]).stream(), size: gz.byteLength, sha256 };
}

/** The diff the hosted job would send for this seed, under its default budgets. */
export async function seedDiff(tree: SeedTree): Promise<ReviewDiff> {
  return diffReview({ source: await source(tree.head), base: await source(tree.base) });
}
