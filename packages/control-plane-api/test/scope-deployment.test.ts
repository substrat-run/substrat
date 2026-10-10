import { describe, expect, it } from 'vitest';
import { platformActorId, tenantId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { scopeDeployment, type ScopeDeploymentLadder, type VerticalClient } from '../src/index.js';

/**
 * The ONE serving-ref → bound-version → slug ladder (#1686 extracted it from the API so the
 * control plane's capability revoke climbs the same one the capability read does). Each rung, and
 * the #417 retry: a scope bound to a BARE slug the registry does not hold, whose tenant registered
 * the prefixed `<tenant>/<slug>`, is reached under the prefixed id.
 */
describe('scopeDeployment', () => {
  const actor = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const client = (name: string) => ({ name }) as unknown as VerticalClient;
  const ladder = (registry: Record<string, TenantId | null>, over: Partial<ScopeDeploymentLadder> = {}) => {
    const reads: string[] = [];
    const l: ScopeDeploymentLadder = {
      resolveVertical: async (slug) => (slug in registry ? client(`prod:${slug}`) : undefined),
      ownerOf: async (_a, slug) => {
        reads.push(`owner:${slug}`);
        return slug in registry ? registry[slug] : undefined;
      },
      tenantSlugOf: async (_a, id) => {
        reads.push(`tenant:${id}`);
        return id === t ? 'acme' : null;
      },
      ...over,
    };
    return { l, reads };
  };
  const scope = (vertical: string | null, more: { verticalVersionId?: string | null; servingRef?: string | null; tenantId?: TenantId } = {}) => ({
    tenantId: t,
    vertical,
    verticalVersionId: more.verticalVersionId ?? null,
    servingRef: more.servingRef ?? null,
    ...('tenantId' in more ? { tenantId: more.tenantId } : {}),
  });

  it('a bare-slug scope whose tenant registered the prefixed id is reached under it (#417)', async () => {
    const { l, reads } = ladder({ 'acme/desk': t });
    const got = await scopeDeployment(l, actor, scope('desk'));
    expect(got).toEqual({ client: client('prod:acme/desk'), via: 'slug' });
    expect(reads).toEqual(['owner:desk', `tenant:${t}`, 'owner:acme/desk']);
  });

  it('twin: a slug the registry holds resolves directly, and the retry reads nothing', async () => {
    const { l, reads } = ladder({ desk: t, 'acme/desk': t });
    expect(await scopeDeployment(l, actor, scope('desk'))).toEqual({ client: client('prod:desk'), via: 'slug' });
    expect(reads).toEqual([]);
  });

  it('twin: no prefixed registration, or no tenant to read, or an already-prefixed slug — a miss', async () => {
    expect(await scopeDeployment(ladder({}).l, actor, scope('desk'))).toBeUndefined();
    expect(await scopeDeployment(ladder({ 'acme/desk': t }).l, actor, scope('desk', { tenantId: undefined }))).toBeUndefined();
    expect(await scopeDeployment(ladder({ 'other/desk': t }).l, actor, scope('acme/desk'))).toBeUndefined();
  });

  it('the serving script first, then the bound version, then the slug', async () => {
    const { l } = ladder({ desk: t }, {
      resolveVerticalRef: async (ref) => (ref === 'serving-desk' ? client('serving') : undefined),
      resolveVerticalVersion: async (_slug, v) => (v === 'v-1' ? client('v-1') : undefined),
    });
    expect(await scopeDeployment(l, actor, scope('desk', { servingRef: 'serving-desk', verticalVersionId: 'v-1' }))).toEqual({ client: client('serving'), via: 'serving-script' });
    expect(await scopeDeployment(l, actor, scope('desk', { servingRef: 'gone', verticalVersionId: 'v-1' }))).toEqual({ client: client('v-1'), via: 'bound-version' });
    expect(await scopeDeployment(l, actor, scope('desk', { verticalVersionId: 'v-9' }))).toEqual({ client: client('prod:desk'), via: 'slug' });
    expect(await scopeDeployment(l, actor, scope(null))).toBeUndefined();
  });
});
