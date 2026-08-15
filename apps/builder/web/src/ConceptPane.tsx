/**
 * The concept tab — spec/concept.md rendered readable. This is the document
 * the whole interview exists to produce, so it gets a reading view, not just a
 * Monaco buffer; the App auto-switches here the moment the model writes it.
 * Re-fetches on refreshKey (after every turn), like the code pane.
 */
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Markdown } from './Markdown.js';

export function ConceptPane(props: { vertical: string; refreshKey: number }) {
	const [content, setContent] = useState<string | null>(null);

	useEffect(() => {
		api.file(`${props.vertical}/spec/concept.md`).then(
			({ content }) => setContent(content),
			() => setContent(null),
		);
	}, [props.vertical, props.refreshKey]);

	if (content === null) {
		return (
			<div className="empty">
				no concept yet — the interview writes spec/concept.md once you approve it
			</div>
		);
	}
	return (
		<div className="concept">
			<Markdown className="concept-doc" text={content} />
		</div>
	);
}
