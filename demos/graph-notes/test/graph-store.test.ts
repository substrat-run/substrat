import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import { loopbackRunner } from './loopback-runner.js';
import { buildWorld, type World } from './world.js';

/**
 * The same actions against the real graph store: its local process, started by hand and named
 * by `GRAPH_STORE_URL` (see the vertical's page in the docs). Opt in, since that process is the
 * driver's code, in the driver's own repository, and no CI job here runs it. Each run is a fresh
 * tenant and scope, so a process kept running between runs starts every run with an empty store.
 */
const url = process.env.GRAPH_STORE_URL;

describe.runIf(url)('graph notes against the graph store’s local process (opt in: GRAPH_STORE_URL)', () => {
  let world: World;
  beforeAll(async () => {
    world = await buildWorld(loopbackRunner('graph', url!));
    await world.notes.installSchema(world.admin);
  });
  afterAll(async () => {
    await world?.close();
  });

  it('installs the notes part idempotently', async () => {
    expect(await world.notes.installSchema(world.admin)).toEqual({ alreadyInstalled: true });
  });

  it('writes notes, pages through them and reads one back', async () => {
    const first = await world.notes.createNote(world.writer, { title: 'First', body: 'kept in the graph' });
    const second = await world.notes.createNote(world.writer, { title: 'Second' });

    const one = await world.notes.listNotes(world.reader, { limit: 1 });
    expect(one.total).toBe(2);
    expect(one.nextCursor).not.toBeNull();
    const rest = await world.notes.listNotes(world.reader, { limit: 1, cursor: one.nextCursor! });
    expect([...one.notes, ...rest.notes].map((n) => n.uri).sort()).toEqual([first.uri, second.uri].sort());

    expect(await world.notes.readNote(world.reader, second.uri)).toEqual({ uri: second.uri, title: 'Second', body: null });
  });

  it('answers an unknown note with the store’s own code', async () => {
    const refusal = await world.notes
      .readNote(world.reader, 'https://id.example.org/ontomate/resource/01JZ0000000000000000000000')
      .catch((err: unknown) => err);
    expect(errorCodeOf(refusal)).toBe('not_found');
    expect(refusal).toMatchObject({ storeCode: 'data.resource-not-found' });
  });
});
