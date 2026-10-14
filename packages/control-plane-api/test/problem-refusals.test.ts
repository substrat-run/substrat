import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import {
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPE_BLANK,
  platformActorId,
  problem,
  problemTypeFor,
  scopeId,
  tenantId,
  type ErrorCode,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  type LakeQueryEngine,
} from '../src/index.js';
import { coded, relayed } from '../src/errors.js';
import { takeNonProblemRefusals } from './setup/problem-tripwire.js';

/**
 * #113: the control plane answers EVERY refusal as a problem document — the ones a route
 * answers itself, not only the throws `onError` maps. The compatibility half is the point:
 * the status and the `error` sentence a client read before are exactly what it reads now,
 * and so is every member a route carried beside them.
 */
describe('control-plane refusals are problem documents', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const staff = platformActorId.parse(ulid());
  const builder = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-problem-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateBuilder: (r) =>
        r.headers.get('x-test-builder') ? { actor: builder, tenantId: t1, tenantSlug: 'acme' } : null,
      // Never reached: every request below is refused before the engine is asked.
      lakeQuery: {} as LakeQueryEngine,
    });
    await host.admin.createTenant(staff, { id: t1, slug: 'acme', name: 'Acme' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The wire contract every refusal is held to, whatever it is. */
  async function refusal(res: Response, status: number, error: string, code?: ErrorCode) {
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    expect(problem.safeParse(body).success).toBe(true);
    expect(body.status).toBe(status);
    // The deprecated duplicate is the sentence a client read before #113, unchanged.
    expect(body.error).toBe(error);
    expect(body.detail).toBe(error);
    if (code === undefined) {
      expect(body.type).toBe(PROBLEM_TYPE_BLANK);
      expect(body).not.toHaveProperty('code');
    } else {
      expect(body.code).toBe(code);
      expect(body.type).toBe(problemTypeFor(code));
    }
    return body;
  }

  it('401: a request with no principal', async () => {
    await refusal(await app.request('/tenants'), 401, 'unauthenticated', 'unauthenticated');
  });

  it('403: a builder outside its allowlist', async () => {
    const res = await app.request('/tenants', { headers: { 'x-test-builder': '1' } });
    await refusal(res, 403, 'forbidden', 'forbidden');
  });

  it('404: an unknown scope', async () => {
    const s = scopeId.parse(ulid());
    const res = await app.request(`/tenants/${t1}/scopes/${s}`, { headers: auth });
    await refusal(res, 404, `unknown scope for tenant: (${t1}, ${s})`, 'not_found');
  });

  it('404: a path no route matches', async () => {
    await refusal(await app.request('/no-such-route', { headers: auth }), 404, 'no such route', 'not_found');
  });

  it('409: reaping a tenant that is not deleting', async () => {
    const res = await app.request(`/tenants/${t1}/reap`, { method: 'POST', headers: auth });
    await refusal(res, 409, `tenant ${t1} is active, not deleting — only a deleting tenant may be reaped`, 'conflict');
  });

  it('400: a lake query that does not parse keeps `issues` and gains the declared `errors`', async () => {
    const res = await app.request(`/tenants/${t1}/lake/events?limit=not-a-number`, { headers: auth });
    const body = await refusal(res, 400, 'invalid lake query', 'validation_failed');
    const issues = body.issues as Array<{ path: unknown[]; message: string }>;
    const errors = body.errors as Array<{ path: string; message: string }>;
    expect(issues.length).toBeGreaterThan(0);
    // One complaint, two spellings: zod's array path, and the contract's dotted one.
    expect(errors).toEqual(issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  });

  it('501: a capability this plane was not configured with is `about:blank`, not a fabricated code', async () => {
    const bare = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
    const res = await bare.request(`/tenants/${t1}/lake/events`, { headers: auth });
    await refusal(res, 501, 'the Tier-2 lake is not queryable on this control plane');
  });

  it('the builders: a decided code takes its status from the catalog; a bare status stays bare', () => {
    expect(coded('precondition_failed', 'moved').status).toBe(412);
    expect(coded('precondition_failed', 'moved').body).toMatchObject({ code: 'precondition_failed', error: 'moved' });
    for (const status of [422, 502]) {
      const { status: answered, body } = relayed(status, 'why');
      expect(answered).toBe(status);
      expect(body).toMatchObject({ type: PROBLEM_TYPE_BLANK, status, detail: 'why', error: 'why' });
      expect(body).not.toHaveProperty('code');
    }
  });

  describe('the tripwire', () => {
    it('logs a hand-rolled refusal with the route pattern, never the raw path or the body', async () => {
      const tripped = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
      tripped.get('/hand-rolled/:id', (c) => c.json({ error: 'secret sentence' }, 404));
      const id = ulid();
      const res = await tripped.request(`/hand-rolled/${id}`, { headers: auth });
      expect(res.status).toBe(404);
      const seen = takeNonProblemRefusals();
      expect(seen).toEqual([{ method: 'GET', route: '/hand-rolled/:id', status: 404 }]);
      expect(JSON.stringify(seen)).not.toContain(id);
      expect(JSON.stringify(seen)).not.toContain('secret sentence');
    });

    it('stays quiet for a problem answer and for a success', async () => {
      await app.request('/tenants', { headers: auth });
      await app.request(`/tenants/${t1}/scopes/${scopeId.parse(ulid())}`, { headers: auth });
      expect(takeNonProblemRefusals()).toEqual([]);
    });
  });
});
