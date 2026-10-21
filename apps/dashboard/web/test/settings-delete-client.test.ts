import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamApi } from '../src/lib/api';

describe('Settings delete client', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('sends the typed name to the pinned team, even when another tab changes teams', async () => {
    const seen: Array<{ url: string; method: string; body: unknown; credentials: RequestCredentials | undefined }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)), credentials: init?.credentials });
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const firstTab = teamApi('team A');
    const secondTab = teamApi('team B');
    await secondTab.deleteTeam({ confirm: 'Team B' });
    await firstTab.deleteTeam({ confirm: 'Team A' });

    expect(seen).toEqual([
      { url: '/api/teams/team%20B/delete', method: 'POST', body: { confirm: 'Team B' }, credentials: 'include' },
      { url: '/api/teams/team%20A/delete', method: 'POST', body: { confirm: 'Team A' }, credentials: 'include' },
    ]);
  });
});
