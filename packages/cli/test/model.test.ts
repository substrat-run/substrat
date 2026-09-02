import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultOutPath, readModel, renderModelHtml, resolveModelPath, writeModelView } from '../src/model.js';

/**
 * `substrat model view` — the entity model rendered for a human to approve (#756).
 *
 * The view is only worth anything at the design gate if it is (a) faithful to `model.json`,
 * the artifact of record, and (b) openable from a file path with no server and no network.
 * Both are asserted here: the facts a reviewer is approving must appear, and nothing in the
 * file may reference an external URL.
 */

/** A model small enough to read, carrying every mark the view is supposed to show. */
const MODEL = {
  entities: {
    item: {
      table: 'todo_items',
      fields: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          list_id: { type: 'string' },
          text: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['id', 'list_id', 'text'],
      },
      parents: ['list'],
    },
    list: {
      table: 'todo_lists',
      fields: {
        type: 'object',
        properties: { id: { type: 'string' }, owner_id: { type: 'string' }, name: { type: 'string' } },
        required: ['id', 'owner_id', 'name'],
      },
      parents: ['owner'],
    },
    owner: {
      table: 'todo_owners',
      fields: {
        type: 'object',
        properties: { id: { type: 'string' }, email: { type: 'string' }, display_name: { type: 'string' } },
        required: ['id', 'email', 'display_name'],
      },
      key: ['email'],
      erasable: ['display_name', 'email'],
    },
    budget: {
      table: 'todo_budgets',
      fields: {
        type: 'object',
        properties: { list_id: { type: 'string' }, month: { type: 'string' }, cap: { type: 'number' } },
        required: ['list_id', 'month', 'cap'],
      },
      primaryKey: ['list_id', 'month'],
      parents: ['list'],
    },
  },
  lifecycles: {
    item: { field: 'state', initial: 'open', states: { open: { on: { closeItem: 'done' } }, done: {} } },
  },
};

describe('model view', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-model-'));
    writeFileSync(join(dir, 'model.json'), `${JSON.stringify(MODEL, null, 2)}\n`);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders every entity with its table, primary key and parent edges', () => {
    const html = renderModelHtml(MODEL as never, { source: join(dir, 'model.json') });
    for (const [name, entity] of Object.entries(MODEL.entities)) {
      expect(html).toContain(`>${name}<`);
      expect(html).toContain(entity.table);
    }
    // The parent edges are the thing prose is worst at and a diagram is best at, so they
    // must survive into the view — both as an arrow and as a readable statement.
    expect(html).toContain('item hangs off list');
    expect(html).toContain('list hangs off owner');
    // A composite primary key is a fact about the entity, not a default to be hidden.
    expect(html).toContain('list_id, month');
  });

  it('flags erasable fields and marks the keys', () => {
    const html = renderModelHtml(MODEL as never, { source: join(dir, 'model.json') });
    expect(html).toContain('ERASABLE');
    expect(html).toContain('KEY');
    expect(html).toContain('PK');
    // `owner` is the one entity with erasable fields — the summary line has to agree.
    expect(html).toContain('1 with erasable fields');
  });

  it('renders the declared lifecycles when the model carries any', () => {
    const html = renderModelHtml(MODEL as never, { source: join(dir, 'model.json') });
    expect(html).toContain('Lifecycles');
    expect(html).toContain('closeItem');
    expect(html).toContain('INITIAL');

    const { lifecycles: _drop, ...noLifecycles } = MODEL;
    expect(renderModelHtml(noLifecycles as never, { source: 'x/model.json' })).not.toContain('Lifecycles');
  });

  it('references nothing external — it opens from a file path, offline', () => {
    const html = renderModelHtml(MODEL as never, { source: join(dir, 'model.json') });
    // A stylesheet or font fetched from a CDN renders this unstyled exactly where it is
    // most wanted: a laptop with no connectivity, or a chat pane with no network access.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\bsrc=/i);
  });

  it('does not survive a cyclic parent declaration as a hang', () => {
    // `parents` is an allowlist the kernel does not check for cycles, so the layout must
    // terminate on one rather than recurse forever.
    const cyclic = {
      entities: {
        a: { table: 't_a', fields: { type: 'object', properties: { id: { type: 'string' } } }, parents: ['b'] },
        b: { table: 't_b', fields: { type: 'object', properties: { id: { type: 'string' } } }, parents: ['a'] },
      },
    };
    const html = renderModelHtml(cyclic as never, { source: 'x/model.json' });
    expect(html).toContain('t_a');
    expect(html).toContain('t_b');
  });

  it('writes the file and reports the path and entity count', async () => {
    const out = join(dir, 'view.html');
    const result = await writeModelView(dir, { out });
    expect(result).toEqual({ file: out, entities: 4 });
    expect(readFileSync(out, 'utf8')).toContain('Entity model');
  });

  it('defaults to a stable temp path outside the project', async () => {
    const result = await writeModelView(dir);
    // Never beside model.json: an un-gated generated file in someone's repo is exactly
    // what the three-marks rule refuses.
    expect(result.file.startsWith(dir)).toBe(false);
    expect(result.file).toBe(await defaultOutPath(join(dir, 'model.json')));
    // Stable, so a re-render replaces the tab already open rather than leaving a trail.
    expect((await writeModelView(dir)).file).toBe(result.file);
    rmSync(result.file, { force: true });
  });

  it('gives two models in same-named directories two default paths', async () => {
    // A monorepo with apps/a/api and apps/b/api: the basename alone would have the second
    // render silently replace the first one's view.
    const a = join(dir, 'a', 'api');
    const b = join(dir, 'b', 'api');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const [pathA, pathB] = await Promise.all([
      defaultOutPath(join(a, 'model.json')),
      defaultOutPath(join(b, 'model.json')),
    ]);
    expect(pathA).not.toBe(pathB);
    expect(pathA).toContain('api-');
  });

  it('takes a directory or the file itself, and says so when there is neither', () => {
    expect(resolveModelPath(dir)).toBe(join(dir, 'model.json'));
    expect(resolveModelPath(join(dir, 'model.json'))).toBe(join(dir, 'model.json'));
    expect(() => resolveModelPath(join(dir, 'nowhere'))).toThrow(/no model.json at/);
  });

  it('refuses a file that is not a model, rather than rendering an empty page', () => {
    const notJson = join(dir, 'broken.json');
    writeFileSync(notJson, '{ oops');
    expect(() => readModel(notJson)).toThrow(/not valid JSON/);

    const notModel = join(dir, 'package.json');
    writeFileSync(notModel, JSON.stringify({ name: 'x' }));
    expect(() => readModel(notModel)).toThrow(/no 'entities' object/);

    const tableless = join(dir, 'tableless.json');
    writeFileSync(tableless, JSON.stringify({ entities: { a: { fields: {} } } }));
    expect(() => readModel(tableless)).toThrow(/declares no table/);

    // A list-shaped declaration that is not a list would otherwise surface as a TypeError
    // from inside the layout — which reads as a renderer bug, not as a malformed input.
    for (const bad of [{ parents: 'list' }, { key: [1] }, { erasable: 'email' }, { primaryKey: {} }]) {
      const file = join(dir, `bad-${Object.keys(bad)[0]}.json`);
      writeFileSync(file, JSON.stringify({ entities: { a: { table: 't', fields: {}, ...bad } } }));
      expect(() => readModel(file)).toThrow(/other than a list of field names/);
    }
  });

  it('escapes what it renders', () => {
    const nasty = {
      entities: {
        '<img x>': {
          table: 't',
          fields: { type: 'object', properties: { '"a"': { type: 'string' } }, required: ['"a"'] },
        },
      },
    };
    const html = renderModelHtml(nasty as never, { source: 'x/model.json' });
    expect(html).not.toContain('<img x>');
    expect(html).toContain('&lt;img x&gt;');
  });
});
