/**
 * The door a deployed worker mounts (K-61). What is under test is what a project no longer
 * writes: nobody gets a stub, and a stub carries the address the issuer verified and no other.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { AuthSubject } from '@substrat-run/vertical-auth/provider';

let subject: AuthSubject | null = null;

vi.mock('@substrat-run/vertical-auth', async () => {
  const provider = await vi.importActual<typeof import('@substrat-run/vertical-auth/oidc-rp-provider')>(
    '@substrat-run/vertical-auth/oidc-rp-provider',
  );
  return {
    AuthConfigError: class extends Error {},
    IdentityDO: class {},
    instanceAuthFor: async () => ({
      identity: null,
      settings: { SHOP_NAME: 'delivered' },
      provider: () => ({ resolve: async () => subject, handle: async () => new Response('login') }),
    }),
    mintOwnerClaimLink: vi.fn(),
    placesReporter: () => ({}),
    reportScopeMembers: vi.fn(),
    verifiedEmailOf: provider.verifiedEmailOf,
  };
});
vi.mock('@substrat-run/vertical-auth/owner-claim-routes', () => ({ mountOwnerClaim: vi.fn() }));
vi.mock('@substrat-run/vertical-auth/session-route', () => ({ mountSession: vi.fn() }));

const { workerDoor } = await import('../src/worker-door.js');

const node = { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) };
const ann = principalId.parse(ulid());

function door(bound: string | null = ann) {
  const getScope = vi.fn(async () => ({ tenantId: node.tenantId, scopeId: node.scopeId, invoke: vi.fn() }));
  const directory = {
    resolvePrincipal: async () => bound,
    setPendingOwner: vi.fn(),
    getOwnerOfRecord: async () => ann,
  };
  const built = workerDoor<object>({
    directory: () => directory as never,
    nodeFor: () => node,
    hostFor: () => ({ getScope }) as never,
    envSpec: [],
  });
  return { built, getScope, directory };
}

const statusOf = async (built: ReturnType<typeof door>['built']): Promise<number> => {
  const app = new Hono<{ Bindings: object }>();
  app.get('/', async (c) => {
    await built.scope(c);
    return c.text('in');
  });
  return (await app.request('/')).status;
};

const signedIn = (over: Partial<AuthSubject> = {}): AuthSubject => ({
  sub: 'ann', email: 'Ann@Example.com', name: null, emailVerified: true, ...over,
});

describe('workerDoor (K-61)', () => {
  it('hands getScope the verified address beside the principal', async () => {
    subject = signedIn();
    const { built, getScope } = door();
    expect(await statusOf(built)).toBe(200);
    expect(getScope).toHaveBeenCalledWith(ann, node.tenantId, node.scopeId, { verifiedEmail: 'Ann@Example.com' });
  });

  it('hands over null for an address the issuer did not verify', async () => {
    subject = signedIn({ emailVerified: false });
    const { built, getScope } = door();
    expect(await statusOf(built)).toBe(200);
    expect(getScope).toHaveBeenCalledWith(ann, node.tenantId, node.scopeId, { verifiedEmail: null });
  });

  it.each([
    ['nobody signed in', null, ann],
    ['a subject bound to nobody here', signedIn(), null],
  ])('answers 401 for %s, and opens no scope', async (_label, who, bound) => {
    subject = who;
    const { built, getScope } = door(bound);
    expect(await statusOf(built)).toBe(401);
    expect(getScope).not.toHaveBeenCalled();
  });

  it('records the pending owner at provision, and reads settings through the directory', async () => {
    const { built, directory } = door();
    const owner = ulid();
    await built.platform.onProvision({}, { ...node, owner } as never);
    expect(directory.setPendingOwner).toHaveBeenCalledWith(node.scopeId, owner, undefined);
    expect(await built.settings({}, node)).toEqual({ SHOP_NAME: 'delivered' });
    expect(await built.platform.resolveOwner({}, node)).toBe(ann);
  });
});
