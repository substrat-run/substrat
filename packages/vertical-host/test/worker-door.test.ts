/**
 * The door a deployed worker mounts (K-61). What is under test is what a project no longer
 * writes: nobody gets a stub, a stub carries the address the issuer verified and no other, and a
 * person arriving is joined and given their own record. And, since K-61 phase 3, an invited person
 * is admitted by that verified address, and a member invite is made and withdrawn here — the
 * platform's half first, the vertical's operation as the caller, and the one unwound by the other.
 */
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityId, principalId, scopeId, tenantId, type AttachmentRecord, type Coverage, type PermissionKey } from '@substrat-run/contracts';
import {
  bytesStream,
  mintCapabilitySecret,
  openAttachmentByteStream,
  ulid,
  type ByteRangeSpec,
  type TenantBlobStore,
} from '@substrat-run/kernel';
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
      canAssign: vi.fn(async () => { calls.push('canAssign'); return COVERED; }),
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
    expect(host.exchangeBecomeLinkById).toHaveBeenCalledWith(node.tenantId, node.scopeId, link, 'member invite');
    expect(host.getScope).toHaveBeenCalledWith(invited, node.tenantId, node.scopeId, { verifiedEmail: 'Cleo@Acme.example' });
  });

  it('with an address the issuer did not verify, no invite is looked for — 401', async () => {
    subject = signedIn({ sub: 'cleo', emailVerified: false });
    const { app, calls } = admitting();
    expect((await app.request('/')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each([
    ['no invite names the address — and the directory is not asked twice', null, undefined, 1],
    ['the scope refuses its link (expired, withdrawn, used) — and the directory is asked again for a racing binding', undefined, null, 2],
  ])('answers 401 when %s', async (_label, open, exchanged, resolves) => {
    subject = signedIn({ sub: 'cleo' });
    const { app, host, directory } = admitting({ open, exchanged });
    expect((await app.request('/')).status).toBe(401);
    expect(host.getScope).not.toHaveBeenCalled();
    expect(directory.resolvePrincipal).toHaveBeenCalledTimes(resolves);
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
        open: null,
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
      expect(calls).toEqual(['openInviteFor cleo@acme.example', 'grant', 'mint', 'send', 'record']);
      expect(host.assignScopeRoleBounded).toHaveBeenCalledWith(node.tenantId, node.scopeId, ann, body.principal, 'rep');
      expect(named.send).toHaveBeenCalledWith(stub, body);
    });

    it('invite: the vertical\'s refusal is the answer, no row is ever written, and the link and role go', async () => {
      const { app, calls } = withInvites('send');
      expect((await post(app, '/api/member-invites', { email: 'cleo@acme.example', roleKey: 'rep' })).status).toBe(403);
      expect(calls).toEqual(['openInviteFor cleo@acme.example', 'grant', 'mint', 'send', 'revokeLink', 'revokeRole']);
    });

    it('invite: on a host with no unbounded revoke, the refused invite\'s role goes by the inviter\'s bounded one', async () => {
      const { app, calls, host } = withInvites('send');
      delete (host as { revokeScopeRole?: unknown }).revokeScopeRole;
      expect((await post(app, '/api/member-invites', { email: 'cleo@acme.example', roleKey: 'rep' })).status).toBe(403);
      expect(calls).toEqual(['openInviteFor cleo@acme.example', 'grant', 'mint', 'send', 'revokeLink', 'revokeRoles']);
    });

    it('invite: a row that cannot be written after the vertical agreed takes the vertical\'s record back too', async () => {
      const { app, calls, directory } = withInvites();
      directory.createInvite.mockImplementationOnce(async () => {
        throw new Error('directory unavailable');
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await post(app, '/api/member-invites', { email: 'cleo@acme.example', roleKey: 'rep' })).status).toBe(500);
      errors.mockRestore();
      expect(calls).toEqual(['openInviteFor cleo@acme.example', 'grant', 'mint', 'send', 'cancel', 'revokeLink', 'revokeRole']);
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

    it('invite: an address an open invite already names is a 409, before anything is minted or mailed', async () => {
      const { app, calls, directory } = withInvites();
      directory.openInviteFor.mockResolvedValueOnce({ principal: invited, capabilityId: link });
      expect((await post(app, '/api/member-invites', { email: 'cleo@acme.example', roleKey: 'rep' })).status).toBe(409);
      expect(calls).toEqual([]);
    });

    it('withdraw: who may withdraw first — the bound, then the vertical — then the platform\'s half, and anyone it admitted', async () => {
      const { app, calls, stub, named } = withInvites();
      expect((await post(app, `/api/member-invites/${invited}/withdraw`)).status).toBe(204);
      expect(calls).toEqual(['canAssign', 'cancel', 'revokeRoles', 'revokeLink', 'revokeInvite', 'unbind']);
      expect(named.cancel).toHaveBeenCalledWith(stub, { principal: invited, email: 'cleo@acme.example', roleKey: 'rep' });
    });

    it('withdraw: a caller the bound refuses changes nothing, and the vertical is never asked', async () => {
      const { app, calls, host } = withInvites();
      host.canAssign.mockImplementationOnce(async () => {
        calls.push('canAssign');
        return LACKS;
      });
      expect((await post(app, `/api/member-invites/${invited}/withdraw`)).status).toBe(403);
      expect(calls).toEqual(['canAssign']);
    });

    it('withdraw: the vertical\'s refusal is the answer, and nothing of the invite is taken', async () => {
      const { app, calls } = withInvites('cancel');
      expect((await post(app, `/api/member-invites/${invited}/withdraw`)).status).toBe(403);
      expect(calls).toEqual(['canAssign', 'cancel']);
    });

    it('withdraw: an invite at a role the tenant no longer defines has no early bound, and still goes', async () => {
      const { app, calls, host } = withInvites();
      host.canAssign.mockRejectedValueOnce(new Error("unknown role 'rep'"));
      expect((await post(app, `/api/member-invites/${invited}/withdraw`)).status).toBe(204);
      expect(calls).toEqual(['cancel', 'revokeRoles', 'revokeLink', 'revokeInvite', 'unbind']);
    });

    it('withdraw: no open invite is answered 204, and nothing is asked', async () => {
      const { app, calls, directory } = withInvites();
      directory.getInvite.mockResolvedValueOnce(null as never);
      expect((await post(app, `/api/member-invites/${invited}/withdraw`)).status).toBe(204);
      expect(calls).toEqual([]);
    });
  });
});

/**
 * #3108: a seeded preview's personas, seated through the door. Each push binds a new script whose
 * identity directory starts empty while the scope's data is carried, so a re-seat links each
 * persona again as the same principal, and the world is built only where its people hold no role.
 */
describe('workerDoor — a seeded preview (#3108)', () => {
  const world = {
    personas: [
      { sub: 'dev|anna', name: 'Anna', email: 'anna@example.test', role: 'admin', note: 'admin' },
      { sub: 'dev|ivan', name: 'Ivan', email: 'ivan@example.test', invited: true },
      { sub: 'dev|eve', name: 'Eve', email: 'eve@example.test', role: 'admin', elsewhere: true },
    ],
    build: vi.fn(async () => undefined),
  };
  const deployment = () => {
    const links = new Map<string, string>();
    const roles = new Set<string>();
    const host = {
      assignScopeRole: vi.fn(async (_s: string, principal: string) => void roles.add(principal)),
      grantEntityShapeLocal: vi.fn(async () => undefined),
      hasScopeRoleLocal: vi.fn(async (_t: string, _s: string, principal: string) => roles.has(principal)),
      getScope: vi.fn(),
    };
    const directory = {
      boundPrincipal: vi.fn(async (_s: string, sub: string) => links.get(sub) ?? null),
      bindPersona: vi.fn(async (_s: string, sub: string, principal: string) => void links.set(sub, principal)),
    };
    const built = workerDoor<object>({
      directory: () => directory as never,
      nodeFor: () => node,
      hostFor: () => host as never,
      envSpec: [],
      world,
    });
    return { built, host, links, push: () => links.clear() };
  };

  it('offers the home cast, links it as the same principal after a push, and builds only where it is not seated', async () => {
    const d = deployment();
    const hook = d.built.platform.seedWorld!;
    expect(hook.personas.map((p) => p.sub)).toEqual(['dev|anna', 'dev|ivan']);

    await hook.seat({}, { ...node, build: false }); // a reused slot, first seeded: built anyway
    const anna = d.links.get('dev|anna');
    d.push();
    await hook.seat({}, { ...node, build: false }); // the next push: seated again, not built again
    expect(d.links.get('dev|anna')).toBe(anna);
    expect([...d.links.keys()]).toEqual(['dev|anna']);
    expect(d.host.assignScopeRole).toHaveBeenCalledWith(node.scopeId, anna, 'admin', 'person');
    expect(world.build).toHaveBeenCalledTimes(1);
  });
});

describe("the door's files (#3139)", () => {
  const BYTES = Uint8Array.from({ length: 10 }, (_, i) => i);
  const record = {
    id: 'att-1',
    entity: { entityType: 'item', entityId: 'i1' },
    filename: 'clip.mp3',
    contentType: 'audio/mpeg',
    visibility: 'internal',
    createdBy: String(ann),
    createdAt: '2026-11-13T00:00:00.000Z',
    size: BYTES.byteLength,
    sha256: createHash('sha256').update(BYTES).digest('hex'),
  } as AttachmentRecord;
  const store: TenantBlobStore = {
    put: async () => {},
    get: async () => null,
    getStream: async () => ({ stream: bytesStream(BYTES).stream, size: BYTES.byteLength }),
    getRangeStream: async (_key, { offset, length }) => ({
      stream: bytesStream(BYTES.slice(offset, offset + length)).stream,
      size: BYTES.byteLength,
    }),
    delete: async () => {},
    list: async () => [],
  };
  const sha256 = () => {
    const hash = createHash('sha256');
    return { update: (chunk: Uint8Array) => void hash.update(chunk), hex: async () => hash.digest('hex') };
  };

  /** A door with `attachments: true` over one file, `att-1`; the host verb is recorded. */
  function fileDoor(mount = true) {
    const files = {
      openStream: vi.fn(async (id: string, options?: { range?: ByteRangeSpec }) =>
        id === record.id ? openAttachmentByteStream(store, 'k', record, sha256, options?.range) : null,
      ),
      remove: vi.fn(async (id: string) => (id === record.id ? record : null)),
    };
    const attachments = vi.fn(async () => files);
    const built = workerDoor<object>({
      directory: () => ({ resolvePrincipal: async () => ann, openInviteFor: async () => null }) as never,
      nodeFor: () => node,
      hostFor: () => ({ getScope: async () => ({}), grantSelfShapesLocal: async () => [], attachments }) as never,
      envSpec: [],
      ...(mount ? { attachments: true as const } : {}),
    });
    const app = new Hono<{ Bindings: object }>();
    built.mount(app);
    const send = (method: string, headers: Record<string, string> = {}, id = record.id) =>
      app.request(`/api/attachments/${id}`, { method, headers });
    return { send, attachments, files };
  }

  it('serves the file as the person the session names, streamed and hardened', async () => {
    subject = signedIn();
    const { send, attachments } = fileDoor();
    const res = await send('GET');
    expect(res.status).toBe(200);
    expect(attachments).toHaveBeenCalledWith(ann, node.tenantId, node.scopeId);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...BYTES]);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'audio/mpeg',
      'content-length': '10',
      'content-disposition': expect.stringMatching(/^attachment; filename="clip\.mp3"/),
      'accept-ranges': 'bytes',
      etag: `"${record.sha256}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    });
  });

  it.each([
    ['a range', { Range: 'bytes=2-4' }, 206, 'bytes 2-4/10', [2, 3, 4]],
    ['a suffix', { Range: 'bytes=-3' }, 206, 'bytes 7-9/10', [7, 8, 9]],
    ['the whole file as a range, as a media element asks first', { Range: 'bytes=0-' }, 206, 'bytes 0-9/10', [...BYTES]],
    ['an If-Range naming another file', { Range: 'bytes=2-4', 'If-Range': `"${'0'.repeat(64)}"` }, 200, null, [...BYTES]],
    ['an If-Range that is a date', { Range: 'bytes=2-4', 'If-Range': 'Fri, 13 Nov 2026 00:00:00 GMT' }, 200, null, [...BYTES]],
    ['several ranges', { Range: 'bytes=0-1,4-5' }, 200, null, [...BYTES]],
  ])('answers %s', async (_label, headers, status, contentRange, body) => {
    subject = signedIn();
    const res = await fileDoor().send('GET', headers);
    expect(res.status).toBe(status);
    expect(res.headers.get('content-range')).toBe(contentRange);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(body);
  });

  it('answers a range with no byte in the file with a 416 problem naming the size', async () => {
    subject = signedIn();
    const res = await fileDoor().send('GET', { Range: 'bytes=10-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('answers a HEAD with the headers and no body', async () => {
    subject = signedIn();
    const res = await fileDoor().send('HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('');
  });

  it('removes the file as that person, and 404s an id it does not open, hardened all the same', async () => {
    subject = signedIn();
    const { send, files } = fileDoor();
    expect((await send('DELETE')).status).toBe(204);
    expect(files.remove).toHaveBeenCalledWith(record.id);
    expect((await send('DELETE', {}, 'nope')).status).toBe(404);
    const missing = await send('GET', {}, 'nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers 401 for nobody, and mints no file surface', async () => {
    subject = null;
    const { send, attachments } = fileDoor();
    expect((await send('GET')).status).toBe(401);
    expect(attachments).not.toHaveBeenCalled();
  });

  it('mounts no file route unless the worker names `attachments`', async () => {
    subject = signedIn();
    const { send, attachments } = fileDoor(false);
    expect((await send('GET')).status).toBe(404);
    expect(attachments).not.toHaveBeenCalled();
  });
});
