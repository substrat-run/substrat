import { describe, expect, it } from 'vitest';
import { capabilityId, platformActorId, provesNothingChanged, scopeId, tenantId } from '@substrat-run/contracts';
import { auditedCapabilityRevoke, ulid } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-api';
import { capabilityDelegationOver } from '../src/worker.js';

/**
 * #1686: the operator's capability revoke reaches the deployment serving the scope. The
 * delegation's body over a fake ladder: the deployment is resolved, as the operator, from the
 * record the host hands it plus the scope's tenant (which the #417 retry needs); what reaches
 * the vertical's client is the wire input; a scope no deployment serves is refused with nothing sent.
 */
describe('capabilityDelegationOver (#1686)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const id = capabilityId.parse(ulid());
  const actor = platformActorId.parse(ulid());
  const served = { vertical: 'desk', verticalVersionId: 'v-7', servingRef: null };

  it('resolves the deployment as the operator, from the scope’s tenant and served record, and revokes there', async () => {
    const sent: unknown[] = [];
    const asked: unknown[] = [];
    const delegation = capabilityDelegationOver(async (who, scope) => {
      asked.push([who, scope]);
      return {
        revokeCapability: async (input) => {
          sent.push(input);
          return null;
        },
      };
    });
    await expect(delegation.revoke({ tenantId: t, scopeId: s, served, capabilityId: id, actor })).resolves.toBeNull();
    expect(asked).toEqual([[actor, { tenantId: t, ...served }]]);
    expect(sent).toEqual([{ scopeId: s, capabilityId: id, actor }]);
  });

  it('twin: a vertical the platform has no deployment for is a 501 — it proves nothing changed — and nothing is sent', async () => {
    const err = await capabilityDelegationOver(async () => undefined)
      .revoke({ tenantId: t, scopeId: s, served, capabilityId: id, actor })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(501);
    expect(provesNothingChanged(err)).toBe(true);
    expect((err as Error).message).toMatch(/no deployment serving scope .*'desk'.* was not revoked/);
  });

  // Through the audit: nothing sent reads as refused, never as an open intent.
  it('so the audited revoke records it refused, never unknown', async () => {
    const phases: string[] = [];
    const logged: unknown[] = [];
    const delegation = capabilityDelegationOver(async () => undefined);
    await expect(
      auditedCapabilityRevoke({
        capabilityId: id,
        scopeId: s,
        record: (_before, after) => void phases.push(after.phase as string),
        revoke: () => delegation.revoke({ tenantId: t, scopeId: s, served, capabilityId: id, actor }),
        logError: (m, f) => void logged.push([m, f]),
      }),
    ).rejects.toThrow(/no deployment serving scope/);
    expect(phases).toEqual(['intent', 'refused']);
    expect(logged).toEqual([]);
  });
});
