import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  scopeId,
  scopeStoreObjectName,
  tenantId,
} from '@substrat-run/contracts';
import { generateScopeStoreKeyPair, verifyScopeStoreCall } from '@substrat-run/contracts/scope-store-envelope';
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
    const caller = { vertical: 'docs', tenantId: TENANT, scopeId: SCOPE, stores: [{ binding: 'GRAPH', driver: 'graph' }] };
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

  it('signs an envelope over the body it sends and dispatches that driver script', async () => {
    const seen: { script?: string; header?: string; signature?: string; name?: string; raw?: string } = {};
    const outcome = await handleStoreCall(
      {
        STORE_CALLER_KEY: KEY,
        DISPATCH: {
          get: (scriptName) => ({
            fetch: async (request) => {
              seen.script = scriptName;
              seen.raw = await request.text();
              seen.header = request.headers.get('x-substrat-store-envelope') ?? '';
              seen.signature = request.headers.get('x-substrat-store-signature') ?? '';
              seen.name = (JSON.parse(seen.raw) as { objectName?: string }).objectName;
              return Response.json({ result: 1 });
            },
          }),
        },
      },
      { vertical: 'docs', tenantId: TENANT, scopeId: SCOPE, stores: [{ binding: 'GRAPH', driver: 'graph' }] },
      { scopeId: SCOPE, binding: 'GRAPH', operation: 'read' },
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(seen.script).toBe('substrat-store-graph-docs');
    expect(seen.name).toBe(scopeStoreObjectName(TENANT, 'docs', SCOPE, 'GRAPH'));
    // The store this was addressed to admits it, as the verifier every store entry runs.
    const verdict = await verifyScopeStoreCall({
      envelope: seen.header,
      signature: seen.signature,
      body: seen.raw ?? '',
      keys: { caller: [vector.publicKey], platform: [] },
      script: seen.script ?? '',
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(verdict).toMatchObject({ ok: true, envelope: { aud: 'caller', script: 'substrat-store-graph-docs', name: seen.name, op: 'read' } });
  });
});

describe('handleStoreCall without a usable key (#2287)', () => {
  const caller = { vertical: 'docs', tenantId: TENANT, scopeId: SCOPE, stores: [{ binding: 'GRAPH', driver: 'graph' }] };
  const dispatch = { get: () => { throw new Error('not dispatched'); } };
  const request = { scopeId: SCOPE, binding: 'GRAPH', operation: 'read' };

  it('refuses with 503 and logs whether the key is absent or set but unusable, never the key', async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)); });
    try {
      const pair = await generateScopeStoreKeyPair();
      expect(await handleStoreCall({ DISPATCH: dispatch }, caller, request)).toMatchObject({ ok: false, status: 503 });
      // A raw public key pasted where the PKCS8 private key belongs.
      expect(await handleStoreCall({ STORE_CALLER_KEY: pair.publicKey, DISPATCH: dispatch }, caller, request)).toMatchObject({ ok: false, status: 503 });
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatch(/is not set/);
      expect(warnings[1]).toMatch(/set but unusable/);
      expect(warnings.join('\n')).not.toContain(pair.publicKey);
    } finally {
      warn.mockRestore();
    }
  });
});
