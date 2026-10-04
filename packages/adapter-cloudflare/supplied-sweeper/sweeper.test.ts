/**
 * The platform-supplied scope sweeper runs a vertical's schedules (#1902) — in workerd, on a
 * fixture vertical that wires none, uploaded the way the control plane uploads it.
 *
 * What it holds, each through the deployed worker the way the platform drives it:
 *
 *   - the worker the vertical wrote exports no sweeper, and the upload gave it one: the
 *     `SWEEPER` binding, and the var that hands its roster to `mountPlatformSurface`;
 *   - `/internal/provision` puts the scope on that sweeper's roster — no hook of the vertical's;
 *   - a pass runs the due schedule on the scope, through the host the vertical registered;
 *   - `/internal/delete-scope` takes the scope off the roster.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { SCOPE_SWEEPER_NAME, type ScopeSweepOutcome, type ScopeSweepReport } from '../src/scope-sweeper-do.js';
import * as vertical from './fixture/worker.js';
import { MODULES } from './fixture/perms.js';

interface SweeperStub {
  sweepNow(): Promise<ScopeSweepOutcome>;
}
interface TestEnv {
  SCOPE: DurableObjectNamespace;
  SWEEPER: DurableObjectNamespace;
  SUBSTRAT_SCOPE_SWEEPER?: string;
  PLATFORM_SECRET: string;
}
const e = env as unknown as TestEnv;

const t = tenantId.parse(ulid());
const owner = principalId.parse(ulid());

const sweeper = () => e.SWEEPER.get(e.SWEEPER.idFromName(SCOPE_SWEEPER_NAME)) as DurableObjectStub & SweeperStub;
const roster = () =>
  runInDurableObject(sweeper() as DurableObjectStub, async (_i, state) =>
    [...(await state.storage.list({ prefix: 'scope:' })).keys()].map((k) => k.slice('scope:'.length)),
  );
const platform = (path: string, body: unknown) =>
  SELF.fetch(`https://fixture.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-substrat-platform': e.PLATFORM_SECRET },
    body: JSON.stringify(body),
  });
const ticksOn = async (s: ScopeId): Promise<number> => {
  const host = new CloudflareScopeHost({ scope: e.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return (await (await host.getScope(owner, t, s)).invoke('fixture/count')) as number;
};
const asReport = (o: ScopeSweepOutcome): ScopeSweepReport => {
  if ('error' in o) throw new Error(o.error);
  return o;
};

describe('the platform-supplied sweeper runs a vertical that wires none (#1902)', () => {
  const s = scopeId.parse(ulid());

  it('the vertical exports no sweeper; the upload binds the platform’s and names it', () => {
    expect(Object.keys(vertical)).not.toContain('SweeperDO');
    expect(e.SUBSTRAT_SCOPE_SWEEPER).toBe('SWEEPER');
    expect(e.SWEEPER).toBeDefined();
  });

  it('provision puts the scope on the supplied sweeper’s roster, and a pass fires its due schedule', async () => {
    const res = await platform('/internal/provision', { tenantId: t, scopeId: s, owner });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await roster()).toEqual([s]);
    expect(await ticksOn(s)).toBe(0);
    const report = asReport(await sweeper().sweepNow());
    expect(report.errors).toEqual([]);
    expect(report.schedules.fired).toBeGreaterThan(0);
    expect(await ticksOn(s)).toBe(1);
    // Not due again for an hour: the next pass leaves it alone.
    asReport(await sweeper().sweepNow());
    expect(await ticksOn(s)).toBe(1);
  });

  it('delete-scope takes the scope off the roster', async () => {
    const res = await platform('/internal/delete-scope', { tenantId: t, scopeId: s });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await roster()).toEqual([]);
  });
});
