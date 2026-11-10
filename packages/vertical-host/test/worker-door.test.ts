/**
 * The door a deployed worker mounts (K-61). What is under test is what a project no longer
 * writes: nobody gets a stub, a stub carries the address the issuer verified and no other, and a
 * person arriving is joined and given their own record. And, since K-61 phase 3, an invited person
 * is admitted by that verified address, and a member invite is made and withdrawn here — the
 * platform's half first, the vertical's operation as the caller, and the one unwound by the other.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityId, principalId, scopeId, tenantId, type Coverage, type PermissionKey } from '@substrat-run/contracts';
import { mintCapabilitySecret, ulid } from '@substrat-run/kernel';
import { HTTPException } from 'hono/http-exception';
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
    // No member invite names anyone here: admission (K-61 phase 3) has its own cases below.
    openInviteFor: async () => null,
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

describe('an invited person (K-61 phase 3)', () => {
  const invited = principalId.parse(ulid());
  const link = capabilityId.parse(ulid());
  const COVERED: Coverage = { covered: true, missing: [] };
  const LACKS: Coverage = { covered: false, missing: ['deal:delete' as PermissionKey] };

  /** A door over a directory that knows nobody yet, and a host that records what it is asked. */
  function admitting(over: {
    exchanged?: unknown;
    open?: unknown;
    boundAfter?: string | null;
    /** The worker's invites, given the log the fakes write to so its operations can write there too. */
    invites?: (calls: string[]) => NonNullable<Parameters<typeof workerDoor>[0]['invites']>;
  } = {}) {
    const calls: string[] = [];
    let bound: string | null = null;
    const stub = { tenantId: node.tenantId, scopeId: node.scopeId, invoke: vi.fn() };
    const directory = {
      resolvePrincipal: vi.fn(async () => bound ?? over.boundAfter ?? null),
      openInviteFor: vi.fn(async (_scope: string, email: string) => {
        calls.push(`openInviteFor ${email}`);
        return over.open === undefined ? { principal: invited, capabilityId: link } : over.open;
      }),
      admitInvite: vi.fn(async (_scope: string, sub: string, _id: string, principal: string) => {
        calls.push(`bind ${sub}`);
        bound = principal;
        return principal;
      }),
      createInvite: vi.fn(async () => { calls.push('record'); }),
      unbindPrincipal: vi.fn(async () => { calls.push('unbind'); return []; }),
      getInvite: vi.fn(async () => ({ principal: invited, roleKey: 'rep', email: 'cleo@acme.example', createdAt: 0, capabilityId: link })),
      inviteLink: vi.fn(async () => link),
      revokeInvite: vi.fn(async () => { calls.push('revokeInvite'); return link; }),
    };
    const host = {
      getScope: vi.fn(async () => stub),
      grantSelfShapesLocal: vi.fn(async () => []),
      exchangeBecomeLinkById: vi.fn(async () => {
        calls.push('exchangeById');
        return over.exchanged === undefined ? { kind: 'principal', capabilityId: link, principal: invited } : over.exchanged;
      }),
      assignScopeRoleBounded: vi.fn(async () => { calls.push('grant'); return COVERED; }),
      mintBecomeCapabilityBounded: vi.fn(async () => {
        calls.push('mint');
        return { ok: true, minted: { id: link, secret: mintCapabilitySecret(), expiresAt: null } };
      }),
      revokeBecomeCapability: vi.fn(async () => { calls.push('revokeLink'); return { ok: true, revoked: true }; }),
      revokeScopeRole: vi.fn(async () => { calls.push('revokeRole'); return true; }),
      revokeScopeRolesBounded: vi.fn(async () => { calls.push('revokeRoles'); return { coverage: COVERED, revoked: ['rep'] }; }),
    };
    const built = workerDoor<object>({
      directory: () => directory as never,
      nodeFor: () => node,
      hostFor: () => host as never,
      envSpec: [],
      ...(over.invites ? { invites: over.invites(calls) } : {}),
    });
    const app = new Hono<{ Bindings: object }>();
    built.mount(app);
    app.get('/', async (c) => {
      await built.scope(c);
      return c.text('in');
    });
    return { built, app, calls, directory, host, stub };
  }

  it('is bound to the invite naming the address their issuer verified, and gets a stub as that principal', async () => {
    subject = signedIn({ sub: 'cleo', email: 'Cleo@Acme.example' });
    const { app, calls, host } = admitting();
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await app.request('/')).status).toBe(200);
    logged.mockRestore();
    expect(calls).toEqual(['openInviteFor Cleo@Acme.example', 'exchangeById', 'bind cleo']);
    expect(host.exchangeBecomeLinkById).toHaveBeenCalledWith(node.tenantId, node.scopeId, link);
    expect(host.getScope).toHaveBeenCalledWith(invited, node.tenantId, node.scopeId, { verifiedEmail: 'Cleo@Acme.example' });
  });

  it('with an address the issuer did not verify, no invite is looked for — 401', async () => {
    subject = signedIn({ sub: 'cleo', emailVerified: false });
    const { app, calls } = admitting();
    expect((await app.request('/')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each([
    ['no invite names the address', null, undefined],
    ['the scope refuses its link (expired, withdrawn, used)', undefined, null],
  ])('answers 401 when %s', async (_label, open, exchanged) => {
    subject = signedIn({ sub: 'cleo' });
    const { app, host } = admitting({ open, exchanged });
    expect((await app.request('/')).status).toBe(401);
    expect(host.getScope).not.toHaveBeenCalled();
  });

  it('a first request that loses the single use to a concurrent one finds the binding it made', async () => {
    subject = signedIn({ sub: 'cleo' });
    const { app, host, directory } = admitting({ exchanged: null });
    directory.resolvePrincipal.mockResolvedValueOnce(null).mockResolvedValueOnce(invited);
    expect((await app.request('/')).status).toBe(200);
    expect(host.getScope).toHaveBeenCalledWith(invited, node.tenantId, node.scopeId, expect.anything());
  });

  describe('the invite routes', () => {
    const post = (app: Hono<{ Bindings: object }>, path: string, body?: unknown) =>
      app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    /** A door whose worker names its invites: the vertical's two operations write to the door's log. */
    const withInvites = (refuse: 'send' | 'cancel' | null = null) => {
      const op = (calls: string[], name: 'send' | 'cancel') =>
        vi.fn(async (_scope: unknown, _invitation: unknown) => {
          calls.push(name);
          if (refuse === name) throw new HTTPException(403, { message: `only a manager may ${name}` });
          return {};
        });
      let named!: { roles: string[]; send: ReturnType<typeof op>; cancel: ReturnType<typeof op> };
      const door = admitting({
        boundAfter: ann,
        invites: (calls) => (named = { roles: ['rep', 'manager'], send: op(calls, 'send'), cancel: op(calls, 'cancel') }),
      });
      return { ...door, named };
    };

    beforeEach(() => {
      subject = signedIn();
    });

    it('are not mounted unless the worker names its invites', async () => {
      const { app } = admitting({ boundAfter: ann });
      expect((await post(app, '/api/member-invites', { email: 'cleo@acme.example', roleKey: 'rep' })).status).toBe(404);
    });

    it('invite: the role and link first, then the vertical as the inviter, and only then the row that admits', async () => {
      const { app, calls, stub, host, named } = withInvites();
      const res = await post(app, '/api/member-invites', { email: 'cleo@acme.example', roleKey: 'rep' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ principal: expect.any(String), email: 'cleo@acme.example', roleKey: 'rep', expiresAt: expect.any(String) });
      expect(JSON.stringify(body)).not.toContain('sbcap_');
      expect(calls).toEqual(['grant', 'mint', 'send', 'record']);
      expect(host.assignScopeRoleBounded).toHaveBeenCalledWith(node.tenantId, node.scopeId, ann, body.principal, 'rep');
      expect(named.send).toHaveBeenCalledWith(stub, body);
    });

    it('invite: the vertical\'s refusal is the answer, no row is ever written, and the link and role go', async () => {
      const { app, calls } = withInvites('send');
      expect((await post(app, '/api/member-invites', { email: 'cleo@acme.example', roleKey: 'rep' })).status).toBe(403);
      expect(calls).toEqual(['grant', 'mint', 'send', 'revokeLink', 'revokeRoles']);
    });

    it('invite: a row that cannot be written after the vertical agreed takes the vertical\'s record back too', async () => {
      const { app, calls, directory } = withInvites();
      directory.createInvite.mockImplementationOnce(async () => {
        throw new Error('directory unavailable');
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await post(app, '/api/member-invites', { email: 'cleo@acme.example', roleKey: 'rep' })).status).toBe(500);
      errors.mockRestore();
      expect(calls).toEqual(['grant', 'mint', 'send', 'cancel', 'revokeLink', 'revokeRoles']);
    });

    it.each([
      ['a role the worker does not offer', { email: 'cleo@acme.example', roleKey: 'owner' }],
      ['no address', { roleKey: 'rep' }],
    ])('invite: refuses %s before anything is minted', async (_label, body) => {
      const { app, calls } = withInvites();
      expect((await post(app, '/api/member-invites', body)).status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('invite: a role the inviter does not cover is refused by the bound, and the vertical is never asked', async () => {
      const { app, calls, host } = withInvites();
      host.assignScopeRoleBounded.mockResolvedValueOnce(LACKS);
      expect((await post(app, '/api/member-invites', { email: 'cleo@acme.example', roleKey: 'manager' })).status).toBe(403);
      expect(calls).not.toContain('send');
    });

    it('withdraw: the platform\'s half first, anyone it admitted unbound, then the vertical\'s record', async () => {
      const { app, calls, stub, named } = withInvites();
      expect((await post(app, `/api/member-invites/${invited}/withdraw`)).status).toBe(204);
      expect(calls).toEqual(['revokeRoles', 'revokeLink', 'revokeInvite', 'unbind', 'cancel']);
      expect(named.cancel).toHaveBeenCalledWith(stub, { principal: invited, email: 'cleo@acme.example', roleKey: 'rep' });
    });

    it('withdraw: a caller the bound refuses changes nothing, and the vertical is never asked', async () => {
      const { app, calls, host } = withInvites();
      host.revokeScopeRolesBounded.mockImplementationOnce(async () => {
        calls.push('revokeRoles');
        return { coverage: LACKS, revoked: [] };
      });
      expect((await post(app, `/api/member-invites/${invited}/withdraw`)).status).toBe(403);
      expect(calls).toEqual(['revokeRoles']);
    });

    it('withdraw: the vertical\'s refusal is the answer, and the invite is already gone', async () => {
      const { app, calls } = withInvites('cancel');
      expect((await post(app, `/api/member-invites/${invited}/withdraw`)).status).toBe(403);
      expect(calls).toEqual(['revokeRoles', 'revokeLink', 'revokeInvite', 'unbind', 'cancel']);
    });

    it('withdraw: no open invite is answered 204, and nothing is asked', async () => {
      const { app, calls, directory } = withInvites();
      directory.getInvite.mockResolvedValueOnce(null as never);
      expect((await post(app, `/api/member-invites/${invited}/withdraw`)).status).toBe(204);
      expect(calls).toEqual([]);
    });
  });
});
