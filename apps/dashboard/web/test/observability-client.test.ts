import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, teamApi } from '../src/lib/api';

describe('observability team paths (#2170)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('keeps each tab on its own team and preserves repeated app filters', async () => {
    const seen: { url: string; credentials?: RequestCredentials }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), credentials: init?.credentials });
      return Response.json({});
    }) as typeof fetch;

    await api.teamTraffic('team-a', { scopeIds: ['app-1', 'app-2'], hours: 24 });
    await api.teamTraffic('team-b', { hours: 1 });
    await api.businessVolumes('team-a', { scopeIds: ['app-1', 'app-2'], hours: 24 });
    await api.connectorCalls('team-b', { hours: 1 });
    await api.appMetrics('team-a', 24);
    await api.appTenantMetrics('team-b', 'app-2', 24);
    await teamApi('team-a').observabilityMetrics({ hours: '24' });
    await teamApi('team-b').tenantMetricsSeries({ hours: '1' });

    expect(seen.map((s) => s.url)).toEqual([
      '/api/teams/team-a/observability/traffic?scopeId=app-1&scopeId=app-2&hours=24',
      '/api/teams/team-b/observability/traffic?hours=1',
      '/api/teams/team-a/observability/business-volumes?scopeId=app-1&scopeId=app-2&hours=24',
      '/api/teams/team-b/observability/connector-calls?hours=1',
      '/api/teams/team-a/observability/app-metrics?hours=24',
      '/api/teams/team-b/apps/app-2/observability/metrics?hours=24',
      '/api/teams/team-a/observability/metrics?hours=24',
      '/api/teams/team-b/observability/tenant-metrics-series?hours=1',
    ]);
    expect(seen.every((s) => s.credentials === 'include')).toBe(true);
  });

  it('repeats every service filter and surfaces a nonmember refusal', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return Response.json({ title: 'Not Found', status: 404, detail: 'no such team' }, { status: 404 });
    }) as typeof fetch;
    await expect(api.observabilityLogs('team-b', { services: ['one', 'two'] })).rejects.toThrow('no such team');
    expect(seen).toEqual(['/api/teams/team-b/observability/logs?service=one&service=two']);
  });

  it('uses each tab’s team for app logs, request reads and patterns, preserving repeated filters', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return Response.json({});
    }) as typeof fetch;
    const filters = new URLSearchParams([['level', 'warn'], ['level', 'error']]);
    await api.appTenantLogs('team-a', 'app-1', { hours: 24 });
    await api.appRequestVolume('team-b', 'app-2', filters);
    await api.appRequestFacets('team-a', 'app-1', filters);
    await api.appRequests('team-b', 'app-2', filters);
    await api.appLogPatterns('team-a', 'app-1', filters);
    expect(seen).toEqual([
      '/api/teams/team-a/apps/app-1/observability/logs?hours=24',
      '/api/teams/team-b/apps/app-2/observability/requests/volume?level=warn&level=error',
      '/api/teams/team-a/apps/app-1/observability/requests/facets?level=warn&level=error',
      '/api/teams/team-b/apps/app-2/observability/requests/list?level=warn&level=error',
      '/api/teams/team-a/apps/app-1/observability/log-patterns?level=warn&level=error',
    ]);
  });
});
