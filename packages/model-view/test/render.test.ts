import { describe, it, expect } from 'vitest';
import { parseModel, renderModelHtml } from '../src/index.js';

/**
 * The pure rendering core shared by `substrat model view` (#756) and the dashboard's
 * Model tab (#1214). The CLI's own suite covers the filesystem shell (paths, temp-file
 * placement) and re-asserts the rendered facts through it; this one holds the two
 * properties the DASHBOARD depends on: the validation refuses malformed shape with an
 * error naming the artifact, and the output is embeddable with no network at all —
 * an iframe `srcdoc` in a worker-served SPA fetches nothing.
 */

const MODEL = {
  entities: {
    item: {
      table: 'todo_items',
      fields: {
        type: 'object',
        properties: { id: { type: 'string' }, list_id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'list_id', 'text'],
      },
      parents: ['list'],
    },
    list: {
      table: 'todo_lists',
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

describe('model-view', () => {
  it('renders the reviewable facts: tables, edges, marks, lifecycles', () => {
    const model = parseModel(MODEL, 'x/model.json');
    const html = renderModelHtml(model, { source: 'x/model.json' });
    expect(html).toContain('todo_items');
    expect(html).toContain('item hangs off list');
    expect(html).toContain('ERASABLE');
    expect(html).toContain('closeItem');
    expect(html).toContain('INITIAL');
  });

  it('references nothing external — embeddable as an iframe srcdoc with no network', () => {
    const html = renderModelHtml(parseModel(MODEL, 'x/model.json'), { source: 'x/model.json' });
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\bsrc=/i);
  });

  it('titles from the explicit title, else the source path', () => {
    const model = parseModel(MODEL, 'x/model.json');
    expect(renderModelHtml(model, { source: 'demos/todo/model.json' })).toContain('Entity model — todo</title>');
    expect(renderModelHtml(model, { source: 'todo@0.3.1', title: 'todo@0.3.1' })).toContain(
      'Entity model — todo@0.3.1</title>',
    );
  });

  it('refuses malformed shape with an error naming the artifact', () => {
    expect(() => parseModel({ name: 'x' }, 'a/model.json')).toThrow(/a\/model.json has no 'entities' object/);
    expect(() => parseModel({ entities: { a: { fields: {} } } }, 'm')).toThrow(/declares no table/);
    expect(() => parseModel({ entities: { a: { table: 't', fields: {}, parents: 'list' } } }, 'm')).toThrow(
      /other than a list of field names/,
    );
    expect(() =>
      parseModel({ entities: { a: { table: 't', fields: {} } }, lifecycles: { a: { field: 's', initial: 'x' } } }, 'm'),
    ).toThrow(/declares no states map/);
  });

  it('renders a malformed fields.required as all-optional rather than throwing', () => {
    // `fields` is opaque JSON Schema, so `required` slips past parseModel's list checks —
    // the renderer must not turn that into a TypeError from `new Set(3)`.
    const odd = {
      entities: {
        a: { table: 't', fields: { type: 'object', properties: { id: { type: 'string' } }, required: 3 } },
      },
    };
    const html = renderModelHtml(parseModel(odd, 'm'), { source: 'm' });
    expect(html).toContain('<span class="opt">?</span>');
  });

  it('escapes what it renders', () => {
    const nasty = {
      entities: { '<img x>': { table: 't', fields: { type: 'object', properties: {} } } },
    };
    const html = renderModelHtml(parseModel(nasty, 'm'), { source: 'm' });
    expect(html).not.toContain('<img x>');
    expect(html).toContain('&lt;img x&gt;');
  });
});
