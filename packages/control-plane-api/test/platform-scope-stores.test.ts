import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCOPE_DUMP_PAGE_MAX_BYTES, scopeStoreScriptName } from '@substrat-run/contracts';
import { verifyScopeStoreCall } from '@substrat-run/contracts/scope-store-envelope';
import { callPlatformScopeStore, platformScopeStoresFor } from '../src/platform-scope-stores.js';

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

  it('asks for pages of the size the registration declares: 900 000 bytes for graph', async () => {
    const { calls, stores } = recording(() => ({ tables: [table([['a']])], next: null, revision: '1' }));
    const exported = await stores.exportStores({ ...target, stores: [{ binding: 'GRAPH', driver: 'graph' }] });
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
    const exported = await stores.exportStores({
      ...target,
      stores: [
        { binding: 'ONE', driver: 'graph' },
        { binding: 'TWO', driver: 'graph' },
      ],
    });
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
    await stores.importStores({
      ...target,
      stores: [{ binding: 'GRAPH', driver: 'graph', tables: [table([[big], [big], [big], [big]])] }],
    });
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
    await stores.exportStores({ ...target, stores: [{ binding: 'X', driver: 'unregistered' }] });
    expect(calls[0]!.input.maxBytes).toBe(SCOPE_DUMP_PAGE_MAX_BYTES);
  });
});
