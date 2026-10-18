/**
 * `substrat store-driver upload | rollout | rollback | status --driver <driver>` (D-63, #2300). Staff
 * only, and a write must be made from a person's sign-in (`substrat login`): the control plane
 * refuses the service token.
 *
 * - `upload` packs the driver's package from `--dir` and stores it. The control plane names the
 *   release by its sha256 and says whether this repo pins it yet; bytes may go up first.
 * - `rollout --sha256` moves every vertical to a stored, pinned release, after a canary. A big
 *   fleet takes more than one request: the command says so, and running it again continues.
 * - `rollback` returns the driver to the immediately previous good release.
 *
 * What is packed is the driver's own package, every `driver_<name>/…/*.py` under `--dir`, and a
 * `python_modules/` directory next to it (#2390). Paths are relative to `--dir`. `__pycache__`
 * is skipped, and so are the two markers `pywrangler sync` writes into `python_modules/`
 * (`.synced` and `pyvenv.cfg`), which the output names. Anything else is refused by the same
 * module rule the upload applies: one `driver_` package, and vendored paths that do not shadow
 * the runtime or the entry. The workers runtime SDK a sync installs is refused, not dropped.
 *
 * What vouches for what (D-63): the source commit vouches for the driver package and for the
 * pyproject/lock its dependencies were installed from. `python_modules/` is install output, which
 * git normally ignores, so it is not held to the commit; its bytes are vouched for by the release
 * sha256 alone, which covers every vendored name and byte. The output says so for every release
 * that carries one, pinned or not.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { classifyPythonStoreModule, STORE_RELEASE_MAX_BYTES, STORE_RELEASE_MAX_MODULES, type StoreDriverReleaseUpload } from '@substrat-run/contracts';
import type { StoreDriverRebuildView, StoreDriverView } from '@substrat-run/control-plane-client';
import { planeFor } from './plane.js';

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** How deep a driver's tree may go: past it, it is not one package. How many files is the release's own limit. */
const MAX_DEPTH = 16;

/** Where a release's dependencies are, under `--dir`: the one directory the commit does not vouch for. */
const VENDORED_DIR = 'python_modules';

/**
 * The markers `pywrangler sync` writes into `python_modules/` beside what it installs: install
 * output, not a dependency. The walk skips exactly these; the upload still refuses them by name.
 */
export const INSTALLER_MARKERS: readonly string[] = [`${VENDORED_DIR}/.synced`, `${VENDORED_DIR}/pyvenv.cfg`];

const isVendored = (file: string) => file.startsWith(`${VENDORED_DIR}/`);

/**
 * Every file under `dir`, by its path relative to it, `__pycache__`, `.pyc` and the
 * {@link INSTALLER_MARKERS} left out. A symbolic link is refused, not followed: it could pack a
 * file from outside `dir`, or loop forever.
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
        const file = relative(dir, path).split(sep).join('/');
        if (INSTALLER_MARKERS.includes(file)) continue;
        out.push(file);
        if (out.length > STORE_RELEASE_MAX_MODULES) {
          throw new Error(`'${dir}' holds more than ${STORE_RELEASE_MAX_MODULES} files; a release carries at most ${STORE_RELEASE_MAX_MODULES} modules`);
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** The {@link INSTALLER_MARKERS} present under `dir`: what the walk skipped. */
export const skippedInstallerMarkersOf = (dir: string): string[] => INSTALLER_MARKERS.filter((file) => existsSync(join(dir, file)));

/**
 * The commit `dir` is checked out at, for the driver's files about to be packed. Refused unless
 * every one of them is tracked and unchanged there, and nothing else under `dir` but
 * `python_modules/` is changed or deleted: an untracked, ignored or edited file is not that
 * commit, so the bundle would carry bytes the commit a reviewer reads does not. `python_modules/`
 * is held to neither check: it is install output, and the release sha256 vouches for its bytes.
 */
export function sourceCommitOf(dir: string, files: readonly string[]): string {
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0) throw new Error(`'${dir}' is not in a git checkout; pass --commit <sha>`);
  const tracked = git('ls-files', '-z', '--', '.');
  if (tracked.status !== 0) throw new Error(`git ls-files failed in '${dir}'`);
  const known = new Set(tracked.stdout.split('\0').filter(Boolean));
  const untracked = files.filter((file) => !isVendored(file) && !known.has(file));
  if (untracked.length > 0) {
    throw new Error(`${untracked.join(', ')} ${untracked.length === 1 ? 'is' : 'are'} not committed (untracked or ignored), so the bundle is not commit ${head.stdout.trim()}`);
  }
  const dirty = git('status', '--porcelain', '--', '.', `:(exclude)${VENDORED_DIR}`);
  if (dirty.status !== 0 || dirty.stdout.trim() !== '') {
    throw new Error(`'${dir}' has uncommitted changes, so the bundle is not commit ${head.stdout.trim()}; commit them, or pass --commit`);
  }
  return head.stdout.trim();
}

/** The driver's package under `dir`, as the upload body. `entry` is the module with the class. */
export function packStoreDriverDir(dir: string, entry: string, sourceCommit: string): StoreDriverReleaseUpload {
  const files = packedFilesOf(dir);
  const packages = new Set<string>();
  const classes = new Map(files.map((path) => [path, classifyPythonStoreModule(path)] as const));
  for (const classified of classes.values()) if (classified.kind === 'driver') packages.add(classified.packageName);
  if (packages.size !== 1) throw new Error(`'${dir}' must hold exactly one driver_ package, not ${[...packages].join(', ') || 'none'}`);
  const entryClass = classes.get(entry);
  if (!entryClass) throw new Error(`'${dir}' has no ${entry}`);
  if (entryClass.kind !== 'driver') throw new Error(`'${entry}' is not a driver module`);
  let total = 0;
  const modules = files.map((name) => {
    const content = readFileSync(join(dir, name));
    total += content.byteLength;
    return { name, contentBase64: base64(content) };
  });
  if (total > STORE_RELEASE_MAX_BYTES) throw new Error(`the package is ${total} bytes; a release carries at most ${STORE_RELEASE_MAX_BYTES}`);
  return { sourceCommit, entry, modules };
}

/**
 * What `upload` says about what vouches for the release it stored, beyond its sha256 and commit:
 * the installer markers the walk skipped, and, when it carries `python_modules/`, that those bytes
 * are vouched for by the sha256 only. Said for every such release, whether it is pinned yet or not.
 */
export function storeDriverPackLines(input: { files: readonly string[]; skipped: readonly string[]; sha256: string; sourceCommit: string }): string[] {
  const lines = input.skipped.length > 0 ? [`  skipped the installer's markers: ${input.skipped.join(', ')}`] : [];
  const vendored = input.files.filter(isVendored).length;
  if (vendored > 0) {
    lines.push(
      `  ${VENDORED_DIR}/: ${vendored} file(s) vouched for by sha256 ${input.sha256} only, not by commit ${input.sourceCommit}; ` +
        'the commit vouches for the driver package and the pyproject/lock it was installed from',
    );
  }
  return lines;
}

/** A release is named by its sha256 as `upload` printed it; anything else is refused before a request. */
export const isReleaseSha = (value: string | undefined): value is string => value !== undefined && /^[0-9a-f]{64}$/.test(value);

type Plane = { controlPlaneUrl: string; header: Record<string, string> };

export const uploadStoreDriverRelease = (input: Plane & { driver: string; body: StoreDriverReleaseUpload }) =>
  planeFor(input.controlPlaneUrl, input.header).uploadStoreDriverRelease(input.driver, input.body);

export const rollOutStoreDriver = (input: Plane & { driver: string; sha256: string }) =>
  planeFor(input.controlPlaneUrl, input.header).rollOutStoreDriver(input.driver, input.sha256);

export const rollBackStoreDriver = (input: Plane & { driver: string }) =>
  planeFor(input.controlPlaneUrl, input.header).rollBackStoreDriver(input.driver);

export const storeDriverStatus = (input: Plane & { driver: string }) =>
  planeFor(input.controlPlaneUrl, input.header).getStoreDriver(input.driver);

export const rebuildStoreDriver = (input: Plane & { driver: string; deployFinished?: boolean }) =>
  planeFor(input.controlPlaneUrl, input.header).rebuildStoreDriver(input.driver, { deployFinished: input.deployFinished === true });

/**
 * Whether every script of the driver is built from what the control plane builds from now (#2309).
 * An old key is revoked only once this reads `current`: until then a script on the list below may
 * still accept it.
 */
export function storeDriverRebuildLines(rebuild: StoreDriverRebuildView): string[] {
  const walk = rebuild.walk;
  // Why it reads as it does: when these lists were first walked towards, and when the next automatic walk is.
  const timing = walk && walk.fingerprint === rebuild.fingerprint
    ? [`    first walked towards ${walk.fingerprintSince}${rebuild.nextWalk ? `; next automatic re-walk ${rebuild.nextWalk}` : ''}`]
    : [];
  if (rebuild.current && rebuild.reverifying) {
    return [`  scripts: current (re-verifying: a walk since ${walk?.startedAt} re-checks every script; last proved ${walk?.verifiedAt})`, ...timing];
  }
  if (rebuild.current) {
    const by = walk?.attestedBy ? `, deploy attested finished by ${walk.attestedBy}` : '';
    return [`  scripts: current (every script is built from ${rebuild.fingerprint.slice(0, 12)}, walk finished ${walk?.finishedAt}${by})`, ...timing];
  }
  if (rebuild.settling) {
    return [
      `  scripts: settling: every script was current when walked (${walk?.finishedAt ?? 'just now'}), but the control plane's deploy may still`,
      `    have been rolling out then. It is walked again from ${rebuild.settling}; once the deploy serves only the new version,`,
      `    \`substrat store-driver rebuild --driver <driver> --deploy-finished\` walks it at once and attests that.`,
      ...timing,
    ];
  }
  const shown = rebuild.pending.slice(0, 10);
  return [
    `  scripts: NOT current: ${rebuild.pending.length} may still be built from older keys or code (target ${rebuild.fingerprint.slice(0, 12)})`,
    ...(shown.length ? [`    pending: ${shown.join(', ')}${rebuild.pending.length > shown.length ? `, … ${rebuild.pending.length - shown.length} more` : ''}`] : []),
    ...(walk?.failures ?? []).slice(0, 10).map((f) => `    failed: ${f.vertical}: ${f.detail}`),
    ...timing,
  ];
}

/**
 * What `store-driver status` prints. "Rolls back to" is the server's `rollbackTarget`, never the
 * current release's previous good one: after a diverged or paused rollout it is the current
 * release, and a rollback still under way continues to its own target.
 */
export function storeDriverStatusLines(driver: string, view: StoreDriverView): string[] {
  return [
    `${driver}: current ${view.current?.sha256 ?? 'none'}, rolls back to ${view.rollbackTarget ?? 'nothing'}`,
    ...(view.unfinishedRollback
      ? [`  a rollback to ${view.unfinishedRollback} stopped part way: run \`substrat store-driver rollback\` again to finish it`]
      : []),
    ...view.rollouts.slice(-10).map((r) => `  #${r.seq} ${r.action} ${r.sha256} ${r.state}${r.detail ? ` — ${r.detail}` : ''}`),
    ...(view.rebuild ? storeDriverRebuildLines(view.rebuild) : []),
  ];
}
