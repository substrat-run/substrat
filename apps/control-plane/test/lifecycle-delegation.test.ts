import { describe, expect, it } from 'vitest';
import { scopeId, tenantId, type Scope, type ScopeLifecycle } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { lifecycleDelegationOver } from '../src/worker.js';

/**
 * #2016: the lifecycle delivery names the tenant the directory holds the scope under, so the
 * deployment can hold it against the scope's own record (refuse a foreign one, back-fill a legacy
 * one). The delegation's body over fake reads: what reaches the client is the wire input.
 */
describe('lifecycleDelegationOver (#1713, #2016)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const lifecycle: ScopeLifecycle = {
    scope: 'suspended',
    tenant: 'active',
    at: '2026-10-01T00:00:00.000Z' as ScopeLifecycle['at'],
    revision: { epoch: 0, scope: 1, tenant: 0 },
  };
  const answer = { applied: true, changed: true, lifecycle };
  const record = (vertical: string | null) => ({ id: s, tenantId: t, vertical }) as unknown as Scope;

  it('delivers to the serving deployment with the scope, the lifecycle and the tenant', async () => {
    const sent: unknown[] = [];
    const asked: unknown[] = [];
    const delegation = lifecycleDelegationOver(
      async (tenant, scope) => {
        asked.push([tenant, scope]);
        return record('crm');
      },
      async () => ({
        setLifecycle: async (input) => {
          sent.push(input);
          return answer;
        },
      }),
    );
    await expect(delegation.deliver({ tenantId: t, scopeId: s, lifecycle })).resolves.toEqual(answer);
    expect(asked).toEqual([[t, s]]);
    expect(sent).toEqual([{ scopeId: s, lifecycle, tenantId: t }]);
  });

  it('twin: a scope no deployment serves is refused, and nothing is sent', async () => {
    const sent: unknown[] = [];
    const client = async () => ({
      setLifecycle: async (input: unknown) => {
        sent.push(input);
        return answer;
      },
    });
    await expect(lifecycleDelegationOver(async () => record(null), client).deliver({ tenantId: t, scopeId: s, lifecycle })).rejects.toThrow(
      /no deployment serving scope/,
    );
    await expect(lifecycleDelegationOver(async () => undefined, client).deliver({ tenantId: t, scopeId: s, lifecycle })).rejects.toThrow(
      /no deployment serving scope/,
    );
    expect(sent).toEqual([]);
  });
});
