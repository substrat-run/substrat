/**
 * `substrat store-driver upload | rollout | rollback | status --kind <kind>` (D-63, #2300). Staff
 * only, and a write must be made from a person's sign-in (`substrat login`): the control plane
 * refuses the service token.
 *
 * - `upload` packs the kind's package from `--dir` and stores it. The control plane names the
 *   release by its sha256 and says whether this repo pins it yet; bytes may go up first.
 * - `rollout --sha256` moves every vertical to a stored, pinned release, after a canary. A big
 *   fleet takes more than one request: the command says so, and running it again continues.
 * - `rollback` returns the kind to the immediately previous good release.
 *
 * What is packed is the kind's own package only: every `kind_<name>/…/*.py` under `--dir`, by
 * its path relative to it. `__pycache__` is skipped. Anything else is refused by name, vendored
 * packages included: a release is one `kind_` package (the platform's module rule), so a kind
 * that needs a third-party package cannot be published yet.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { STORE_RELEASE_MAX_BYTES, type StoreDriverReleaseUpload } from '@substrat-run/contracts';
import type { StoreDriverView } from '@substrat-run/control-plane-client';
import { planeFor } from './plane.js';

const KIND_MODULE = /^kind_[a-z0-9_]+\/(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*\.py$/;

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** How deep, and how many files, a kind's package may go: past either it is not one package. */
const MAX_DEPTH = 16;
const MAX_FILES = 2000;

/**
 * Every file under `dir`, by its path relative to it, `__pycache__` and `.pyc` left out. A symbolic
 * link is refused, not followed: it could pack a file from outside `dir`, or loop forever.
 */
export function packedFilesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error(`'${relative(dir, at)}' is nested more than ${MAX_DEPTH} directories deep`);
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`'${relative(dir, path)}' is a symbolic link; a release packs files, not links`);
      if (stat.isDirectory()) {
        if (name !== '__pycache__') walk(path, depth + 1);
      } else if (!name.endsWith('.pyc')) {
        out.push(relative(dir, path).split(sep).join('/'));
        if (out.length > MAX_FILES) throw new Error(`'${dir}' holds more than ${MAX_FILES} files`);
      }
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * The commit `dir` is checked out at, for the files about to be packed. Refused unless every one
 * of them is tracked and unchanged there: an untracked, ignored or edited file is not that
 * commit, so the bundle would carry bytes the commit a reviewer reads does not.
 */
export function sourceCommitOf(dir: string, files: readonly string[]): string {
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0) throw new Error(`'${dir}' is not in a git checkout; pass --commit <sha>`);
  const tracked = git('ls-files', '-z', '--', '.');
  if (tracked.status !== 0) throw new Error(`git ls-files failed in '${dir}'`);
  const known = new Set(tracked.stdout.split('\0').filter(Boolean));
  const untracked = files.filter((file) => !known.has(file));
  if (untracked.length > 0) {
    throw new Error(`${untracked.join(', ')} ${untracked.length === 1 ? 'is' : 'are'} not committed (untracked or ignored), so the bundle is not commit ${head.stdout.trim()}`);
  }
  const dirty = git('status', '--porcelain', '--', '.');
  if (dirty.status !== 0 || dirty.stdout.trim() !== '') {
    throw new Error(`'${dir}' has uncommitted changes, so the bundle is not commit ${head.stdout.trim()}; commit them, or pass --commit`);
  }
  return head.stdout.trim();
}

/** The kind's package under `dir`, as the upload body. `entry` is the module with the class. */
export function packStoreDriverDir(dir: string, entry: string, sourceCommit: string): StoreDriverReleaseUpload {
  const files = packedFilesOf(dir);
  const refused = files.filter((path) => !KIND_MODULE.test(path));
  if (refused.length > 0) {
    throw new Error(
      `only the kind's own package is published (kind_<name>/…/*.py); refused: ${refused.join(', ')}. ` +
        'Vendored packages are not supported: a release is one kind_ package.',
    );
  }
  const packages = new Set(files.map((path) => path.split('/')[0]));
  if (packages.size !== 1) throw new Error(`'${dir}' must hold exactly one kind_ package, not ${[...packages].join(', ') || 'none'}`);
  if (!files.includes(entry)) throw new Error(`'${dir}' has no ${entry}`);
  let total = 0;
  const modules = files.map((name) => {
    const content = readFileSync(join(dir, name));
    total += content.byteLength;
    return { name, contentBase64: base64(content) };
  });
  if (total > STORE_RELEASE_MAX_BYTES) throw new Error(`the package is ${total} bytes; a release carries at most ${STORE_RELEASE_MAX_BYTES}`);
  return { sourceCommit, entry, modules };
}

/** A release is named by its sha256 as `upload` printed it; anything else is refused before a request. */
export const isReleaseSha = (value: string | undefined): value is string => value !== undefined && /^[0-9a-f]{64}$/.test(value);

type Plane = { controlPlaneUrl: string; header: Record<string, string> };

export const uploadStoreDriverRelease = (input: Plane & { kind: string; body: StoreDriverReleaseUpload }) =>
  planeFor(input.controlPlaneUrl, input.header).uploadStoreDriverRelease(input.kind, input.body);

export const rollOutStoreDriver = (input: Plane & { kind: string; sha256: string }) =>
  planeFor(input.controlPlaneUrl, input.header).rollOutStoreDriver(input.kind, input.sha256);

export const rollBackStoreDriver = (input: Plane & { kind: string }) =>
  planeFor(input.controlPlaneUrl, input.header).rollBackStoreDriver(input.kind);

export const storeDriverStatus = (input: Plane & { kind: string }) =>
  planeFor(input.controlPlaneUrl, input.header).getStoreDriver(input.kind);

/**
 * What `store-driver status` prints. "Rolls back to" is the server's `rollbackTarget`, never the
 * current release's previous good one: after a diverged or paused rollout it is the current
 * release, and a rollback still under way continues to its own target.
 */
export function storeDriverStatusLines(kind: string, view: StoreDriverView): string[] {
  return [
    `${kind}: current ${view.current?.sha256 ?? 'none'}, rolls back to ${view.rollbackTarget ?? 'nothing'}`,
    ...(view.unfinishedRollback
      ? [`  a rollback to ${view.unfinishedRollback} stopped part way: run \`substrat store-driver rollback\` again to finish it`]
      : []),
    ...view.rollouts.slice(-10).map((r) => `  #${r.seq} ${r.action} ${r.sha256} ${r.state}${r.detail ? ` — ${r.detail}` : ''}`),
  ];
}
