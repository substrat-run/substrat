import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCOPE_DUMP_PAGE_MAX_BYTES, STORE_CALL_MAX_BYTES, scopeStoreBodyBytes, scopeStoreScriptName } from '@substrat-run/contracts';
import { verifyScopeStoreCall } from '@substrat-run/contracts/scope-store-envelope';
import { callPlatformScopeStore, callPlatformScopeStoreAt, platformScopeStoresFor } from '../src/platform-scope-stores.js';
import { importWholeStores } from '../src/store-move-ends.js';
import { readStoreForBody } from '../src/store-pull.js';

const vector = JSON.parse(
  readFileSync(new URL('../../contracts/test/vectors/scope-store-envelope.json', import.meta.url), 'utf8'),
) as { privateKeyPkcs8: string; publicKey: string };

describe('callPlatformScopeStore', () => {
  it('signs an envelope as the platform and addresses the driver script', async () => {
    let seen: { script: string; header: string; signature: string; raw: string; body: { objectName?: string } } | undefined;
    const dispatch = {
      platformKey: vector.privateKeyPkcs8,
      fetch: async (scriptName: string, request: Request) => {
        const raw = await request.text();
        seen = {
          script: scriptName,
          header: request.headers.get('x-substrat-store-envelope') ?? '',
          signature: request.headers.get('x-substrat-store-signature') ?? '',
          raw,
          body: JSON.parse(raw) as { objectName?: string },
        };
        return Response.json({ result: { bytes: 4 } });
      },
    };
    await expect(
      callPlatformScopeStore(
        dispatch,
        { vertical: 'acme/crm', driver: 'graph', tenantId: 'T', scopeId: 'S', binding: 'GRAPH' },
        'substrat.size',
      ),
    ).resolves.toEqual({ bytes: 4 });
    expect(seen?.script).toBe(scopeStoreScriptName('acme/crm', 'graph'));
    expect(seen?.body.objectName).toBe('T/acme/crm/S/GRAPH');
    // The store this was addressed to admits it, as the verifier every store entry runs.
    const verdict = await verifyScopeStoreCall({
      envelope: seen?.header,
      signature: seen?.signature,
      body: seen?.raw ?? '',
      keys: { caller: [], platform: [vector.publicKey] },
      script: seen?.script ?? '',
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(verdict).toMatchObject({
      ok: true,
      envelope: { aud: 'platform', script: scopeStoreScriptName('acme/crm', 'graph'), name: 'T/acme/crm/S/GRAPH', op: 'substrat.size' },
    });
  });
});

describe('platformScopeStoresFor moves a store in pages the driver declared (D-69)', () => {
  const target = { tenantId: 'T', scopeId: 'S', vertical: 'acme/crm' };
  const table = (rows: unknown[][]) => ({ name: 'nodes', ddl: 'CREATE TABLE nodes (a TEXT)', columns: ['a'], rows });

  /** A store that answers an empty page and records each call it is sent. */
  function recording(answer: (operation: string, input: any) => unknown) {
    const calls: { operation: string; input: any; objectName: string }[] = [];
    const dispatch = {
      platformKey: vector.privateKeyPkcs8,
      fetch: async (_script: string, request: Request) => {
        const body = JSON.parse(await request.text()) as { operation: string; input?: unknown; objectName: string };
        calls.push({ operation: body.operation, input: body.input, objectName: body.objectName });
        return Response.json({ result: answer(body.operation, body.input) });
      },
    };
    return { calls, stores: platformScopeStoresFor(dispatch) };
  }
  type Stores = ReturnType<typeof platformScopeStoresFor>;
  const exportOf = async (stores: Stores, list: { binding: string; driver: string }[]) => {
    const budget = { left: 32_000_000, limit: 32_000_000 };
    const exported = [];
    for (const store of list) {
      exported.push({ ...store, tables: await readStoreForBody(stores.callStore({ ...target, ...store }), store, target.scopeId, budget) });
    }
    return exported;
  };

  it('asks for pages of the size the registration declares: 900 000 bytes for graph', async () => {
    const { calls, stores } = recording(() => ({ tables: [table([['a']])], next: null, revision: '1' }));
    const exported = await exportOf(stores, [{ binding: 'GRAPH', driver: 'graph' }]);
    expect(exported).toEqual([{ binding: 'GRAPH', driver: 'graph', tables: [table([['a']])] }]);
    expect(calls.map((c) => [c.operation, c.input])).toEqual([['substrat.export-page', { cursor: null, maxBytes: 900_000 }]]);
  });

  it('follows the chain to its end, one binding at a time, and merges the pages', async () => {
    const pages = [
      { tables: [table([['a']])], next: 'c1', revision: '1' },
      { tables: [table([['b']])], next: null, revision: '1' },
    ];
    let served = 0;
    const { calls, stores } = recording(() => pages[served++ % 2]);
    const exported = await exportOf(stores, [
      { binding: 'ONE', driver: 'graph' },
      { binding: 'TWO', driver: 'graph' },
    ]);
    expect(exported.map((s) => [s.binding, s.tables[0]!.rows])).toEqual([
      ['ONE', [['a'], ['b']]],
      ['TWO', [['a'], ['b']]],
    ]);
    expect(calls.map((c) => c.input.cursor)).toEqual([null, 'c1', null, 'c1']);
    expect(calls.map((c) => c.objectName)).toEqual(['T/acme/crm/S/ONE', 'T/acme/crm/S/ONE', 'T/acme/crm/S/TWO', 'T/acme/crm/S/TWO']);
  });

  it('imports as a stage of pages within the declared size, then one commit', async () => {
    const big = 'x'.repeat(400_000);
    const { calls, stores } = recording((operation) => (operation === 'substrat.commit-stage' ? { tables: 1 } : { staged: true }));
    await importWholeStores(stores, target, [{ binding: 'GRAPH', driver: 'graph', tables: [table([[big], [big], [big], [big]])] }]);
    expect(calls.map((c) => c.operation)).toEqual([
      ...calls.slice(0, -1).map(() => 'substrat.stage-page'),
      'substrat.commit-stage',
    ]);
    const staged = calls.slice(0, -1);
    expect(staged.length).toBeGreaterThan(1);
    expect(staged.map((c) => c.input.seq)).toEqual(staged.map((_, i) => i));
    for (const call of staged) expect(JSON.stringify(call.input.tables).length).toBeLessThanOrEqual(900_000);
    expect(staged.flatMap((c) => c.input.tables.flatMap((t: { rows: unknown[] }) => t.rows))).toHaveLength(4);
  });

  it('asks a driver the registry does not hold for no more than a scope page', async () => {
    const { calls, stores } = recording(() => ({ tables: [table([])], next: null, revision: '1' }));
    await exportOf(stores, [{ binding: 'X', driver: 'unregistered' }]);
    expect(calls[0]!.input.maxBytes).toBe(SCOPE_DUMP_PAGE_MAX_BYTES);
  });
});

describe('the platform refuses a call body over the limit before it signs (#2811)', () => {
  const target = { scriptName: scopeStoreScriptName('acme/crm', 'graph'), objectName: 'T/acme/crm/S/GRAPH' };
  const dispatchOf = (sent: Request[]) => ({
    platformKey: vector.privateKeyPkcs8,
    fetch: async (_script: string, request: Request) => {
      sent.push(request);
      return Response.json({ result: { staged: true } });
    },
  });
  /** A stage-page input whose whole call body is `bytes` UTF-8 bytes, non-ASCII included. */
  const stageOf = (bytes: number) => {
    const body = (pad: string) =>
      JSON.stringify({ operation: 'substrat.stage-page', input: { stageId: 's', seq: 0, tables: [{ name: 't', ddl: 'd', columns: ['a'], rows: [[pad]] }] }, objectName: target.objectName });
    const base = scopeStoreBodyBytes(body(''));
    // 'é' is two bytes: use pairs and fill an odd remainder with one ASCII character.
    const pad = 'é'.repeat(Math.floor((bytes - base) / 2)) + 'x'.repeat((bytes - base) % 2);
    expect(scopeStoreBodyBytes(body(pad))).toBe(bytes);
    return { stageId: 's', seq: 0, tables: [{ name: 't', ddl: 'd', columns: ['a'], rows: [[pad]] }] };
  };

  it('answers 413 and sends nothing for a body one byte over', async () => {
    const sent: Request[] = [];
    await expect(callPlatformScopeStoreAt(dispatchOf(sent), target, 'substrat.stage-page', stageOf(STORE_CALL_MAX_BYTES + 1))).rejects.toMatchObject({
      status: 413,
      message: expect.stringContaining(`over the limit of ${STORE_CALL_MAX_BYTES}`),
    });
    expect(sent).toHaveLength(0);
  });

  it('sends a body at the limit, signed over exactly those bytes', async () => {
    const sent: Request[] = [];
    await expect(callPlatformScopeStoreAt(dispatchOf(sent), target, 'substrat.stage-page', stageOf(STORE_CALL_MAX_BYTES))).resolves.toEqual({ staged: true });
    expect(sent).toHaveLength(1);
    const raw = await sent[0]!.text();
    expect(scopeStoreBodyBytes(raw)).toBe(STORE_CALL_MAX_BYTES);
    const verdict = await verifyScopeStoreCall({
      envelope: sent[0]!.headers.get('x-substrat-store-envelope'),
      signature: sent[0]!.headers.get('x-substrat-store-signature'),
      body: raw,
      keys: { caller: [], platform: [vector.publicKey] },
      script: target.scriptName,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(verdict.ok).toBe(true);
  });

  it('counts bytes, not characters: a body of 4 000 000 two-byte characters is over', async () => {
    const sent: Request[] = [];
    const pad = 'é'.repeat(3_000_000);
    await expect(
      callPlatformScopeStoreAt(dispatchOf(sent), target, 'substrat.stage-page', { stageId: 's', seq: 0, tables: [{ name: 't', ddl: 'd', columns: ['a'], rows: [[pad]] }] }),
    ).rejects.toMatchObject({ status: 413 });
    expect(sent).toHaveLength(0);
  });

  it("reads a store entry's own 413 as a 413, not a 5xx", async () => {
    const entry = { code: 'payload_too_large', status: 413, body: { limit: STORE_CALL_MAX_BYTES } };
    const dispatch = { platformKey: vector.privateKeyPkcs8, fetch: async () => Response.json({ error: entry }, { status: 413 }) };
    await expect(callPlatformScopeStoreAt(dispatch, target, 'substrat.size')).rejects.toMatchObject({ status: 413 });
  });
});
