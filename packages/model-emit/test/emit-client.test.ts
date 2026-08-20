/**
 * The Zod→TypeScript printer, tested against schemas directly.
 *
 * This exists because `pnpm lint:client --check` cannot catch what is wrong here.
 * That gate re-emits and compares, so it catches a client that fell BEHIND its
 * model — the drift that left demos/todo unable to page or search for two
 * releases. It cannot catch a printer that has been confidently mis-spelling
 * `z.array(z.union([...]))` since the day it was written: the emitted file and the
 * re-emitted file agree perfectly, and both are wrong.
 *
 * So the assertions are exact strings, for the same reason `emit-sql.test.ts`
 * gives: what this emits reaches a browser as the only type an app has for its own
 * API, and a change in it should be impossible to make without seeing it here.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities, defineOperations } from '@substrat-run/contracts';
import { ClientEmitError, methodName, renderClient, tsTypeOf } from '../src/index.js';

describe('printing a schema', () => {
  it('spells the primitives', () => {
    expect(tsTypeOf(z.string())).toBe('string');
    expect(tsTypeOf(z.number())).toBe('number');
    expect(tsTypeOf(z.boolean())).toBe('boolean');
    expect(tsTypeOf(z.bigint())).toBe('bigint');
    expect(tsTypeOf(z.unknown())).toBe('unknown');
  });

  it('ignores refinements — a checked string is still a string', () => {
    // `.email()` narrows what the SERVER accepts, not what TypeScript can say.
    expect(tsTypeOf(z.string().email())).toBe('string');
    expect(tsTypeOf(z.number().int().positive().max(200))).toBe('number');
  });

  it('looks through a brand', () => {
    // `moneyAmount` is `z.string().regex(…).brand<'MoneyAmount'>()`. A brand is a
    // type-level marker with no runtime wrapper, and the client cannot carry it.
    expect(tsTypeOf(z.string().regex(/^\d+$/).brand<'MoneyAmount'>())).toBe('string');
  });

  it('takes a pipe from its INPUT side, which is what a caller supplies', () => {
    expect(tsTypeOf(z.coerce.number())).toBe('number');
  });
});

describe('optionality', () => {
  it('spells an optional property `a?: T`, never `a?: T | undefined`', () => {
    // Both halves say the same thing, and printing both reads as though they might
    // differ. This regressed once during development and nothing else would catch it.
    expect(tsTypeOf(z.object({ limit: z.number().optional() }))).toBe('{ limit?: number }');
  });

  it('keeps `| null` on a property, because null is a value the server can send', () => {
    expect(tsTypeOf(z.object({ note: z.string().nullable() }))).toBe('{ note: string | null }');
    expect(tsTypeOf(z.object({ note: z.string().nullish() }))).toBe('{ note?: string | null }');
  });

  it('treats a defaulted field as optional TO THE CALLER', () => {
    // `startConditionReportInput.templateKey` is exactly this: the caller may omit it
    // and the handler fills it in, so a required property would be a lie.
    expect(tsTypeOf(z.object({ key: z.string().default('x') }))).toBe('{ key?: string }');
  });

  it('spells optionality with no key to hang it on as a union', () => {
    expect(tsTypeOf(z.array(z.string().optional()))).toBe('(string | undefined)[]');
  });
});

describe('composites', () => {
  it('parenthesises a union inside an array', () => {
    // `A | B[]` and `(A | B)[]` are different types, and the second is the one meant.
    expect(tsTypeOf(z.array(z.union([z.string(), z.number()])))).toBe('(string | number)[]');
  });

  it('parenthesises an object inside an array', () => {
    expect(tsTypeOf(z.array(z.object({ id: z.string() })))).toBe('{ id: string }[]');
  });

  it('spells a record', () => {
    expect(tsTypeOf(z.record(z.string(), z.number()))).toBe('Record<string, number>');
  });

  it('spells an enum and a literal as a union of literals', () => {
    expect(tsTypeOf(z.enum(['open', 'closed']))).toBe('"open" | "closed"');
    expect(tsTypeOf(z.literal('workorder'))).toBe('"workorder"');
    expect(tsTypeOf(z.literal(3))).toBe('3');
  });

  it('de-duplicates a union', () => {
    expect(tsTypeOf(z.union([z.string(), z.string(), z.number()]))).toBe('string | number');
  });

  it('spells a discriminated union as its arms', () => {
    const content = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('checklist'), sections: z.array(z.string()) }),
      z.object({ kind: z.literal('document'), documentType: z.string() }),
    ]);
    expect(tsTypeOf(content)).toBe(
      '{ kind: "checklist"; sections: string[] } | { kind: "document"; documentType: string }',
    );
  });

  it('spells an empty object as Record<string, never>', () => {
    // `{}` in TypeScript means "anything but null", which is the opposite of the truth.
    expect(tsTypeOf(z.object({}))).toBe('Record<string, never>');
  });

  it('nests', () => {
    expect(tsTypeOf(z.object({ a: z.object({ b: z.array(z.boolean()) }) }))).toBe(
      '{ a: { b: boolean[] } }',
    );
  });
});

describe('naming a schema', () => {
  const item = z.object({ id: z.string(), text: z.string() });

  it('prints a named schema by IDENTITY, not by shape', () => {
    const named = new Map<unknown, string>([[item, 'Item']]);
    expect(tsTypeOf(item, named)).toBe('Item');
    expect(tsTypeOf(z.array(item), named)).toBe('Item[]');
    expect(tsTypeOf(z.object({ results: z.array(item) }), named)).toBe('{ results: Item[] }');
  });

  it('leaves a structurally identical schema inline', () => {
    // Two entities that happen to share a shape stay two names, and an inline object
    // that happens to match an entity stays inline — which is what the model said.
    const named = new Map<unknown, string>([[item, 'Item']]);
    const lookalike = z.object({ id: z.string(), text: z.string() });
    expect(tsTypeOf(lookalike, named)).toBe('{ id: string; text: string }');
  });
});

describe('refusing what it cannot spell', () => {
  it('raises rather than answering `unknown`', () => {
    // `z.preprocess` infers an input of `unknown` BY CONSTRUCTION — which is why
    // engine-protocol hand-writes `ProtocolTemplateContentInput` beside it. A
    // generator that answered `unknown` here would hand the app a green light over a
    // type it never checked.
    const preprocessed = z.preprocess((v) => v, z.object({ kind: z.string() }));
    expect(() => tsTypeOf(preprocessed)).toThrow(ClientEmitError);
  });

  it('names the field, so the diagnostic points at the model', () => {
    const preprocessed = z.preprocess((v) => v, z.string());
    expect(() => tsTypeOf(z.object({ content: preprocessed }))).toThrow(/schema\.content/);
  });
});

describe('naming a client method', () => {
  it('drops the vertical’s own prefix and camel-cases the rest', () => {
    expect(methodName('todo/create-list', 'todo')).toBe('createList');
    expect(methodName('bike-shop/start-condition-report', 'bike-shop')).toBe('startConditionReport');
  });

  it('KEEPS a composed engine’s prefix', () => {
    // Callout binds workorder/get, protocol/get and invoicing/get at three URLs. A
    // client with one `get()` would reach whichever bag was read last, and renaming an
    // engine's operation to suit a vertical's client is not a vertical's call.
    expect(methodName('workorder/get', 'callout')).toBe('workorderGet');
    expect(methodName('protocol/get', 'callout')).toBe('protocolGet');
    expect(methodName('invoicing/export', 'callout')).toBe('invoicingExport');
  });
});

// ---------------------------------------------------------------------------
// The whole client.
// ---------------------------------------------------------------------------

const entities = defineEntities({
  note: {
    table: 'demo_notes',
    fields: z.object({
      id: z.string(),
      body: z.string(),
      pinned: z.number(),
      created_at: z.string(),
    }),
  },
});

const operations = defineOperations(entities, ['note:write'] as const)({
  'demo/create-note': {
    summary: 'Write a note',
    permission: 'note:write',
    input: z.object({ body: z.string() }),
    output: entities.note.fields,
    http: { method: 'POST', path: '/notes' },
  },
  'demo/list-notes': {
    summary: 'The notes',
    permission: 'note:write',
    input: z.object({ limit: z.number().int().optional(), cursor: z.string().optional() }),
    output: entities.note.fields,
    paged: { sortKey: 'id', total: true },
    http: { method: 'GET', path: '/notes' },
  },
  'demo/pin-note': {
    summary: 'Pin a note',
    permission: 'note:write',
    input: z.object({ noteId: z.string(), pinned: z.boolean() }),
    output: entities.note.fields,
    http: { method: 'POST', path: '/notes/{noteId}/pin' },
  },
});

const config = {
  model: 'model.ts',
  entities: 'entities',
  operations: 'operations',
  out: 'api.generated.ts',
  name: 'Demo',
} as const;

const render = (ops: Record<string, unknown> = operations) =>
  renderClient('demos/demo', config, 'model.ts', entities, ops, {});

describe('rendering a client', () => {
  const out = render();

  it('declares an interface per entity, from its fields', () => {
    expect(out).toContain(
      'export interface Note {\n  id: string;\n  body: string;\n  pinned: number;\n  created_at: string;\n}',
    );
  });

  it('types a method from the operation’s own input and output', () => {
    expect(out).toContain('createNote(input: { body: string }): Promise<Note>;');
  });

  it('wraps a paged read, and only a paged read', () => {
    expect(out).toContain(
      'listNotes(input: { limit?: number; cursor?: string }): Promise<Paged<Note>>;',
    );
    expect(out).toContain('export interface Paged<T>');
    expect(out).toContain('follow<T>(next: string): Promise<Paged<T>>;');
  });

  it('carries the summary and the route into the doc comment', () => {
    expect(out).toContain('* `POST /notes/{noteId}/pin` — `demo/pin-note`');
  });

  it('sends a write’s remaining fields as a BODY and a read’s as a QUERY', () => {
    // Which side a field lands on is not cosmetic: it has to match what
    // `mountOperations` reads on the other end, which is the only reason this is
    // derivable at all.
    expect(out).toContain('send("/notes", "POST", input, undefined)');
    expect(out).toContain('send(`/notes/${encodeURIComponent(String(input.noteId))}/pin`, "POST", omit(input, ["noteId"]), undefined)');
    expect(out).toContain('page("/notes", "GET", undefined, input)');
  });

  it('emits no imports at all', () => {
    // The app is a separate Vite package that depends on neither contracts nor zod.
    expect(out).not.toMatch(/^\s*import\s/m);
  });

  it('names the producer and the source in a header', () => {
    expect(out.split('\n')[0]).toBe(
      '// GENERATED by tools/client-emit.mts from model.ts — do not edit by hand.',
    );
  });

  it('is deterministic — the same model renders the same bytes', () => {
    expect(render()).toBe(out);
  });
});

describe('what rendering refuses', () => {
  it('does NOT collide across modules — that is what the engine prefix is for', () => {
    const out = render({
      'demo/get': operations['demo/create-note'],
      'other/get': operations['demo/create-note'],
    });
    expect(out).toContain('get(input: { body: string }): Promise<Note>;');
    expect(out).toContain('otherGet(input: { body: string }): Promise<Note>;');
  });

  it('refuses two operations of the SAME module that share a method name', () => {
    // The one collision the prefix cannot resolve, and the only one left worth
    // refusing: two spellings of one name in one module reach the same call site.
    expect(() =>
      render({
        'demo/pin-note': operations['demo/pin-note'],
        'demo/pinNote': operations['demo/pin-note'],
      }),
    ).toThrow(/both name the client method `pinNote`/);
  });

  it('refuses a client over no bound operation at all', () => {
    expect(() => render({})).toThrow(/no operation declares an `http` binding/);
  });

  it('refuses an override that is never reached', () => {
    // A stale escape hatch reads as a live decision. It is the one kind of config
    // entry that is worse than absent.
    expect(() =>
      renderClient(
        'demos/demo',
        { ...config, types: { 'demo/create-note.input.nope': 'unknown' } },
        'model.ts',
        entities,
        operations,
        {},
      ),
    ).toThrow(/never reached/);
  });

  it('uses an override that IS reached, and records it in the artifact', () => {
    const withOverride = renderClient(
      'demos/demo',
      { ...config, types: { 'demo/create-note.input.body': 'string | string[]' } },
      'model.ts',
      entities,
      operations,
      {},
    );
    expect(withOverride).toContain('createNote(input: { body: string | string[] }): Promise<Note>;');
    // The decision belongs in the diff, not in a tool's memory.
    expect(withOverride).toContain('// HAND-STATED TYPES (substrat.client.types)');
    expect(withOverride).toContain('//   demo/create-note.input.body → string | string[]');
  });
});
