import { describe, expect, it } from 'vitest';
import { scopeStoreScriptName, verifyScopeStoreName } from '@substrat-run/contracts';
import { callPlatformScopeStore } from '../src/platform-scope-stores.js';

describe('callPlatformScopeStore', () => {
  it('signs the object name and addresses the kind script as the platform', async () => {
    let seen: { script: string; mac: string; audience: string | null; body: { objectName?: string } } | undefined;
    const dispatch = {
      hmacKey: 'platform-key',
      fetch: async (scriptName: string, request: Request) => {
        seen = {
          script: scriptName,
          mac: request.headers.get('x-substrat-store-mac') ?? '',
          audience: request.headers.get('x-substrat-store-audience'),
          body: (await request.json()) as { objectName?: string },
        };
        return Response.json({ result: { bytes: 4 } });
      },
    };
    await expect(
      callPlatformScopeStore(
        dispatch,
        { vertical: 'acme/crm', kind: 'ontomate', tenantId: 'T', scopeId: 'S', binding: 'GRAPH' },
        'substrat.size',
      ),
    ).resolves.toEqual({ bytes: 4 });
    expect(seen?.script).toBe(scopeStoreScriptName('acme/crm', 'ontomate'));
    expect(seen?.audience).toBe('platform');
    expect(seen?.body.objectName).toBe('T/acme/crm/S/GRAPH');
    expect(await verifyScopeStoreName('platform-key', 'T/acme/crm/S/GRAPH', seen?.mac ?? '')).toBe(true);
  });
});
