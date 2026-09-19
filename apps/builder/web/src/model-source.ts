/**
 * Snapshot → the Model tab's contents (#684).
 *
 * Pure, and separate from the pane for that reason: everything that can be wrong
 * with a project's entity model at this point is decidable from the file list,
 * and each answer is a different sentence to show a builder. A pane that folded
 * them into one "nothing to show" would be hiding the difference between *the
 * model phase has not run yet* and *it ran and produced something unreadable*.
 *
 * The artifact of record is `model.json`, never the TypeScript beside it: the
 * browser has no way to execute `spec/model.ts`, and even where it could, reading
 * the emitted form is what keeps the authoring notation swappable (#697). The
 * turn loop emits the artifact into the tree, so the presence of a `spec/model.ts`
 * with no `model.json` is a real and nameable state — the next turn produces it.
 */
import { parseModel, renderModelHtml, type ModelViewSource } from '@substrat-run/model-view';

/** Both paths are relative to the vertical dir, as snapshot keys are. */
export const MODEL_ARTIFACT = 'model.json';
export const MODEL_SOURCE = 'spec/model.ts';

export type ModelView =
	/** A rendered, self-contained page — inline CSS and SVG, no script, nothing external. */
	| { readonly kind: 'ready'; readonly html: string; readonly entities: number }
	/** The host has no snapshot yet (a project before its first commit). */
	| { readonly kind: 'no-snapshot' }
	/** No model declared at all — the build has not reached the model phase. */
	| { readonly kind: 'no-model' }
	/** Declared but not yet emitted: the next turn writes the artifact. */
	| { readonly kind: 'not-emitted' }
	/** An artifact that is not a model — reported with the renderer's own words. */
	| { readonly kind: 'invalid'; readonly message: string };

/**
 * Decide what the tab shows. `files` is the snapshot's path → content map, or
 * null when this host returned no snapshot.
 */
export function modelViewOf(
	files: Readonly<Record<string, string>> | null,
	source: ModelViewSource,
): ModelView {
	if (files === null) return { kind: 'no-snapshot' };

	const raw = files[MODEL_ARTIFACT];
	if (raw === undefined) {
		return files[MODEL_SOURCE] === undefined ? { kind: 'no-model' } : { kind: 'not-emitted' };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return { kind: 'invalid', message: `${source.source} is not valid JSON — ${(e as Error).message}` };
	}
	try {
		// parseModel's refusals name the artifact rather than the renderer, which is
		// exactly the message a builder needs here, so they are passed through whole.
		const model = parseModel(parsed, source.source);
		return {
			kind: 'ready',
			html: renderModelHtml(model, source),
			entities: Object.keys(model.entities).length,
		};
	} catch (e) {
		return { kind: 'invalid', message: (e as Error).message };
	}
}
