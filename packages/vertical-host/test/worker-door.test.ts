/**
 * The door a deployed worker mounts (K-61). What is under test is what a project no longer
 * writes: nobody gets a stub, a stub carries the address the issuer verified and no other, and a
 * person arriving is joined and given their own record.
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
vi.mock('@substrat-run/vertical-auth/session-route', async () => ({
  ...(await vi.importActual<typeof import('@substrat-run/vertical-auth/session-route')>('@substrat-run/vertical-auth/session-route')),
  mountSession: vi.fn(),
}));

const { workerDoor } = await import('../src/worker-door.js');
const { mountSession } = await import('@substrat-run/vertical-auth/session-route');

const node = { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) };
const ann = principalId.parse(ulid());

function door(bound: string | null = ann, join?: (scope: unknown, who: { display: string }) => Promise<unknown>) {
  const stub = { tenantId: node.tenantId, scopeId: node.scopeId, invoke: vi.fn() };
  const getScope = vi.fn(async () => stub);
  const grantSelfShapesLocal = vi.fn(async () => []);
  const directory = {
    resolvePrincipal: async () => bound,
    setPendingOwner: vi.fn(),
    getOwnerOfRecord: async () => ann,
  };
  const built = workerDoor<object>({
    directory: () => directory as never,
    nodeFor: () => node,
    hostFor: () => ({ getScope, grantSelfShapesLocal }) as never,
    envSpec: [],
    ...(join ? { join } : {}),
  });
  return { built, getScope, directory, stub, grantSelfShapesLocal };
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

  describe('a person arriving', () => {
    it('is joined, then given their own record, once per isolate', async () => {
      subject = signedIn({ name: 'Ann' });
      const join = vi.fn(async () => ({}));
      const { built, stub, grantSelfShapesLocal } = door(ann, join);
      expect(await statusOf(built)).toBe(200);
      expect(await statusOf(built)).toBe(200);
      expect(join).toHaveBeenCalledOnce();
      expect(join).toHaveBeenCalledWith(stub, { display: 'Ann' });
      expect(grantSelfShapesLocal).toHaveBeenCalledOnce();
      expect(grantSelfShapesLocal).toHaveBeenCalledWith(node.scopeId, ann);
    });

    it.each([
      ['with a join, is not joined or given anything', true, 0],
      ['with no join, is given their own record', false, 1],
    ])('signed in with an address the issuer did not verify: %s', async (_label, withJoin, grants) => {
      subject = signedIn({ emailVerified: false });
      const join = vi.fn(async () => ({}));
      const { built, grantSelfShapesLocal } = door(ann, withJoin ? join : undefined);
      expect(await statusOf(built)).toBe(200);
      expect(join).not.toHaveBeenCalled();
      expect(grantSelfShapesLocal).toHaveBeenCalledTimes(grants);
    });

    it('is given nothing when the join refuses, and is tried again on the next request', async () => {
      subject = signedIn();
      const join = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValue({});
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { built, grantSelfShapesLocal } = door(ann, join);
      expect(await statusOf(built)).toBe(200);
      expect(grantSelfShapesLocal).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledOnce();
      expect(await statusOf(built)).toBe(200);
      expect(join).toHaveBeenCalledTimes(2);
      expect(grantSelfShapesLocal).toHaveBeenCalledOnce();
      errors.mockRestore();
    });

    it('arrives through /api/me as well', async () => {
      subject = signedIn();
      const join = vi.fn(async () => ({}));
      const { built, grantSelfShapesLocal } = door(ann, join);
      built.mount(new Hono());
      const deps = vi.mocked(mountSession).mock.calls.at(-1)![1];
      expect(await deps.extra!({ env: {} } as never, { node, principal: ann, subject })).toEqual({});
      expect(join).toHaveBeenCalledOnce();
      expect(grantSelfShapesLocal).toHaveBeenCalledWith(node.scopeId, ann);
    });
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
