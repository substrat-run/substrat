import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';
import type { EmittedModel } from '@substrat-run/contracts';
import { parseModel, renderModelHtml } from '@substrat-run/model-view';

/**
 * `substrat model view` — the entity model as something a human can look at.
 *
 * It reads `model.json`, never the TypeScript. That file is the artifact of record (#697):
 * `lint:model --check` gates it, and `tools/model-diff.mts` says outright that everything
 * downstream should read it — which keeps this renderer correct across a change of
 * authoring notation, and keeps it honest about what actually shipped.
 *
 * The RENDERING lives in `@substrat-run/model-view` — the pure core this file wraps, shared
 * with the dashboard's Model tab (#1214) so both surfaces draw the same page from the same
 * artifact. What stays here is the filesystem half: resolving a directory to its
 * `model.json`, and where the rendered file lands.
 *
 * The output is ONE self-contained HTML file: inline CSS, inline SVG, no script, no CDN.
 * That is what makes it openable from a file path — a click in a chat pane, `open` on a
 * Mac, a browser tab — with no server and no network. A view that fetched a stylesheet
 * would render unstyled exactly where it is most wanted, on a laptop with no connectivity
 * or behind a proxy, so the no-external-reference property is asserted by the suite.
 *
 * It defaults to writing OUTSIDE the project (a temp directory), because a rendered view
 * is not a build output: dropping a generated `model.html` next to the source would put an
 * un-gated generated file in someone's repo, which is precisely what the three-marks rule
 * says not to do. `--out` places it deliberately.
 */

export { renderModelHtml, parseModel, type ModelViewSource } from '@substrat-run/model-view';

export interface ModelViewOptions {
  /** The `model.json` the view was rendered from, as displayed. */
  readonly source: string;
  /** Where to write. Defaults to a temp path derived from the model's directory. */
  readonly out?: string;
}

export interface ModelViewResult {
  /** Absolute path written. */
  readonly file: string;
  /** How many entities the view covers — the one number worth printing. */
  readonly entities: number;
}

/**
 * A directory or the file itself → the `model.json` to read.
 *
 * A directory is the common case (`substrat model view .` from inside a vertical), and the
 * artifact's location is a convention `tools/model-diff.mts` owns: the package root.
 */
export function resolveModelPath(target: string): string {
  const abs = isAbsolute(target) ? target : resolve(process.cwd(), target);
  const file = existsSync(abs) && statSync(abs).isDirectory() ? join(abs, 'model.json') : abs;
  if (!existsSync(file)) {
    throw new Error(
      `no model.json at ${file}\n` +
        "  A vertical's model.json is emitted beside its package.json by `pnpm lint:model`.\n" +
        '  Pass the directory that holds it, or the file itself.',
    );
  }
  return file;
}

/** Parse a `model.json` file, refusing anything that is not one rather than rendering an empty page. */
export function readModel(file: string): EmittedModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseModel(parsed, file);
}

/**
 * Default output path: a temp file named for the model's directory.
 *
 * Deliberately not beside `model.json`: a view written into the project would be an
 * un-gated generated file in someone's repo, and this one is a thing you look at, not a
 * thing you commit. Stable across runs, so a re-render replaces the tab you already have
 * open rather than leaving a trail of files behind.
 *
 * The directory's basename alone is not enough to be stable AND distinct — a monorepo with
 * `apps/a/api` and `apps/b/api` would have the second render silently replace the first
 * one's view — so the full resolved directory is hashed into the name.
 */
export async function defaultOutPath(modelFile: string): Promise<string> {
  const dir = dirname(resolve(modelFile));
  const label = basename(dir).replace(/[^a-zA-Z0-9._-]/g, '-') || 'model';
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(dir));
  const short = Buffer.from(digest).toString('hex').slice(0, 8);
  return join(tmpdir(), 'substrat-model', `${label}-${short}.html`);
}

/** Read, render, write. Returns the absolute path — the thing worth printing. */
export async function writeModelView(
  target: string,
  opts: { readonly out?: string } = {},
): Promise<ModelViewResult> {
  const modelFile = resolveModelPath(target);
  const model = readModel(modelFile);
  const html = renderModelHtml(model, { source: modelFile, title: basename(dirname(modelFile)) || 'substrat' });
  const file = opts.out ? resolve(process.cwd(), opts.out) : await defaultOutPath(modelFile);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  return { file, entities: Object.keys(model.entities).length };
}
