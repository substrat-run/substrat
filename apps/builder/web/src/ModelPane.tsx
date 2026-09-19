/**
 * The model tab (#684) — the project's entity model as a picture: the ER diagram,
 * the entity cards, and the declared lifecycles.
 *
 * Rendered by `@substrat-run/model-view`, the same core `substrat model view` and
 * the dashboard's Model tab (#1214) use, from the same artifact — so what a
 * builder approves here is the page the tenant later sees against the deployed
 * version, not a second drawing of the same nouns.
 *
 * What this picture IS, stated because the issue thread had to correct itself:
 * navigation and shared vocabulary, not the checkpoint that makes the model safe.
 * It is a lossy projection of `model.json` — the filter is the whole point — so
 * the reviewable artifact stays the declaration in the Code tab, and the audience
 * for this page is the human approver.
 *
 * Reads come from the same `/api/snapshot` fetch the file pane uses: the whole
 * working tree in one response, served from R2 in hosted mode, so opening this
 * tab never wakes the sandbox container. The rendered page references nothing
 * external, which is what lets it go into a sandboxed iframe via `srcdoc` — no
 * network, no script execution.
 */
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { modelViewOf, MODEL_SOURCE, type ModelView } from './model-source.js';

export function ModelPane(props: { vertical: string; title: string; refreshKey: number }) {
	// undefined = the snapshot has not resolved yet; anything else is an answer.
	const [view, setView] = useState<ModelView | undefined>(undefined);

	useEffect(() => {
		let stale = false;
		const source = { source: `${props.vertical}/model.json`, title: props.title };
		api.snapshot().then(
			(s) => !stale && setView(modelViewOf(s ? s.files : null, source)),
			() => !stale && setView(modelViewOf(null, source)),
		);
		return () => {
			stale = true;
		};
	}, [props.refreshKey, props.vertical, props.title]);

	if (view === undefined) return <div className="empty">reading the model…</div>;

	if (view.kind === 'ready') {
		return (
			<div className="model-pane">
				<div className="model-bar">
					<span className="badge ok">
						{view.entities} declared {view.entities === 1 ? 'entity' : 'entities'}
					</span>
					<span className="mono">{props.vertical}/model.json</span>
				</div>
				{/* Self-contained by construction, and sandboxed anyway: the page is an
				    artifact of the project, and the studio does not run the project. */}
				<iframe title="Entity model" sandbox="" srcDoc={view.html} />
			</div>
		);
	}

	return <div className="empty">{explain(view, props.vertical)}</div>;
}

/** The one sentence each dead end deserves — what is true, and what produces the picture. */
function explain(view: Exclude<ModelView, { kind: 'ready' }>, vertical: string): string {
	switch (view.kind) {
		case 'no-snapshot':
			return 'no snapshot yet — the tree is published with the project’s first commit';
		case 'no-model':
			return `no entity model yet — the model phase writes ${vertical}/${MODEL_SOURCE} once the concept is approved`;
		case 'not-emitted':
			return `${MODEL_SOURCE} is declared but no model.json has been emitted yet — it is written when a turn commits`;
		case 'invalid':
			return view.message;
	}
}
