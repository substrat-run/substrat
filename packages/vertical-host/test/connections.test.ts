import { describe, it, expect } from 'vitest';
import { PLATFORM_SECRET_HEADER, connectionId, scopeId, tenantId } from '@substrat-run/contracts';
import { bindConnection, ConnectionRequestError, listBindings, unbindConnection, upsertConnection } from '../src/index.js';

/**
 * The harness half of a scope's connection (#2732). These helpers decide nothing — the operation
 * checked the permission, the control plane re-derives the vertical and the landing — so what is
 * pinned is the wire: which route, the platform secret header, a body that is the request minus
 * its transport, and an answer parsed by the relay's own result schema.
 */
describe('connection helpers — the harness effects, the operation decides', () => {
  const ids = {
    tenantId: tenantId.parse('01J0000000000000000000TENA'),
    scopeId: scopeId.parse('01J0000000000000000000SCPA'),
  };
  const conn = connectionId.parse('01J0000000000000000000CNNA');
  const access = { controlPlaneUrl: 'https://cp.example/', platformSecret: 'platform-secret' };

  /** A fetch that records what it was asked and answers `status` with `body`. */
  const seam = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const sent = () => ({
      url: calls[0]!.url,
      secret: new Headers(calls[0]!.init.headers).get(PLATFORM_SECRET_HEADER),
      body: JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>,
    });
    return { fetchImpl, sent };
  };

  it('upserts a scope-owned connection through /internal/connections/upsert', async () => {
    const s = seam(200, { connectionId: conn, created: true, granted: [] });
    const result = await upsertConnection({
      ...access,
      ...ids,
      provider: 'acme-files',
      secret: { token: 't' },
      owner: 'scope',
      createdBy: 'principal-1',
      fetchImpl: s.fetchImpl,
    });
    expect(result).toEqual({ connectionId: conn, created: true, granted: [] });
    expect(s.sent()).toEqual({
      url: 'https://cp.example/internal/connections/upsert',
      secret: 'platform-secret',
      body: { ...ids, provider: 'acme-files', secret: { token: 't' }, owner: 'scope', createdBy: 'principal-1' },
    });
  });

  it('binds with the scope\'s options through /internal/connections/bind', async () => {
    // The relay answers the binding as the connector stored it, its normalised options included.
    const binding = { connectionId: conn, scopeId: ids.scopeId, options: { folder: 'f-1', mode: 'read' }, boundAt: '2026-10-30T09:00:00.000Z' };
    const s = seam(200, binding);
    expect(
      await bindConnection({ ...access, ...ids, connectionId: conn, options: { folder: 'f-1' }, boundBy: 'principal-1', fetchImpl: s.fetchImpl }),
    ).toEqual(binding);
    expect(s.sent()).toEqual({
      url: 'https://cp.example/internal/connections/bind',
      secret: 'platform-secret',
      body: { ...ids, connectionId: conn, options: { folder: 'f-1' }, boundBy: 'principal-1' },
    });
  });

  it('unbinds through /internal/connections/unbind', async () => {
    const s = seam(200, { connectionId: conn, scopeId: ids.scopeId, unbound: true });
    expect(await unbindConnection({ ...access, ...ids, connectionId: conn, unboundBy: 'principal-1', fetchImpl: s.fetchImpl })).toEqual({
      connectionId: conn,
      scopeId: ids.scopeId,
      unbound: true,
    });
    expect(s.sent()).toEqual({
      url: 'https://cp.example/internal/connections/unbind',
      secret: 'platform-secret',
      body: { ...ids, connectionId: conn, unboundBy: 'principal-1' },
    });
  });

  it('lists the scope\'s bindings through /internal/connections/bindings', async () => {
    const answer = {
      bindings: [{
        connectionId: conn, provider: 'acme-files', status: 'active', options: { folder: 'f-1' }, boundAt: '2026-10-30T09:00:00.000Z',
        lastSyncedAt: '2026-10-30T10:00:00.000Z', lastError: null,
      }],
    };
    const s = seam(200, answer);
    expect(await listBindings({ ...access, ...ids, fetchImpl: s.fetchImpl })).toEqual(answer);
    expect(s.sent()).toEqual({ url: 'https://cp.example/internal/connections/bindings', secret: 'platform-secret', body: ids });
  });

  it('throws the relay\'s status and words on a refusal, and on a 2xx that is not the result', async () => {
    const bind = (status: number, body: unknown) =>
      bindConnection({ ...access, ...ids, connectionId: conn, boundBy: 'p', fetchImpl: seam(status, body).fetchImpl }).catch((e: unknown) => e);
    const refused = await bind(409, { error: 'no on-request landing' });
    expect(refused).toBeInstanceOf(ConnectionRequestError);
    expect(refused).toMatchObject({ status: 409, message: expect.stringContaining('no on-request landing') });
    expect(await bind(200, {})).toMatchObject({ name: 'ConnectionRequestError', status: 200 });
  });
});
