import { describe, expect, it } from 'vitest';
import { capabilityId, platformActorId, scopeId, tenantId, type Scope } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { capabilityDelegationOver } from '../src/worker.js';

/**
 * #1686: the operator's capability revoke reaches the deployment serving the scope. The
 * delegation's body over fake reads: what reaches the vertical's client is the wire input, and a
 * scope no deployment serves is refused with nothing sent.
 */
describe('capabilityDelegationOver (#1686)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const id = capabilityId.parse(ulid());
  const actor = platformActorId.parse(ulid());
  const record = (vertical: string | null) => ({ id: s, tenantId: t, vertical }) as unknown as Scope;

  it('revokes in the serving deployment with the scope, the capability and the operator', async () => {
    const sent: unknown[] = [];
    const asked: unknown[] = [];
    const delegation = capabilityDelegationOver(
      async (tenant, scope) => {
        asked.push([tenant, scope]);
        return record('desk');
      },
      async () => ({
        revokeCapability: async (input) => {
          sent.push(input);
          return null;
        },
      }),
    );
    await expect(delegation.revoke({ tenantId: t, scopeId: s, capabilityId: id, actor })).resolves.toBeNull();
    expect(asked).toEqual([[t, s]]);
    expect(sent).toEqual([{ scopeId: s, capabilityId: id, actor }]);
  });

  it('twin: a scope no deployment serves is refused, and nothing is sent', async () => {
    const sent: unknown[] = [];
    const client = async () => ({
      revokeCapability: async (input: unknown) => {
        sent.push(input);
        return null;
      },
    });
    for (const rec of [record(null), undefined]) {
      await expect(
        capabilityDelegationOver(async () => rec, client).revoke({ tenantId: t, scopeId: s, capabilityId: id, actor }),
      ).rejects.toThrow(/no deployment serving scope .* was not revoked/);
    }
    // …and a vertical the platform has no client for.
    await expect(
      capabilityDelegationOver(async () => record('desk'), async () => undefined).revoke({ tenantId: t, scopeId: s, capabilityId: id, actor }),
    ).rejects.toThrow(/no deployment serving scope/);
    expect(sent).toEqual([]);
  });
});
