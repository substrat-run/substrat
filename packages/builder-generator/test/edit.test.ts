/**
 * The strict edit engine (builder-harness.md H1, #663 row 3): aider's matching
 * pipeline — exact, uniform-indent-shift, `...` elision — and the structured
 * reflections that replace fuzzy apply. Every "refuses" case here is a design
 * assertion: a guessed edit the gates only catch at turn end is worse than a
 * reflection the model corrects immediately.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { applyEdit, bestSimilarExcerpt } from '../src/edit.js';
import { workspaceTools } from '../src/tools.js';

const FILE = [
	'export function hello(name: string): string {',
	'\tconst greeting = `Hello, ${name}!`;',
	'\treturn greeting;',
	'}',
	'',
	'export function goodbye(name: string): string {',
	'\tconst farewell = `Bye, ${name}!`;',
	'\treturn farewell;',
	'}',
	'',
].join('\n');

describe('applyEdit — exact', () => {
	it('replaces a unique exact match', () => {
		const r = applyEdit('a.ts', FILE, 'const greeting = `Hello, ${name}!`;', 'const greeting = `Hi, ${name}!`;');
		expect(r).toMatchObject({ ok: true, replaced: 1, strategy: 'exact' });
		if (r.ok) expect(r.content).toContain('Hi, ${name}');
	});

	it('refuses an ambiguous match, names the count, offers replaceAll', () => {
		const r = applyEdit('a.ts', FILE, 'name: string): string {', 'who: string): string {');
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reflection).toContain('matches 2 places');
			expect(r.reflection).toContain('replaceAll');
		}
	});

	it('replaceAll changes every occurrence', () => {
		const r = applyEdit('a.ts', FILE, 'name: string', 'who: string', { replaceAll: true });
		expect(r).toMatchObject({ ok: true, replaced: 2 });
	});

	it('refuses empty oldString and a no-op edit', () => {
		expect(applyEdit('a.ts', FILE, '', 'x').ok).toBe(false);
		expect(applyEdit('a.ts', FILE, 'return greeting;', 'return greeting;').ok).toBe(false);
	});
});

describe('applyEdit — uniform indent shift', () => {
	it('applies when the model under-indented the whole block', () => {
		// Model sent the block outdented (lost the tabs) — every line off by the
		// same prefix, aider's most common near-miss.
		const r = applyEdit(
			'a.ts',
			FILE,
			'const farewell = `Bye, ${name}!`;\nreturn farewell;',
			'return `Bye, ${name}!`;',
		);
		expect(r).toMatchObject({ ok: true, strategy: 'whitespace' });
		if (r.ok) {
			expect(r.content).toContain('\treturn `Bye, ${name}!`;');
			expect(r.content).not.toContain('farewell');
		}
	});

	it('does NOT apply when lines differ beyond indentation', () => {
		const r = applyEdit('a.ts', FILE, 'const farewell = `Bye ${name}`;', 'x');
		expect(r.ok).toBe(false);
	});
});

describe('applyEdit — `...` elision', () => {
	it('anchors on first/last lines without re-sending the body', () => {
		const r = applyEdit(
			'a.ts',
			FILE,
			'export function goodbye(name: string): string {\n...\n\treturn farewell;\n}',
			'export function goodbye(name: string, polite = true): string {\n...\n\treturn polite ? farewell : farewell.toUpperCase();\n}',
		);
		expect(r).toMatchObject({ ok: true, strategy: 'elision', replaced: 2 });
		if (r.ok) {
			expect(r.content).toContain('polite = true');
			expect(r.content).toContain('farewell.toUpperCase()');
			// The elided middle survived untouched.
			expect(r.content).toContain('const farewell = `Bye, ${name}!`;');
		}
	});

	it('refuses mismatched elision counts between the two strings', () => {
		const r = applyEdit('a.ts', FILE, 'export function goodbye(name: string): string {\n...\n}', 'x');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reflection).toContain('SAME number of "..." lines');
	});

	it('refuses a non-unique elision anchor', () => {
		const r = applyEdit(
			'a.ts',
			FILE,
			'\treturn greeting;\n...\n\treturn farewell;',
			'\treturn greeting.trim();\n...\n\treturn farewell.trim();',
		);
		expect(r.ok).toBe(true); // both anchors ARE unique here — control case
		const ambiguousAnchor = applyEdit('a.ts', FILE, 'name: string): string {\n...\n}', 'x\n...\n}');
		expect(ambiguousAnchor.ok).toBe(false);
	});
});

describe('applyEdit — reflections', () => {
	it('offers a did-you-mean excerpt for a near miss', () => {
		const r = applyEdit(
			'a.ts',
			FILE,
			// Close but wrong: missing backtick-brace syntax, wrong quote
			"const greeting = 'Hello, name!';\n\treturn greeting;",
			'x',
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reflection).toContain('Did you mean');
			expect(r.reflection).toContain('const greeting = `Hello, ${name}!`;');
		}
	});

	it('flags an already-applied edit', () => {
		const r = applyEdit('a.ts', FILE, 'nothing like this exists', 'return greeting;');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reflection).toContain('ALREADY present');
	});

	it('stays silent on similarity below threshold', () => {
		expect(bestSimilarExcerpt(FILE, 'zzz qqq completely unrelated wombat')).toBeNull();
	});
});

describe('edit_file tool', () => {
	async function tools(deny?: (p: string) => string | null) {
		const root = await mkdtemp(join(tmpdir(), 'builder-edit-'));
		const ws = new LocalWorkspace({ root });
		await ws.writeFile('src/a.ts', FILE);
		const events: unknown[] = [];
		const t = workspaceTools({
			workspace: ws,
			emit: (e) => events.push(e),
			editTool: true,
			...(deny ? { denyWrite: deny } : {}),
		});
		return { ws, t, events };
	}
	const callOpts = { toolCallId: 't1', messages: [] };

	it('is absent unless the host opts the model in', async () => {
		const root = await mkdtemp(join(tmpdir(), 'builder-edit-off-'));
		const t = workspaceTools({ workspace: new LocalWorkspace({ root }), emit: () => {} });
		expect('edit_file' in t).toBe(false);
	});

	it('edits the file on disk and emits file-written', async () => {
		const { ws, t, events } = await tools();
		const out = await t.edit_file!.execute!(
			{ path: 'src/a.ts', oldString: 'return greeting;', newString: 'return greeting.trim();' },
			callOpts,
		);
		expect(out).toContain('edited src/a.ts: 1 replacement');
		expect(await ws.readFile('src/a.ts')).toContain('greeting.trim()');
		expect(events.some((e) => (e as { type: string }).type === 'file-written')).toBe(true);
	});

	it('returns the reflection on failure and leaves the file untouched', async () => {
		const { ws, t } = await tools();
		const out = await t.edit_file!.execute!(
			{ path: 'src/a.ts', oldString: 'not in the file', newString: 'x' },
			callOpts,
		);
		expect(out).toMatch(/^FAILED:/);
		expect(await ws.readFile('src/a.ts')).toBe(FILE);
	});

	it('respects denyWrite exactly like write_file (interview guard)', async () => {
		const { t } = await tools((p) => (p.startsWith('spec/') ? null : 'interview writes spec/** only'));
		const out = await t.edit_file!.execute!(
			{ path: 'src/a.ts', oldString: 'return greeting;', newString: 'x' },
			callOpts,
		);
		expect(out).toMatch(/^REFUSED:/);
	});

	it('points a missing file at write_file', async () => {
		const { t } = await tools();
		const out = await t.edit_file!.execute!(
			{ path: 'src/missing.ts', oldString: 'a', newString: 'b' },
			callOpts,
		);
		expect(out).toContain('use write_file');
	});
});
