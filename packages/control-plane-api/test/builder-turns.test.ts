import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, tenantId, type BuilderTurn } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { builderTurnsService, createControlPlaneApi, DEV_ACTOR_HEADER, mintPushToken, pushActorFor, pushTokenBuilderAuth, UNSAFE_devPlatformActorAuth } from '../src/index.js';

const turn: BuilderTurn = {
  id: '01JZ0000000000000000TURN01',
  turnId: 'T1',
  tenantId: 'TEAM1',
  projectId: 'P1',
  projectName: 'Our Lists',
  threadId: 'TH1',
  firstSeq: 1,
  lastSeq: 2,
  model: 'anthropic:claude-opus-5',
  phaseStart: 'model',
  phaseEnd: 'model',
  outcome: 'done',
  failure: null,
  gatesOk: false,
  redGates: [{ name: 'model-emit', status: 'failed', line: 'model-diff: spec/model.ts could not be imported' }],
  repairs: 2,
  truncated: false,
  commitSha: 'cfe7cd60',
  inputTokens: 100,
  outputTokens: 10,
  startedAt: '2026-11-03T14:30:00.000Z',
  endedAt: '2026-11-03T14:31:00.000Z',
};

describe('builder turns, relayed for the console', () => {
  let root: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const secret = 'builder-turns-test';
  /** The builder's side of the binding: what it was asked, and what it answers. */
  const builder = vi.fn<(request: Request) => Promise<Response>>();
  const asStaff = { [DEV_ACTOR_HEADER]: staff };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'builder-turns-'));
    host = new SqliteScopeHost({ dir: root });
    await host.admin.createTenant(staff, { id: tenant, slug: 'acme', name: 'Acme' });
    builder.mockReset();
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateBuilder: pushTokenBuilderAuth(secret),
      builderTurns: builderTurnsService({ fetch: builder }, 'service-token'),
    });
  });
  afterEach(async () => {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the list and one turn for staff, and refuses a builder credential before asking the builder', async () => {
    builder.mockImplementation(async (request) =>
      new URL(request.url).pathname === '/internal/turns'
        ? Response.json({ entries: [turn], nextCursor: null })
        : Response.json({ turn, events: [{ id: 1, t: 'user-message', text: 'Build it' }], cut: false }),
    );

    const list = await app.request('/builder-turns?troubled=true&redGate=model-emit&actor=ignored', { headers: asStaff });
    expect(list.status, await list.clone().text()).toBe(200);
    expect(await list.json()).toEqual({ entries: [turn], nextCursor: null });
    const asked = builder.mock.calls[0]![0];
    expect(asked.headers.get('x-service-token')).toBe('service-token');
    expect(new URL(asked.url).search).toBe('?redGate=model-emit&troubled=true');

    const one = await app.request('/builder-turns/T1', { headers: asStaff });
    expect(await one.json()).toMatchObject({ turn: { turnId: 'T1' }, events: [{ t: 'user-message' }] });

    const token = await mintPushToken(secret, { actor: await pushActorFor(tenant), tenantId: tenant, tenantSlug: 'acme' });
    builder.mockClear();
    expect((await app.request('/builder-turns', { headers: { 'x-service-token': token } })).status).toBe(403);
    expect((await app.request('/builder-turns/T1', { headers: { 'x-service-token': token } })).status).toBe(403);
    expect(builder).not.toHaveBeenCalled();
  });

  it('answers 404 for a turn the builder does not hold, and 502 for an answer in a shape it does not know', async () => {
    builder.mockResolvedValueOnce(Response.json({ type: 'about:blank', detail: 'no such turn' }, { status: 404 }));
    expect((await app.request('/builder-turns/T9', { headers: asStaff })).status).toBe(404);

    builder.mockResolvedValueOnce(Response.json({ entries: [{ turnId: 'T1' }], nextCursor: null }));
    expect((await app.request('/builder-turns', { headers: asStaff })).status).toBe(502);
  });
});
