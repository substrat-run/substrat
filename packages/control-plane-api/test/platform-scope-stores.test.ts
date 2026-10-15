import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scopeStoreScriptName } from '@substrat-run/contracts';
import { verifyScopeStoreCall } from '@substrat-run/contracts/scope-store-envelope';
import { callPlatformScopeStore } from '../src/platform-scope-stores.js';

const vector = JSON.parse(
  readFileSync(new URL('../../contracts/test/vectors/scope-store-envelope.json', import.meta.url), 'utf8'),
) as { privateKeyPkcs8: string; publicKey: string };

describe('callPlatformScopeStore', () => {
  it('signs an envelope as the platform and addresses the kind script', async () => {
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
        { vertical: 'acme/crm', kind: 'graph', tenantId: 'T', scopeId: 'S', binding: 'GRAPH' },
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
