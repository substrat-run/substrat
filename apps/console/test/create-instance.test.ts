import { describe, expect, it, vi } from 'vitest';
import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import { createInstance, InstanceStepError } from '../src/lib/create-instance';
import type { Api } from '../src/lib/api';

/**
 * The order is the point. Every property this sequence protects comes from doing
 * these in exactly this order, so these tests assert the order rather than the
 * outcome.
 */

const ids = {
  tenantId: '01JZ00000000000000000000T1' as TenantId,
  scopeId: '01JZ00000000000000000000S1' as ScopeId,
  owner: '01JZ00000000000000000000OW' as PrincipalId,
};

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const calls: string[] = [];
  const rec =
    (name: string, result: unknown = {}) =>
    async (...args: unknown[]) => {
      calls.push(name);
      const override = overrides[name as keyof Api];
      if (typeof override === 'function') return (override as (...a: unknown[]) => unknown)(...args);
      return result;
    };
  const api = {
    createTenant: rec('createTenant'),
    activateScope: rec('activateScope'),
    provisionInstance: rec('provisionInstance'),
    provisionScope: rec('provisionScope'),
    // Default: no promoted version, so bindVersion resolves nothing (a static vertical).
    // Lists answer the platform envelope now: `{ entries, nextCursor }`.
    listChannels: rec('listChannels', { entries: [], nextCursor: null }),
    bindScopeVersion: rec('bindScopeVersion'),
    bindHostname: rec('bindHostname'),
    setHostnameStatus: rec('setHostnameStatus'),
  } as unknown as Api;
  return { api, calls };
}

describe('createInstance', () => {
  it('records the directory row BEFORE calling the vertical, then activates', async () => {
    // Directory-first, which is K-31's order. The reverse would leave an "invisible
    // orphan" on failure, and invisible is the problem — nothing can reconcile what
    // nothing knows about. A row stuck in `provisioning` is a work item (#49).
    const { api, calls } = fakeApi();
    await createInstance(api, { ...ids, verticalSlug: 'fsm', slug: 'acme', name: 'Acme' });
    expect(calls).toEqual([
      'createTenant',
      'provisionScope',
      'provisionInstance',
      'activateScope',
      // bindVersion resolves the prod channel; nothing promoted here, so no bind.
      'listChannels',
    ]);
  });

  it('pins the scope to the prod version when the vertical has one', async () => {
    // A pushed vertical with a promoted prod version: the scope is bound to it, so the
    // router dispatches on that version (orchestration.md §5.4).
    const bind = vi.fn(async () => ({}));
    const { api, calls } = fakeApi({
      listChannels: async () => ({
        entries: [{ channel: 'prod', versionId: '01JZVERSION', verticalSlug: 'fsm', updatedAt: '' }],
        nextCursor: null,
      }),
      bindScopeVersion: bind,
    });
    await createInstance(api, { ...ids, verticalSlug: 'fsm', slug: 'acme', name: 'Acme' });
    expect(calls).toContain('bindScopeVersion');
    expect(bind).toHaveBeenCalledWith(ids.tenantId, ids.scopeId, '01JZVERSION');
  });

  it('does not activate the scope when the vertical failed', async () => {
    // The whole point of the state: the row stays `provisioning`, so it is inert and
    // findable rather than active and broken.
    const { api, calls } = fakeApi({
      provisionInstance: async () => {
        throw new Error('vertical exploded');
      },
    });
    await expect(
      createInstance(api, { ...ids, verticalSlug: 'fsm', slug: 'acme', name: 'Acme' }),
    ).rejects.toThrow(InstanceStepError);
    expect(calls).not.toContain('activateScope');
  });

  it('activates the hostname LAST', async () => {
    // A hostname must never resolve before the thing behind it exists (K-26).
    const { api, calls } = fakeApi();
    const result = await createInstance(api, {
      ...ids,
      verticalSlug: 'fsm',
      slug: 'acme',
      name: 'Acme',
      hostname: 'acme.example.com',
    });
    expect(calls).toEqual([
      'createTenant',
      'provisionScope',
      'provisionInstance',
      'activateScope',
      'listChannels',
      'bindHostname',
      'setHostnameStatus',
    ]);
    expect(result.url).toBe('https://acme.example.com');
  });

  it('stops at the failing step and names it', async () => {
    // "It failed" is not actionable across two systems — which step ran decides
    // whether there is an orphan, a broken tenant, or nothing at all.
    const { api, calls } = fakeApi({
      provisionInstance: async () => {
        throw new Error('no deployment is bound for vertical');
      },
    });
    await expect(
      createInstance(api, { ...ids, verticalSlug: 'ghost', slug: 'acme', name: 'Acme' }),
    ).rejects.toThrow(InstanceStepError);
    // The scope row exists but was never activated — inert, and findable.
    expect(calls).toEqual(['createTenant', 'provisionScope', 'provisionInstance']);
  });

  it('carries the failing step, not just a message', async () => {
    const { api } = fakeApi({
      setHostnameStatus: async () => {
        throw new Error('unknown hostname');
      },
    });
    const err = await createInstance(api, {
      ...ids,
      verticalSlug: 'fsm',
      slug: 'acme',
      name: 'Acme',
      hostname: 'acme.example.com',
    }).catch((e) => e as InstanceStepError);
    expect(err.step).toBe('activate');
    expect(err.message).toContain('Activate');
  });

  it('skips hostname steps entirely when none is given', async () => {
    // An instance with no hostname is legitimate — it exists and is unreachable.
    // It must not bind an empty string.
    const { api, calls } = fakeApi();
    const result = await createInstance(api, {
      ...ids,
      verticalSlug: 'fsm',
      slug: 'acme',
      name: 'Acme',
      hostname: '   ',
    });
    expect(calls).not.toContain('bindHostname');
    expect(result.url).toBeNull();
  });

  it('lower-cases the hostname before binding it', async () => {
    const bind = vi.fn(async () => ({}));
    const { api } = fakeApi({ bindHostname: bind });
    await createInstance(api, {
      ...ids,
      verticalSlug: 'fsm',
      slug: 'acme',
      name: 'Acme',
      hostname: 'ACME.Example.COM',
    });
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'acme.example.com' }));
  });
});
