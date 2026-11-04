import { describe, expect, it } from 'vitest';
import { fetchLikeOf, type ScopeHost } from '@substrat-run/kernel';
import { probeBolagsverketConnection, probeBolagsverketSecret } from '../src/connector.js';
import { API_BASE, CREDENTIAL, TOKEN, TOKEN_URL, fakeFetch, type Reply } from './fixture.js';

const TENANT = '01J00000000000000000000000';

const options = (api: Reply[], token?: Reply) => {
  const fake = fakeFetch(api, token);
  return { fake, options: { fetch: fetchLikeOf(fake.fetch), tokenUrl: TOKEN_URL, apiBase: API_BASE, environment: 'test' as const } };
};

describe('probeBolagsverketSecret', () => {
  it('mints and pings, and names the environment and the granted scopes', async () => {
    const { options: o } = options([{ status: 200, body: '' }], {
      status: 200,
      body: { ...TOKEN, scope: 'vardefulla-datamangder:read' },
    });
    expect(await probeBolagsverketSecret(CREDENTIAL, o)).toEqual({
      ok: true,
      refused: false,
      accountRef: null,
      accountLabel: null,
      facts: [
        { label: 'Environment', value: 'test' },
        { label: 'Scopes', value: 'vardefulla-datamangder:read' },
      ],
      error: null,
    });
  });

  it('refuses an incomplete credential without a request', async () => {
    const { fake, options: o } = options([]);
    expect(await probeBolagsverketSecret({ clientId: 'placeholder-client' }, o)).toMatchObject({
      ok: false,
      refused: true,
      error: expect.stringMatching(/clientSecret/),
    });
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ['a turned-away client as refused', [], { status: 401, body: { error: 'invalid_client' } }, true],
    ['a 429 as inconclusive, without waiting it out', [{ status: 429, body: '', headers: { 'Retry-After': '30' } }], undefined, false],
  ])('reads %s', async (_, api, token, refused) => {
    const { options: o } = options(api, token);
    expect(await probeBolagsverketSecret(CREDENTIAL, o)).toMatchObject({ ok: false, refused });
  });
});

describe('probeBolagsverketConnection', () => {
  it("probes the tenant's sealed pair and records the use against its connection", async () => {
    const { options: o } = options([{ status: 200, body: '' }]);
    const opened: unknown[][] = [];
    const uses: string[] = [];
    const host = {
      admin: {
        openConnection: async (...args: unknown[]) => {
          opened.push(args);
          return { id: 'conn-1', secret: CREDENTIAL };
        },
        recordConnectionUse: async (id: string) => {
          uses.push(id);
        },
      },
    } as unknown as ScopeHost;

    expect(await probeBolagsverketConnection(host, { tenantId: TENANT, vertical: 'todo' }, o)).toMatchObject({ ok: true });
    expect(opened).toEqual([[TENANT, 'todo', 'bolagsverket']]);
    // The token mint and the ping are each a use of the connection.
    expect(uses).toEqual(['conn-1', 'conn-1']);
  });
});
