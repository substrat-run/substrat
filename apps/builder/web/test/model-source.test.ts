/**
 * What the studio's Model tab shows, for every state a project's tree can be in
 * (#684).
 *
 * The rendering itself belongs to `@substrat-run/model-view` and is asserted
 * there. What is this pane's own is the DECISION: which of a handful of different
 * situations a snapshot is in, and that each gets its own answer rather than one
 * blank pane. "The model phase has not run" and "it ran and emitted something
 * unreadable" are opposite problems with opposite remedies, and a builder who
 * cannot tell them apart is stuck on both.
 */
import { describe, expect, it } from 'vitest';
import { modelViewOf } from '../src/model-source.js';

const SOURCE = { source: 'proj/model.json', title: 'Acme' };

/** The shape `emitModel` renders — one parent edge, one lifecycle, one erasable field. */
const MODEL = {
	entities: {
		item: {
			table: 'acme_items',
			fields: {
				type: 'object',
				properties: { id: { type: 'string' }, list_id: { type: 'string' }, text: { type: 'string' } },
				required: ['id', 'list_id', 'text'],
			},
			parents: ['list'],
		},
		list: {
			table: 'acme_lists',
			fields: {
				type: 'object',
				properties: { id: { type: 'string' }, name: { type: 'string' } },
				required: ['id', 'name'],
			},
			erasable: ['name'],
		},
	},
	lifecycles: {
		item: { field: 'state', initial: 'open', states: { open: { on: { closeItem: 'done' } }, done: {} } },
	},
};

const withModel = (extra: Record<string, string> = {}) => ({
	'model.json': `${JSON.stringify(MODEL, null, 2)}\n`,
	...extra,
});

describe('modelViewOf', () => {
	it('renders the emitted artifact — tables, edges and lifecycles', () => {
		const view = modelViewOf(withModel(), SOURCE);
		expect(view.kind).toBe('ready');
		if (view.kind !== 'ready') return;
		expect(view.entities).toBe(2);
		expect(view.html).toContain('acme_items');
		expect(view.html).toContain('item hangs off list');
		expect(view.html).toContain('closeItem');
		expect(view.html).toContain('Acme');
	});

	it('stays embeddable as a sandboxed srcdoc — no script, no network', () => {
		const view = modelViewOf(withModel(), SOURCE);
		if (view.kind !== 'ready') throw new Error(`expected ready, got ${view.kind}`);
		expect(view.html).not.toMatch(/https?:\/\//);
		expect(view.html).not.toMatch(/<script/i);
		expect(view.html).not.toMatch(/\bsrc=/i);
	});

	it('reads the ARTIFACT, never the TypeScript beside it', () => {
		// A project mid-edit: the declaration says one thing, the emitted artifact
		// another. The browser cannot execute the declaration, and the emitted form
		// is the artifact of record, so the picture must come from model.json.
		const view = modelViewOf(withModel({ 'spec/model.ts': 'export const nonsense = 1;' }), SOURCE);
		expect(view.kind).toBe('ready');
	});

	it('separates "no model phase yet" from "declared but not emitted"', () => {
		expect(modelViewOf({ 'README.md': '# x' }, SOURCE).kind).toBe('no-model');
		expect(modelViewOf({ 'spec/model.ts': 'export const model = {};' }, SOURCE).kind).toBe(
			'not-emitted',
		);
	});

	it('says so when the host has no snapshot, rather than claiming no model', () => {
		expect(modelViewOf(null, SOURCE).kind).toBe('no-snapshot');
	});

	it('names the artifact when it is unreadable, not the renderer', () => {
		const broken = modelViewOf({ 'model.json': '{ not json' }, SOURCE);
		expect(broken.kind).toBe('invalid');
		if (broken.kind === 'invalid') expect(broken.message).toContain('proj/model.json');

		const wrong = modelViewOf({ 'model.json': '{"entities":{"a":{}}}' }, SOURCE);
		expect(wrong.kind).toBe('invalid');
		if (wrong.kind === 'invalid') expect(wrong.message).toContain('proj/model.json');
	});
});
