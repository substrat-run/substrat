/**
 * `substrat store-kind publish --kind <kind>` and `rollback` (#2297).
 *
 * Publish reads the kind's Python modules (an outdir from `pywrangler deploy --dry-run`,
 * or `--dir` when that outdir is already in hand), posts them, and prints which verticals
 * moved. The control plane canaries the first and rolls back on failure. Rollback points
 * the kind at its previous release. The logged-in control plane is the target; `--cp`
 * selects another one, such as test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planeFor } from './plane.js';

export interface StoreKindModule {
  readonly name: string;
  readonly contentBase64: string;
}

export interface StoreKindReleaseBody {
  readonly releaseId: string;
  readonly entry: string;
  readonly modules: readonly StoreKindModule[];
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** The `.py` files in a directory, as the publish body. `entry` is the kind's class module. */
export function packStoreKindDir(dir: string, entry: string, releaseId: string): StoreKindReleaseBody {
  const modules = readdirSync(dir)
    .filter((name) => name.endsWith('.py'))
    .sort()
    .map((name) => ({
      name,
      contentBase64: base64(readFileSync(join(dir, name))),
    }));
  if (!modules.some((m) => m.name === entry)) {
    throw new Error(`'${dir}' has no ${entry}`);
  }
  return { releaseId, entry, modules };
}

export async function publishStoreKind(input: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  kind: string;
  body: StoreKindReleaseBody;
}): Promise<{ release: { releaseId: string; status: string }; verticals: string[] }> {
  return planeFor(input.controlPlaneUrl, input.header).publishStoreKind(input.kind, input.body);
}

export async function rollbackStoreKind(input: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  kind: string;
}): Promise<{ release: { releaseId: string; status: string }; verticals: string[] }> {
  return planeFor(input.controlPlaneUrl, input.header).rollbackStoreKind(input.kind);
}
