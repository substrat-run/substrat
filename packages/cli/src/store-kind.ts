/**
 * `substrat store-kind upload | rollout | rollback | status --kind <kind>` (D-63, #2300). Staff
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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { STORE_RELEASE_MAX_BYTES, type StoreKindReleaseUpload } from '@substrat-run/contracts';
import { planeFor } from './plane.js';

const KIND_MODULE = /^kind_[a-z0-9_]+\/(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*\.py$/;

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
        if (name !== '__pycache__') walk(path);
      } else {
        out.push(relative(dir, path).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return out;
}

/** The kind's package under `dir`, as the upload body. `entry` is the module with the class. */
export function packStoreKindDir(dir: string, entry: string, sourceCommit: string): StoreKindReleaseUpload {
  const files = filesUnder(dir).filter((path) => !path.endsWith('.pyc'));
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

type Plane = { controlPlaneUrl: string; header: Record<string, string> };

export const uploadStoreKindRelease = (input: Plane & { kind: string; body: StoreKindReleaseUpload }) =>
  planeFor(input.controlPlaneUrl, input.header).uploadStoreKindRelease(input.kind, input.body);

export const rollOutStoreKind = (input: Plane & { kind: string; sha256: string }) =>
  planeFor(input.controlPlaneUrl, input.header).rollOutStoreKind(input.kind, input.sha256);

export const rollBackStoreKind = (input: Plane & { kind: string }) =>
  planeFor(input.controlPlaneUrl, input.header).rollBackStoreKind(input.kind);

export const storeKindStatus = (input: Plane & { kind: string }) =>
  planeFor(input.controlPlaneUrl, input.header).getStoreKind(input.kind);
