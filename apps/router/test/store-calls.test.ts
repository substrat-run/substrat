import { describe, expect, it } from 'vitest';
import { scopeId, scopeStoreObjectName, signScopeStoreName, tenantId } from '@substrat-run/contracts';
import { handleStoreCall } from '../src/store-calls.js';

const TENANT = tenantId.parse('01JTESTATTACHTENANT000000A');
const SCOPE = scopeId.parse('01J00000000000000000000S01');
const OTHER = scopeId.parse('01J00000000000000000000S02');
const KEY = 'router-store-key';

describe('handleStoreCall', () => {
  it('refuses another scope, an undeclared binding, and a reserved operation', async () => {
    const caller = { vertical: 'docs', tenantId: TENANT, scopeId: SCOPE, stores: [{ binding: 'GRAPH', kind: 'graph' }] };
    const other = await handleStoreCall({ STORE_HMAC_KEY: KEY, DISPATCH: { get: () => { throw new Error('not dispatched'); } } }, caller, {
      scopeId: OTHER,
      binding: 'GRAPH',
      operation: 'read',
    });
    expect(other).toMatchObject({ ok: false, status: 403 });
    const missing = await handleStoreCall({ STORE_HMAC_KEY: KEY }, caller, { scopeId: SCOPE, binding: 'BLOBS', operation: 'read' });
    expect(missing).toMatchObject({ ok: false, status: 404 });
    const reserved = await handleStoreCall({ STORE_HMAC_KEY: KEY }, caller, { scopeId: SCOPE, binding: 'GRAPH', operation: 'substrat.wipe' });
    expect(reserved).toMatchObject({ ok: false, status: 403 });
  });

  it('signs the object it addresses and dispatches that kind script', async () => {
    const seen: { script?: string; mac?: string; name?: string } = {};
    const outcome = await handleStoreCall(
      {
        STORE_HMAC_KEY: KEY,
        DISPATCH: {
          get: (scriptName) => ({
            fetch: async (request) => {
              seen.script = scriptName;
              seen.mac = request.headers.get('x-substrat-store-mac') ?? undefined;
              const body = await request.json() as { objectName?: string };
              seen.name = body.objectName;
              return Response.json({ result: 1 });
            },
          }),
        },
      },
      { vertical: 'docs', tenantId: TENANT, scopeId: SCOPE, stores: [{ binding: 'GRAPH', kind: 'graph' }] },
      { scopeId: SCOPE, binding: 'GRAPH', operation: 'read' },
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(seen.script).toBe('substrat-store-graph-docs');
    expect(seen.name).toBe(scopeStoreObjectName(TENANT, 'docs', SCOPE, 'GRAPH'));
    expect(seen.mac).toBe(await signScopeStoreName(KEY, seen.name!));
  });
});
