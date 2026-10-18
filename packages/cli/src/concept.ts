import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncConcept } from '@substrat-run/model-view';
import { readModel, resolveModelPath } from './model.js';

/**
 * `substrat concept sync` — rewrite the generated regions of `spec/concept.md` (#2362).
 *
 * The rendering is `@substrat-run/model-view`'s pure `syncConcept`, shared with
 * `pnpm lint:concept`, so the command that writes the file and the gate that judges it are
 * one function. What lives here is the filesystem half: where a vertical keeps its
 * `model.json`, `PERMISSIONS.md` and `spec/concept.md`, all beside its `package.json`.
 */

export interface ConceptSyncResult {
  /** Absolute path of the concept document. */
  readonly file: string;
  /** Whether the file's text differs from what the current model and permissions render. */
  readonly changed: boolean;
}

/** `dir` is the vertical's package directory; a `model.json` path is accepted and its directory used. */
export function syncConceptFile(dir: string, opts: { readonly check?: boolean } = {}): ConceptSyncResult {
  const modelFile = resolveModelPath(dir);
  const root = modelFile.slice(0, modelFile.length - 'model.json'.length);
  const file = join(root, 'spec', 'concept.md');
  if (!existsSync(file)) {
    throw new Error(
      `no spec/concept.md at ${file}\n` +
        '  Write the design first (the generated regions go between <!-- substrat:roles -->,\n' +
        '  <!-- substrat:entities --> and <!-- substrat:processes --> markers, each closed by <!-- /substrat:… -->).',
    );
  }
  const permissionsFile = join(root, 'PERMISSIONS.md');
  const before = readFileSync(file, 'utf8');
  const after = syncConcept(before, {
    model: readModel(modelFile),
    ...(existsSync(permissionsFile) ? { permissionsMd: readFileSync(permissionsFile, 'utf8') } : {}),
  });
  if (!opts.check && after !== before) writeFileSync(file, after);
  return { file, changed: after !== before };
}
