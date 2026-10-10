import { describe, expect, it } from 'vitest';
import { capabilityId, platformActorId, scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { capabilityDelegationOver } from '../src/worker.js';

/**
 * #1686: the operator's capability revoke reaches the deployment serving the scope. The
 * delegation's body over a fake ladder: the deployment is resolved from the record the host
 * hands it, what reaches the vertical's client is the wire input, and a scope no deployment
 * serves is refused with nothing sent.
 */
describe('capabilityDelegationOver (#1686)', () => {
  const s = scopeId.parse(ulid());
  const id = capabilityId.parse(ulid());
  const actor = platformActorId.parse(ulid());
  const served = { vertical: 'desk', verticalVersionId: 'v-7', servingRef: null };

  it('resolves the deployment from the served record, and revokes there with the scope, the capability and the operator', async () => {
    const sent: unknown[] = [];
    const asked: unknown[] = [];
    const delegation = capabilityDelegationOver(async (rec) => {
      asked.push(rec);
      return {
        revokeCapability: async (input) => {
          sent.push(input);
          return null;
        },
      };
    });
    await expect(delegation.revoke({ scopeId: s, served, capabilityId: id, actor })).resolves.toBeNull();
    expect(asked).toEqual([served]);
    expect(sent).toEqual([{ scopeId: s, capabilityId: id, actor }]);
  });

  it('twin: a vertical the platform has no deployment for is refused, and nothing is sent', async () => {
    await expect(
      capabilityDelegationOver(async () => undefined).revoke({ scopeId: s, served, capabilityId: id, actor }),
    ).rejects.toThrow(/no deployment serving scope .*'desk'.* was not revoked/);
  });
});
