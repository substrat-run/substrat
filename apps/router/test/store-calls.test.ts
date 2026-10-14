import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  parseScopeStoreEnvelope,
  scopeId,
  scopeStoreBodyDigest,
  scopeStoreObjectName,
  tenantId,
  verifyScopeStoreEnvelope,
} from '@substrat-run/contracts';
import { handleStoreCall } from '../src/store-calls.js';

const TENANT = tenantId.parse('01JTESTATTACHTENANT000000A');
const SCOPE = scopeId.parse('01J00000000000000000000S01');
const OTHER = scopeId.parse('01J00000000000000000000S02');
const vector = JSON.parse(
  readFileSync(new URL('../../../packages/contracts/test/vectors/scope-store-envelope.json', import.meta.url), 'utf8'),
) as { privateKeyPkcs8: string; publicKey: string };
const KEY = vector.privateKeyPkcs8;

describe('handleStoreCall', () => {
  it('refuses another scope, an undeclared binding, and a reserved operation', async () => {
    const caller = { vertical: 'docs', tenantId: TENANT, scopeId: SCOPE, stores: [{ binding: 'GRAPH', kind: 'graph' }] };
    const other = await handleStoreCall({ STORE_CALLER_KEY: KEY, DISPATCH: { get: () => { throw new Error('not dispatched'); } } }, caller, {
      scopeId: OTHER,
      binding: 'GRAPH',
      operation: 'read',
    });
    expect(other).toMatchObject({ ok: false, status: 403 });
    const missing = await handleStoreCall({ STORE_CALLER_KEY: KEY }, caller, { scopeId: SCOPE, binding: 'BLOBS', operation: 'read' });
    expect(missing).toMatchObject({ ok: false, status: 404 });
    const reserved = await handleStoreCall({ STORE_CALLER_KEY: KEY }, caller, { scopeId: SCOPE, binding: 'GRAPH', operation: 'substrat.wipe' });
    expect(reserved).toMatchObject({ ok: false, status: 403 });
  });

  it('signs an envelope over the body it sends and dispatches that kind script', async () => {
    const seen: { script?: string; canonical?: string; signature?: string; name?: string; raw?: string } = {};
    const outcome = await handleStoreCall(
      {
        STORE_CALLER_KEY: KEY,
        DISPATCH: {
          get: (scriptName) => ({
            fetch: async (request) => {
              seen.script = scriptName;
              seen.raw = await request.text();
              const header = request.headers.get('x-substrat-store-envelope') ?? '';
              seen.signature = request.headers.get('x-substrat-store-signature') ?? '';
              seen.canonical = new TextDecoder().decode(base64UrlToBytes(header) ?? new Uint8Array());
              seen.name = (JSON.parse(seen.raw) as { objectName?: string }).objectName;
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
    const envelope = parseScopeStoreEnvelope(seen.canonical ?? '');
    expect(envelope).toMatchObject({ aud: 'caller', name: seen.name, op: 'read' });
    expect(envelope?.digest).toBe(await scopeStoreBodyDigest(seen.raw ?? ''));
    expect(await verifyScopeStoreEnvelope(vector.publicKey, seen.canonical ?? '', seen.signature ?? '')).toBe(true);
  });
});
