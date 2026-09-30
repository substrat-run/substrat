/**
 * The shared invite routes (#1150), driven over HTTP against stand-ins for everything a
 * vertical supplies: a directory (an in-memory copy of the identity DO's invite half), a
 * host that records grants, an auth provider that reads a bearer subject, and an admin gate
 * that reads a header. What is asserted is the contract the three copies used to agree on
 * by coincidence — the status codes, the shapes, that only the token's HASH reaches the
 * directory, and that the role is granted BEFORE the invite is recorded — and, since #1931,
 * that an admin confers (or takes back) only a role whose permissions they already hold.
 *
 * The bound here is a stand-in with the kernel's answer shape; that the HOST's `canAssign`
 * gives `ctx.canAssign`'s answer, narrowing included, is held by the permission contract
 * suite on both adapters, and the routes over a real host by the adapters' own suites.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, type Coverage, type PermissionKey, type PrincipalId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { mountInviteRoutes, type InviteDirectory, type InviteRouteDeps } from '../src/invite-routes.js';
import { sha256Hex } from '../src/owner-claim-link.js';
import type { AuthProvider, AuthSubject } from '../src/provider.js';

interface Env {
  SUBJECTS: Record<string, AuthSubject>;
}

type Invite = { principal: string; roleKey: string; email: string | null; createdAt: number; tokenHash: string };

/** The identity DO's invite half, in memory: rows keyed by principal, bound subjects beside them. */
class MemoryDirectory implements InviteDirectory {
  readonly invites = new Map<string, Invite>();
  readonly bound = new Map<string, string>();
  constructor(readonly log: string[]) {}
  async createInvite(scopeId: string, principal: string, roleKey: string, email: string | null, tokenHash: string) {
    this.log.push(`createInvite ${scopeId} ${principal} ${roleKey}`);
    this.invites.set(principal, { principal, roleKey, email, createdAt: 1_700_000_000_000, tokenHash });
  }
  async listInvites() {
    return [...this.invites.values()].map(({ tokenHash: _hash, ...row }) => row);
  }
  async getInvite(_scopeId: string, principal: string) {
    const row = this.invites.get(principal);
    if (!row) return null;
    const { tokenHash: _hash, ...rest } = row;
    return rest;
  }
  async revokeInvite(scopeId: string, principal: string) {
    this.log.push(`revokeInvite ${scopeId} ${principal}`);
    this.invites.delete(principal);
  }
  async claimInvite(_scopeId: string, sub: string, tokenHash: string) {
    const row = [...this.invites.values()].find((r) => r.tokenHash === tokenHash);
    if (!row) return null;
    this.invites.delete(row.principal);
    this.bound.set(sub, row.principal);
    return row.principal;
  }
}

const NODE = { tenantId: 'tenant-a', scopeId: 'scope-1' };
const ROLES = ['admin', 'editor'] as const;

/**
 * What each role carries, and what each caller the admin gate admits holds. `junior` passes
 * the gate (it may manage members) but holds less than `admin` carries — the caller the
 * bound exists for. `owner` holds everything.
 */
const ROLE_PERMS: Record<string, PermissionKey[]> = {
  admin: ['doc:read', 'doc:write', 'member:manage', 'billing:manage'] as PermissionKey[],
  editor: ['doc:read', 'doc:write'] as PermissionKey[],
};
const OWNER = principalId.parse(ulid());
const JUNIOR = principalId.parse(ulid());
const HELD: Record<string, PermissionKey[]> = {
  [OWNER]: ['doc:read', 'doc:write', 'member:manage', 'billing:manage'] as PermissionKey[],
  [JUNIOR]: ['doc:read', 'doc:write', 'member:manage'] as PermissionKey[],
};

/** The kernel's bound, over the table above: every permission the role carries must be held. */
const boundOf = (principal: PrincipalId, roleKey: string): Coverage => {
  const missing = (ROLE_PERMS[roleKey] ?? []).filter((p) => !(HELD[principal] ?? []).includes(p));
  return missing.length === 0 ? { covered: true, missing: [] } : { covered: false, missing: missing as [PermissionKey, ...PermissionKey[]] };
};

let log: string[];
let directory: MemoryDirectory;
let app: Hono<{ Bindings: Env }>;

const env = (): Env => ({
  SUBJECTS: {
    'tok-owner': { sub: 'sub-owner', email: 'owner@acme.example', name: 'Owner' },
    'tok-newcomer': { sub: 'sub-newcomer', email: 'new@acme.example', name: 'Newcomer' },
  },
});

const provider = (env: Env): AuthProvider => ({
  resolve: async (headers) => {
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '');
    return (bearer && env.SUBJECTS[bearer]) || null;
  },
  handle: async () => new Response(null, { status: 404 }),
});

beforeEach(() => {
  log = [];
  directory = new MemoryDirectory(log);
  app = new Hono<{ Bindings: Env }>();
  // A deliberately naive envelope: an HTTPException keeps its status and ANYTHING else is a
  // 500. That is what pins the mount's promise — every error it raises itself is an
  // HTTPException — because a `ZodError` or a `SyntaxError` escaping would show up here as
  // a 500, where a vertical's own envelope might have papered over it.
  app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: err.message }, 500)));
  mountInviteRoutes(app, deps());
});

/** The deps this suite mounts with; a case that wires one short overrides it. */
function deps(overrides: Partial<InviteRouteDeps<Env, typeof NODE>> = {}): InviteRouteDeps<Env, typeof NODE> {
  return {
    nodeFor: async () => NODE,
    // The vertical's gate: in the demos a whoami; here the caller says so with a header, and
    // who they are with another.
    requireAdmin: async (c) => {
      if (!c.req.header('authorization')) throw new HTTPException(401, { message: 'unauthorized' });
      if (c.req.header('x-test-admin') !== 'yes') throw new HTTPException(403, { message: 'only an admin can manage invites' });
      return { principal: c.req.header('x-test-caller') === 'junior' ? JUNIOR : OWNER };
    },
    roles: ROLES,
    directory: () => directory,
    assignScopeRole: async (_env, scopeId, principal, roleKey) => {
      log.push(`assignScopeRole ${scopeId} ${principal} ${roleKey}`);
    },
    revokeScopeRole: async (_env, scopeId, principal, roleKey) => {
      log.push(`revokeScopeRole ${scopeId} ${principal} ${roleKey}`);
    },
    canAssign: async (_env, node, principal, roleKey) => {
      log.push(`canAssign ${node.scopeId} ${principal} ${roleKey}`);
      return boundOf(principal, roleKey);
    },
    authProvider: async (env) => provider(env),
    ...overrides,
  };
}

const admin = { authorization: 'Bearer tok-owner', 'x-test-admin': 'yes' };
const junior = { ...admin, 'x-test-caller': 'junior' };
const json = (body: unknown, headers: Record<string, string> = admin) => ({
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('mountInviteRoutes', () => {
  it('lists the vertical roles and the open invites, for an admin only', async () => {
    const res = await app.request('http://app.example/api/invites', { headers: admin }, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roles: ['admin', 'editor'], invites: [] });

    const nobody = await app.request('http://app.example/api/invites', {}, env());
    expect(nobody.status).toBe(401);
    const member = await app.request('http://app.example/api/invites', { headers: { authorization: 'Bearer tok-owner' } }, env());
    expect(member.status).toBe(403);
  });

  it('creates an invite: grants the role first, stores only the token hash, returns the accept link', async () => {
    const res = await app.request('http://app.example/api/invites', json({ email: 'new@acme.example', roleKey: 'editor' }), env());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { principal: string; roleKey: string; email: string | null; acceptUrl: string };
    expect(body.principal).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.roleKey).toBe('editor');
    expect(body.email).toBe('new@acme.example');

    // The link opens the app at the request's own origin, and carries the plaintext token.
    const url = new URL(body.acceptUrl);
    expect(url.origin).toBe('http://app.example');
    expect(url.pathname).toBe('/');
    const token = url.searchParams.get('invite')!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // The directory holds the HASH, never the token.
    const row = directory.invites.get(body.principal)!;
    expect(row.tokenHash).toBe(await sha256Hex(token));
    expect(row.tokenHash).not.toBe(token);

    // The bound first, then grant before row: an invite whose principal holds nothing would
    // bind a teammate to no access.
    expect(log).toEqual([
      `canAssign scope-1 ${OWNER} editor`,
      `assignScopeRole scope-1 ${body.principal} editor`,
      `createInvite scope-1 ${body.principal} editor`,
    ]);

    const list = (await (await app.request('http://app.example/api/invites', { headers: admin }, env())).json()) as {
      invites: Array<{ principal: string; email: string | null }>;
    };
    expect(list.invites).toEqual([{ principal: body.principal, roleKey: 'editor', email: 'new@acme.example', createdAt: 1_700_000_000_000 }]);
  });

  it('refuses a role the vertical does not declare, before anything is granted or recorded', async () => {
    const res = await app.request('http://app.example/api/invites', json({ roleKey: 'owner' }), env());
    expect(res.status).toBe(400);
    expect(log).toEqual([]);
    expect(directory.invites.size).toBe(0);
  });

  it('needs no email; a body that does not fit is a 400 the mount raises itself, not a throw the vertical must catch', async () => {
    const res = await app.request('http://app.example/api/invites', json({ roleKey: 'admin' }), env());
    expect(res.status).toBe(201);
    expect(((await res.json()) as { email: string | null }).email).toBeNull();
    expect(log).toHaveLength(3); // one bound, one grant, one row

    // A schema miss and a body that is not JSON at all both come out as an HTTPException
    // 400 naming the problem — under this suite's envelope a bare ZodError or SyntaxError
    // would be a 500 — and nothing was granted on the way.
    const bad = await app.request('http://app.example/api/invites', json({ email: 'x' }), env());
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/roleKey/);
    const notJson = await app.request('http://app.example/api/invites', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: '{not json',
    }, env());
    expect(notJson.status).toBe(400);
    expect(await notJson.text()).toMatch(/must be JSON/);
    expect(log).toHaveLength(3);
  });

  it('takes the grant back when the invite row cannot be written, so a retry mints no orphan', async () => {
    // The grant and the row live in two Durable Objects with no transaction between
    // them. A create that fails after the grant would otherwise leave a principal nobody
    // can bind to holding a role — and every retry another one.
    directory.createInvite = async () => {
      throw new Error('directory unavailable');
    };
    const res = await app.request('http://app.example/api/invites', json({ roleKey: 'admin' }), env());
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/directory unavailable/); // the ORIGINAL failure, not the revoke's
    expect(log.map((l) => l.split(' ')[0])).toEqual(['canAssign', 'assignScopeRole', 'revokeScopeRole']);
    const [, grant, revoke] = log;
    // The same (scope, principal, role) the grant named.
    expect(revoke!.replace('revokeScopeRole', 'assignScopeRole')).toBe(grant);
    expect(directory.invites.size).toBe(0);
  });

  it('revokes an invite, for an admin only', async () => {
    const created = (await (await app.request('http://app.example/api/invites', json({ roleKey: 'admin' }), env())).json()) as {
      principal: string;
    };
    const member = await app.request(
      `http://app.example/api/invites/${created.principal}/revoke`,
      { method: 'POST', headers: { authorization: 'Bearer tok-owner' } },
      env(),
    );
    expect(member.status).toBe(403);
    expect(directory.invites.has(created.principal)).toBe(true);

    const res = await app.request(`http://app.example/api/invites/${created.principal}/revoke`, { method: 'POST', headers: admin }, env());
    expect(res.status).toBe(204);
    expect(directory.invites.has(created.principal)).toBe(false);
  });

  it('accepts an invite once, for a signed-in subject, by the token from the accept link', async () => {
    const created = (await (await app.request('http://app.example/api/invites', json({ roleKey: 'editor' }), env())).json()) as {
      principal: string;
      acceptUrl: string;
    };
    const token = new URL(created.acceptUrl).searchParams.get('invite')!;

    // Not signed in: 401, and nothing is bound.
    const anon = await app.request('http://app.example/api/accept-invite', json({ token }, {}), env());
    expect(anon.status).toBe(401);
    expect(directory.bound.size).toBe(0);

    // A wrong token: one answer, nothing bound.
    const wrong = await app.request('http://app.example/api/accept-invite', json({ token: 'nope' }, { authorization: 'Bearer tok-newcomer' }), env());
    expect(wrong.status).toBe(400);
    expect(directory.bound.size).toBe(0);

    // The right token binds the subject to the pre-minted principal — no admin needed.
    const ok = await app.request('http://app.example/api/accept-invite', json({ token }, { authorization: 'Bearer tok-newcomer' }), env());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, principal: created.principal });
    expect(directory.bound.get('sub-newcomer')).toBe(created.principal);

    // Used up: the same token answers exactly as a wrong one does.
    const again = await app.request('http://app.example/api/accept-invite', json({ token }, { authorization: 'Bearer tok-owner' }), env());
    expect(again.status).toBe(400);
  });

  it('builds the accept link on a supplied origin when the vertical has one', async () => {
    const other = new Hono<{ Bindings: Env }>();
    mountInviteRoutes(
      other,
      deps({
        // With the trailing slash a configured origin so often carries: the link must not
        // come out as `https://host//?invite=…`, which is a different SPA path.
        origin: () => 'https://public.acme.example/',
      }),
    );
    const res = await other.request('http://internal.local/api/invites', json({ roleKey: 'admin' }), env());
    expect(((await res.json()) as { acceptUrl: string }).acceptUrl).toMatch(/^https:\/\/public\.acme\.example\/\?invite=[0-9a-f]{64}$/);
  });
});

/**
 * The assignment bound on the two routes that confer or remove a role (#1931). The admin gate
 * answers "may you manage members at all"; the bound answers "may you confer this much", and
 * removal takes the same bound. Every refusal leaves the directory and the host untouched.
 */
describe('mountInviteRoutes — the canAssign bound', () => {
  const create = (roleKey: string, headers: Record<string, string> = admin) =>
    app.request('http://app.example/api/invites', json({ roleKey }, headers), env());
  const revoke = (principal: string, headers: Record<string, string> = admin) =>
    app.request(`http://app.example/api/invites/${principal}/revoke`, { method: 'POST', headers }, env());
  /** What reached the host or the directory's writers — the bound's own reads excluded. */
  const writes = () => log.filter((l) => !l.startsWith('canAssign'));

  it('refuses an admin who lacks what the role carries — 403 naming it, nothing granted or recorded', async () => {
    const res = await create('admin', junior);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/cannot invite at 'admin': you do not hold billing:manage/);
    expect(log).toEqual([`canAssign scope-1 ${JUNIOR} admin`]); // asked about the caller the gate admitted
    expect(writes()).toEqual([]);
    expect(directory.invites.size).toBe(0);
  });

  it('...while the same admin invites at a role they hold all of', async () => {
    const res = await create('editor', junior);
    expect(res.status).toBe(201);
    expect(directory.invites.size).toBe(1);
  });

  it('lets an owner, who holds everything, invite at the highest role', async () => {
    const res = await create('admin');
    expect(res.status).toBe(201);
    expect(log[0]).toBe(`canAssign scope-1 ${OWNER} admin`);
  });

  it('bounds revoke by the role the STORED invite confers — refused, and the invite stays', async () => {
    const created = (await (await create('admin')).json()) as { principal: string };
    log.length = 0;
    const res = await revoke(created.principal, junior);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/cannot revoke an invite at 'admin': you do not hold billing:manage/);
    expect(log).toEqual([`canAssign scope-1 ${JUNIOR} admin`]);
    expect(directory.invites.has(created.principal)).toBe(true);
  });

  it('...while the same admin revokes an invite at a role they hold, and the owner revokes the higher one', async () => {
    const editor = (await (await create('editor')).json()) as { principal: string };
    const higher = (await (await create('admin')).json()) as { principal: string };
    expect((await revoke(editor.principal, junior)).status).toBe(204);
    expect(directory.invites.has(editor.principal)).toBe(false);
    expect((await revoke(higher.principal)).status).toBe(204);
    expect(directory.invites.has(higher.principal)).toBe(false);
  });

  it('a revoke of no open invite answers 204 as before, and asks the bound nothing', async () => {
    const res = await revoke(ulid(), junior);
    expect(res.status).toBe(204);
    expect(log).toEqual([]);
  });

  it('an unknown role is still the 400 it was, decided before the bound is asked', async () => {
    const res = await create('owner', junior);
    expect(res.status).toBe(400);
    expect(log).toEqual([]);
  });

  /**
   * Order: the gate still runs before the body matters. A caller it refuses gets exactly the
   * refusal they got before, whatever they sent — so a malformed body tells a non-admin
   * nothing, and the bound is never asked on their behalf.
   */
  describe('the admin gate still refuses first, before the body', () => {
    const member = { authorization: 'Bearer tok-owner' };
    const nobody = {};

    it('a non-admin gets the same 403 for a valid body, a malformed one and one that is not JSON', async () => {
      const valid = await create('admin', member);
      const malformed = await app.request('http://app.example/api/invites', json({ email: 'x' }, member), env());
      const notJson = await app.request(
        'http://app.example/api/invites',
        { method: 'POST', headers: { ...member, 'content-type': 'application/json' }, body: '{not json' },
        env(),
      );
      const answers = await Promise.all([valid, malformed, notJson].map(async (r) => [r.status, await r.text()]));
      expect(answers[0]).toEqual([403, 'only an admin can manage invites']);
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[2]).toEqual(answers[0]);
      expect(log).toEqual([]);
    });

    it('nobody gets the same 401 whatever the body', async () => {
      const valid = await create('admin', nobody);
      const malformed = await app.request('http://app.example/api/invites', json({ email: 'x' }, nobody), env());
      expect([valid.status, await valid.text()]).toEqual([401, 'unauthorized']);
      expect([malformed.status, await malformed.text()]).toEqual([401, 'unauthorized']);
      expect(log).toEqual([]);
    });

    it('a non-admin revoking gets the gate\'s 403, and the stored invite is never read for them', async () => {
      const created = (await (await create('admin')).json()) as { principal: string };
      log.length = 0;
      let reads = 0;
      const getInvite = directory.getInvite.bind(directory);
      directory.getInvite = async (...args) => {
        reads++;
        return getInvite(...args);
      };
      const res = await revoke(created.principal, member);
      expect([res.status, await res.text()]).toEqual([403, 'only an admin can manage invites']);
      expect(reads).toBe(0);
      expect(log).toEqual([]);
      expect(directory.invites.has(created.principal)).toBe(true);
    });
  });

  /**
   * Fail closed: a mount wired short refuses the two routes that confer or remove a role,
   * rather than running them unbounded. Each case pairs with the working mount above.
   */
  describe('a mount wired short refuses, never runs unbounded', () => {
    const remount = (overrides: Partial<InviteRouteDeps<Env, typeof NODE>>) => {
      app = new Hono<{ Bindings: Env }>();
      app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: err.message }, 500)));
      mountInviteRoutes(app, deps(overrides));
    };

    it('no canAssign dep (a JS caller, or a cast) — create and revoke refuse, nothing written', async () => {
      const seeded = (await (await create('editor')).json()) as { principal: string };
      log.length = 0;
      remount({ canAssign: undefined as never });
      const res = await create('editor');
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/without the canAssign bound/);
      const rev = await revoke(seeded.principal);
      expect(rev.status).toBe(500);
      expect(writes()).toEqual([]);
      expect(directory.invites.size).toBe(1); // the seeded one, untouched
    });

    it('a gate that names no caller (the pre-#1931 shape) — refused, nothing written', async () => {
      remount({ requireAdmin: (async () => undefined) as never });
      const res = await create('editor');
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/named no caller/);
      expect(log).toEqual([]);
      expect(directory.invites.size).toBe(0);
    });

    it('a bound that answers with no coverage, or an inconsistent one — refused, nothing written', async () => {
      for (const answer of [undefined, { covered: true }, { covered: true, missing: ['billing:manage'] }, { allowed: true }]) {
        remount({ canAssign: (async () => answer) as never });
        const res = await create('editor');
        expect(res.status).toBe(500);
        expect(await res.text()).toMatch(/did not answer with a coverage/);
      }
      expect(writes()).toEqual([]);
      expect(directory.invites.size).toBe(0);
    });

    it('a bound that throws — the throw is the answer, and nothing was written', async () => {
      remount({
        canAssign: async () => {
          throw new Error('no such role in this tenant: editor');
        },
      });
      const res = await create('editor');
      expect(res.status).toBe(500);
      expect(writes()).toEqual([]);
      expect(directory.invites.size).toBe(0);
    });
  });
});
