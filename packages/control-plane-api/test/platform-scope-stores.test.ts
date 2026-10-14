import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  parseScopeStoreEnvelope,
  scopeStoreBodyDigest,
  scopeStoreScriptName,
  verifyScopeStoreEnvelope,
} from '@substrat-run/contracts';
import { callPlatformScopeStore } from '../src/platform-scope-stores.js';

const vector = JSON.parse(
  readFileSync(new URL('../../contracts/test/vectors/scope-store-envelope.json', import.meta.url), 'utf8'),
) as { privateKeyPkcs8: string; publicKey: string };

describe('callPlatformScopeStore', () => {
  it('signs an envelope as the platform and addresses the kind script', async () => {
    let seen: { script: string; canonical: string; signature: string; raw: string; body: { objectName?: string } } | undefined;
    const dispatch = {
      platformKey: vector.privateKeyPkcs8,
      fetch: async (scriptName: string, request: Request) => {
        const raw = await request.text();
        const header = request.headers.get('x-substrat-store-envelope') ?? '';
        seen = {
          script: scriptName,
          canonical: new TextDecoder().decode(base64UrlToBytes(header) ?? new Uint8Array()),
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
    const envelope = parseScopeStoreEnvelope(seen?.canonical ?? '');
    expect(envelope).toMatchObject({ aud: 'platform', name: 'T/acme/crm/S/GRAPH', op: 'substrat.size' });
    expect(envelope?.digest).toBe(await scopeStoreBodyDigest(seen?.raw ?? ''));
    expect(await verifyScopeStoreEnvelope(vector.publicKey, seen?.canonical ?? '', seen?.signature ?? '')).toBe(true);
  });
});
