/**
 * Strict search/replace edit engine — builder-harness.md H1 (#663 row 3).
 *
 * Matching pipeline and failure-reflection design ported from aider
 * (github.com/Aider-AI/aider, `aider/coders/editblock_coder.py`),
 * Copyright Paul Gauthier, Apache-2.0 — see vendor/AIDER_LICENSE.txt.
 * Changes from the original: TypeScript port; the wire format is a tool call
 * (`oldString`/`newString`) rather than SEARCH/REPLACE blocks in prose;
 * single-match uniqueness is REQUIRED (aider replaces the first occurrence
 * silently — a tool call has a `replaceAll` flag instead); the empty-search
 * append behavior is dropped (write_file owns creation); fuzzy apply stays
 * dropped, exactly as aider ships it (their fuzzy matcher is dead code).
 *
 * The pipeline, in order — and deliberately NOTHING after it:
 *   1. exact       — the string appears verbatim, exactly once (or replaceAll)
 *   2. whitespace  — every line matches after ONE uniform indent shift
 *                    (the model under/over-indented the whole block)
 *   3. elision     — `...` lines in BOTH strings elide unchanged middles
 * A miss becomes a structured reflection (did-you-mean excerpt, already-applied
 * hint) for the model to correct — never a guess. Guessing risks a silently
 * wrong edit in a loop whose oracle (the gates) only runs at turn end.
 */

export interface EditSuccess {
	readonly ok: true;
	readonly content: string;
	readonly replaced: number;
	readonly strategy: 'exact' | 'whitespace' | 'elision';
}

export interface EditFailure {
	readonly ok: false;
	/** Structured, model-facing: what failed and how to fix the next attempt. */
	readonly reflection: string;
}

export type EditOutcome = EditSuccess | EditFailure;

/** Split keeping line endings, so joins are byte-exact. */
function lines(s: string): string[] {
	return s.length === 0 ? [] : s.split(/(?<=\n)/);
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
		count += 1;
	}
	return count;
}

/** A line that is only `...` (with optional indent) — the elision marker. */
const DOTS_LINE = /^[ \t]*\.\.\.[ \t]*(\r?\n|$)/;

const failure = (reflection: string): EditFailure => ({ ok: false, reflection });

export function applyEdit(
	path: string,
	content: string,
	oldString: string,
	newString: string,
	opts: { replaceAll?: boolean } = {},
): EditOutcome {
	if (oldString.length === 0) {
		return failure(
			`oldString is empty. edit_file changes existing text; to create ${path} or rewrite it wholesale, use write_file.`,
		);
	}
	if (oldString === newString) {
		return failure('oldString and newString are identical — nothing to change.');
	}

	// 1. Exact.
	const count = countOccurrences(content, oldString);
	if (count === 1 || (count > 0 && opts.replaceAll)) {
		return {
			ok: true,
			content: content.split(oldString).join(newString),
			replaced: count,
			strategy: 'exact',
		};
	}
	if (count > 1) return failure(ambiguous(path, count));

	// 2. One uniform indent shift (aider `replace_part_with_missing_leading_whitespace`).
	const shifted = replaceWithUniformIndentShift(content, oldString, newString);
	if (shifted !== null) {
		if (shifted === 'ambiguous') return failure(ambiguous(path, 2));
		return { ok: true, content: shifted, replaced: 1, strategy: 'whitespace' };
	}

	// 3. `...` elision (aider `try_dotdotdots`).
	const elided = tryElision(path, content, oldString, newString);
	if (elided !== null) return elided;

	return failure(notFound(path, content, oldString, newString));
}

/**
 * Outdent search+replace by their common leading whitespace, then find a
 * window where every line matches after adding ONE consistent prefix — the
 * usual failure when the model re-indents a block from memory. Applies only
 * on a unique match.
 */
function replaceWithUniformIndentShift(
	content: string,
	oldString: string,
	newString: string,
): string | 'ambiguous' | null {
	const searchRaw = lines(ensureTrailingNewline(oldString));
	const replaceRaw = lines(ensureTrailingNewline(newString));
	const contentLines = lines(content);
	if (searchRaw.length === 0 || contentLines.length < searchRaw.length) return null;

	// Common leading whitespace across all non-blank search AND replace lines.
	const leading = [...searchRaw, ...replaceRaw]
		.filter((l) => l.trim().length > 0)
		.map((l) => l.length - l.trimStart().length);
	const strip = leading.length ? Math.min(...leading) : 0;
	const outdent = (l: string): string => (l.trim().length > 0 ? l.slice(strip) : l);
	const search = searchRaw.map(outdent);
	const replace = replaceRaw.map(outdent);

	const matches: Array<{ at: number; prefix: string }> = [];
	for (let i = 0; i + search.length <= contentLines.length; i++) {
		const prefix = uniformPrefix(contentLines.slice(i, i + search.length), search);
		if (prefix !== null) matches.push({ at: i, prefix });
	}
	if (matches.length === 0) return null;
	if (matches.length > 1) return 'ambiguous';

	const { at, prefix } = matches[0] as { at: number; prefix: string };
	const replaced = replace.map((l) => (l.trim().length > 0 ? prefix + l : l));
	return [...contentLines.slice(0, at), ...replaced, ...contentLines.slice(at + search.length)].join(
		'',
	);
}

/** The single prefix that maps part-lines onto whole-lines, or null (aider `match_but_for_leading_whitespace`). */
function uniformPrefix(whole: string[], part: string[]): string | null {
	for (let i = 0; i < whole.length; i++) {
		if ((whole[i] as string).trimStart() !== (part[i] as string).trimStart()) return null;
	}
	const prefixes = new Set(
		whole
			.map((w, i) => ({ w, p: part[i] as string }))
			.filter(({ w }) => w.trim().length > 0)
			.map(({ w, p }) => w.slice(0, w.length - p.length)),
	);
	if (prefixes.size !== 1) return null;
	const prefix = [...prefixes][0] as string;
	return /^[ \t]*$/.test(prefix) ? prefix : null;
}

/**
 * `...` elision: both strings split on marker lines; the pieces pair up, and
 * each search piece must occur exactly once. Unlike a plain unique-substring
 * edit, this lets the model anchor a change with the function's first and
 * last lines without re-sending its body.
 */
function tryElision(
	path: string,
	content: string,
	oldString: string,
	newString: string,
): EditOutcome | null {
	const searchPieces = splitOnDots(ensureTrailingNewline(oldString));
	const replacePieces = splitOnDots(ensureTrailingNewline(newString));
	if (searchPieces === null || searchPieces.length < 2) return null;
	if (replacePieces === null || replacePieces.length !== searchPieces.length) {
		return failure(
			`oldString uses ${searchPieces.length - 1} "..." elision line(s) but newString does not match — both strings must contain the SAME number of "..." lines, in the same order, standing for the same unchanged text.`,
		);
	}

	let result = content;
	let replaced = 0;
	for (let i = 0; i < searchPieces.length; i++) {
		const search = searchPieces[i] as string;
		const replace = replacePieces[i] as string;
		if (search.length === 0) {
			if (replace.length === 0) continue;
			return failure(
				'an elision section has an empty oldString side but new content on the newString side — edit_file cannot infer where to insert it. Give the section an anchor line, or use write_file.',
			);
		}
		const n = countOccurrences(result, search);
		if (n === 0) return failure(notFound(path, content, search, replace));
		if (n > 1) return failure(ambiguous(path, n));
		result = result.replace(search, replace);
		replaced += 1;
	}
	return { ok: true, content: result, replaced, strategy: 'elision' };
}

/** Pieces between `...` marker lines, or null when no marker exists. */
function splitOnDots(s: string): string[] | null {
	const ls = lines(s);
	if (!ls.some((l) => DOTS_LINE.test(l))) return null;
	const pieces: string[] = [];
	let cur = '';
	for (const l of ls) {
		if (DOTS_LINE.test(l)) {
			pieces.push(cur);
			cur = '';
		} else {
			cur += l;
		}
	}
	pieces.push(cur);
	return pieces;
}

function ensureTrailingNewline(s: string): string {
	return s.length === 0 || s.endsWith('\n') ? s : `${s}\n`;
}

// ── reflections ───────────────────────────────────────────────────────────────

function ambiguous(path: string, count: number): string {
	return [
		`oldString matches ${count} places in ${path} — refusing to guess which one you meant.`,
		'Include more surrounding lines to make the match unique, or pass replaceAll: true to change every occurrence.',
	].join('\n');
}

function notFound(path: string, content: string, oldString: string, newString: string): string {
	const out = [
		`oldString did not exactly match anything in ${path}.`,
		'',
		'It must match the file EXACTLY — every space, tab, indent, and blank line.',
	];
	const similar = bestSimilarExcerpt(content, oldString);
	if (similar) {
		out.push('', `Did you mean to match these actual lines from ${path}?`, '```', similar, '```');
	}
	if (newString.length > 0 && content.includes(newString)) {
		out.push(
			'',
			`Note: the newString is ALREADY present in ${path} — if an earlier edit_file call applied this change, do not re-send it.`,
		);
	}
	out.push(
		'',
		'Re-read the file if unsure, then reply with a corrected edit_file call. A line containing only "..." (in BOTH strings) may stand for an unchanged middle section.',
	);
	return out.join('\n');
}

/**
 * Best-matching window of the file for the did-you-mean excerpt (aider
 * `find_similar_lines`): same line count as the search, char-bigram Dice
 * similarity, 0.6 threshold, ±3 lines of context when the ends don't align.
 */
export function bestSimilarExcerpt(content: string, oldString: string): string | null {
	const search = ensureTrailingNewline(oldString);
	const searchLines = lines(search);
	const contentLines = lines(content);
	if (searchLines.length === 0 || contentLines.length === 0) return null;

	const target = bigrams(search);
	let best = 0;
	let bestAt = -1;
	const span = Math.min(searchLines.length, contentLines.length);
	for (let i = 0; i + span <= contentLines.length; i++) {
		const window = contentLines.slice(i, i + span).join('');
		const score = dice(target, bigrams(window));
		if (score > best) {
			best = score;
			bestAt = i;
		}
	}
	if (best < 0.6 || bestAt === -1) return null;

	const endsAlign =
		contentLines[bestAt]?.trim() === searchLines[0]?.trim() &&
		contentLines[bestAt + span - 1]?.trim() === searchLines[searchLines.length - 1]?.trim();
	const pad = endsAlign ? 0 : 3;
	const from = Math.max(0, bestAt - pad);
	const to = Math.min(contentLines.length, bestAt + span + pad);
	return contentLines.slice(from, to).join('').replace(/\n$/, '');
}

function bigrams(s: string): Map<string, number> {
	const m = new Map<string, number>();
	for (let i = 0; i < s.length - 1; i++) {
		const b = s.slice(i, i + 2);
		m.set(b, (m.get(b) ?? 0) + 1);
	}
	return m;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
	let sizeA = 0;
	let sizeB = 0;
	let overlap = 0;
	for (const n of a.values()) sizeA += n;
	for (const n of b.values()) sizeB += n;
	if (sizeA + sizeB === 0) return 0;
	for (const [g, n] of a) overlap += Math.min(n, b.get(g) ?? 0);
	return (2 * overlap) / (sizeA + sizeB);
}
