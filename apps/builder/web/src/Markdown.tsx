/**
 * Assistant prose and the concept document render as Markdown — the model is
 * instructed to write it, and plain text was the "formatting isn't working"
 * bug. marked parses, DOMPurify sanitises: model output is semi-trusted and
 * goes through dangerouslySetInnerHTML, so sanitising is not optional.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

export function Markdown(props: { text: string; className?: string }) {
	const html = useMemo(
		() =>
			DOMPurify.sanitize(
				// breaks: chat messages use single newlines meaningfully.
				marked.parse(props.text, { async: false, gfm: true, breaks: true }),
			),
		[props.text],
	);
	return (
		<div
			className={props.className ? `md ${props.className}` : 'md'}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
