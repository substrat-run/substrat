import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorCodeOf, type StoreRequest, type StoreResponse } from '@substrat-run/contracts';
import type { ScopeStoreRunner } from '@substrat-run/kernel';
import { attributeUri, PART_URI } from '../src/spec.js';
import { buildWorld, type World } from './world.js';

/**
 * A stand-in for the graph store that answers the calls this vertical makes, in the store's
 * shapes, and records each one. `answer` overrides one operation for one test.
 */
function fakeGraph() {
  const calls: StoreRequest[] = [];
  const notes = new Map<string, { uri: string; title: string; body?: string }>();
  let installed = false;
  const overrides = new Map<string, (input: Record<string, unknown>) => StoreResponse>();
  const runner: ScopeStoreRunner = {
    driver: 'graph',
    async start() {},
    async stop() {},
    async invoke(_address, request) {
      calls.push(request);
      const input = (request.input ?? {}) as Record<string, unknown>;
      const override = overrides.get(request.operation);
      if (override) return override(input);
      switch (request.operation) {
        case 'putScope':
          return { result: { level: input.level, readRevision: null } };
        case 'putPackageUpload':
          return { result: { partId: input.partId, version: input.version, digest: 'sha256:0' } };
        case 'postPackageInstallation': {
          const already = installed;
          installed = true;
          return { result: { ok: true, parts: [{ alreadyInstalled: already }] } };
        }
        case 'postDataBatch': {
          const [command] = input.commands as { title: string; body?: string }[];
          const uri = `https://id.example.org/note/${notes.size + 1}`;
          notes.set(uri, { uri, title: command!.title, ...(command!.body === undefined ? {} : { body: command!.body }) });
          return { result: { outcome: 'committed', commands: [{ uri }], issues: [] } };
        }
        case 'listDataInstances':
          return { result: { items: [...notes.values()], totalCount: notes.size, nextCursor: null } };
        case 'getDataInstance': {
          const note = notes.get(input.uri as string);
          return note ? { result: note } : { error: { code: 'data.resource-not-found', status: 404 } };
        }
        default:
          return { error: { code: 'unknown_operation', status: 400 } };
      }
    },
  };
  return { runner, calls, overrides };
}

describe('graph notes over a scope store', () => {
  const graph = fakeGraph();
  let world: World;
  beforeAll(async () => {
    world = await buildWorld(graph.runner);
  });
  afterAll(async () => {
    await world.close();
  });
  beforeEach(() => {
    graph.calls.length = 0;
    graph.overrides.clear();
  });

  it('installs the notes part once, and a second install says it already was', async () => {
    expect(await world.notes.installSchema(world.admin)).toEqual({ alreadyInstalled: false });
    expect(await world.notes.installSchema(world.admin)).toEqual({ alreadyInstalled: true });
    expect(graph.calls.map((c) => c.operation)).toEqual([
      'putPackageUpload', 'postPackageInstallation', 'putPackageUpload', 'postPackageInstallation',
    ]);
  });

  it('writes a note in a session it first scoped to the notes part, and reads it back', async () => {
    const note = await world.notes.createNote(world.writer, { title: 'First', body: 'in the graph' });
    const [scoped, written] = graph.calls;
    expect(scoped).toEqual({
      operation: 'putScope',
      input: {
        session: expect.any(String),
        level: 1,
        sessionVariables: { 'package-management': { schemaParts: [PART_URI], dataParts: [PART_URI] } },
      },
    });
    expect(written?.operation).toBe('postDataBatch');
    expect((written?.input as { session: string }).session).toBe((scoped?.input as { session: string }).session);

    expect(await world.notes.readNote(world.reader, note.uri)).toEqual({ uri: note.uri, title: 'First', body: 'in the graph' });
    expect(await world.notes.listNotes(world.reader)).toEqual({ notes: [note], total: 1, nextCursor: null });
    // Every store call names a session, and no two actions share one.
    const sessions = graph.calls.map((c) => (c.input as { session?: unknown }).session);
    expect(sessions.every((s) => typeof s === 'string')).toBe(true);
    expect(new Set(sessions).size).toBe(3);

    // The store reads the next page `after` the cursor; any other name is a bare `bad_input`.
    await world.notes.listNotes(world.reader, { limit: 1, cursor: 'c1' });
    expect(graph.calls.at(-1)?.input).toMatchObject({ type: 'Note', limit: 1, after: 'c1' });
  });

  it('refuses an action the caller’s role lacks before anything reaches the store', async () => {
    for (const refused of [
      () => world.notes.createNote(world.reader, { title: 'Nope' }),
      () => world.notes.installSchema(world.writer),
    ]) {
      expect(errorCodeOf(await refused().catch((err: unknown) => err))).toBe('permission_denied');
    }
    expect(graph.calls).toEqual([]);
  });

  it('refuses a note the store finds invalid, naming the attribute each issue is about', async () => {
    graph.overrides.set('postDataBatch', () => ({
      result: {
        outcome: 'invalid',
        commands: [{ uri: 'https://id.example.org/note/x' }],
        issues: [{ code: 'assertion.required-group-missing', message: 'missing', field: null, relatedUri: attributeUri('title') }],
      },
    }));
    const refusal = await world.notes.createNote(world.writer, { title: 'Bad' }).catch((err: unknown) => err);
    expect(errorCodeOf(refusal)).toBe('validation_failed');
    expect(refusal).toMatchObject({ extensions: { errors: [{ path: 'title', message: 'assertion.required-group-missing: missing' }] } });
  });

  it('passes a store refusal on with the store’s own code', async () => {
    const refusal = await world.notes.readNote(world.reader, 'https://id.example.org/note/none').catch((err: unknown) => err);
    expect(errorCodeOf(refusal)).toBe('not_found');
    expect(refusal).toMatchObject({ storeCode: 'data.resource-not-found' });
  });
});
