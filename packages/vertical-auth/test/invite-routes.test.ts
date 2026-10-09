/**
 * The shared invite routes (#1150), driven over HTTP against stand-ins for everything a
 * vertical supplies: a directory (an in-memory copy of the identity DO's invite half), a
 * host that records grants, an auth provider that reads a bearer subject, and an admin gate
 * that reads a header. What is asserted is the contract the three copies used to agree on
 * by coincidence — the status codes, the shapes, that only the token's HASH reaches the
 * directory, and that the role is granted BEFORE the invite is recorded — and, since #1931,
 * that an admin confers (or takes back) only a role whose permissions they already hold.
 *
 * The bound here is a stand-in with the kernel's answer shape; that the HOST's bounded verbs
 * give `ctx.canAssign`'s answer, narrowing included, is held by the permission contract
 * suite on both adapters, and the routes over a real host by the adapters' own suites.
 *
 * Since #1686 the token is a `become` capability's secret, and the stand-in host keeps those
 * too (`capabilities`): its bound is the same table's, its exchange single-use. What THIS file
 * holds is the routes' order around them — mint after the grant, the row naming the
 * capability, an accept asking the directory before it spends a use, a withdrawal revoking the
 * link — and that an invite minted before #1686 still accepts by its hash.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  BECOME_LINK_STATES_MAX_IDS,
  capabilityId,
  principalId,
  substratError,
  type BoundedBecomeMint,
  type CapabilityExchange,
  type Coverage,
  type PermissionKey,
  type PrincipalId,
} from '@substrat-run/contracts';
import { mintCapabilitySecret, ulid, unknownRoleError } from '@substrat-run/kernel';
import { mountInviteRoutes, withLinkStates, type InviteDirectory, type InviteRouteDeps } from '../src/invite-routes.js';
import { sha256Hex } from '../src/owner-claim-link.js';
import type { AuthProvider, AuthSubject } from '../src/provider.js';

interface Env {
  SUBJECTS: Record<string, AuthSubject>;
}

type Invite = {
  principal: string;
  roleKey: string;
  email: string | null;
  createdAt: number;
  tokenHash: string;
  capabilityId: string | null;
};

/** The identity DO's invite half, in memory: rows keyed by principal, bound subjects beside them. */
class MemoryDirectory implements InviteDirectory {
  readonly invites = new Map<string, Invite>();
  readonly bound = new Map<string, string>();
  constructor(readonly log: string[]) {}
  async createInvite(
    scopeId: string, principal: string, roleKey: string, email: string | null, tokenHash: string, capabilityId: string | null = null,
  ) {
    this.log.push(`createInvite ${scopeId} ${principal} ${roleKey}`);
    this.invites.set(principal, { principal, roleKey, email, createdAt: 1_700_000_000_000, tokenHash, capabilityId });
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
    const link = this.invites.get(principal)?.capabilityId ?? null;
    this.invites.delete(principal);
    return link;
  }
  /** LEGACY: a hash-only row (no capability), as `member-directory.ts`'s `claimInvite`. */
  async claimInvite(_scopeId: string, sub: string, tokenHash: string) {
    const row = [...this.invites.values()].find((r) => r.tokenHash === tokenHash && r.capabilityId === null);
    if (!row) return null;
    this.invites.delete(row.principal);
    this.bound.set(sub, row.principal);
    return row.principal;
  }
  async inviteLink(_scopeId: string, principal: string) {
    return this.invites.get(principal)?.capabilityId ?? null;
  }
  async inviteMatches(_scopeId: string, tokenHash: string) {
    this.log.push('inviteMatches');
    return [...this.invites.values()].some((r) => r.tokenHash === tokenHash && r.capabilityId !== null);
  }
  async claimInviteByCapability(_scopeId: string, sub: string, capabilityId: string, principal: string) {
    const row = [...this.invites.values()].find((r) => r.capabilityId === capabilityId && r.principal === principal);
    if (!row) return null;
    this.invites.delete(row.principal);
    this.bound.set(sub, row.principal);
    return row.principal;
  }
}

/** A `become` capability as the stand-in scope keeps it — the hash of its secret, never the secret. */
type Capability = { id: string; tokenHash: string; principal: string; minter: string; uses: number; revokedBy: string | null };

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
  [OWNER]: ROLE_PERMS.admin!,
  [JUNIOR]: ['doc:read', 'doc:write', 'member:manage'] as PermissionKey[],
};

/** The kernel's bound, over the table above: every permission the role carries must be held. */
const boundOf = (principal: PrincipalId, roleKey: string): Coverage => {
  const missing = (ROLE_PERMS[roleKey] ?? []).filter((p) => !(HELD[principal] ?? []).includes(p));
  return missing.length === 0 ? { covered: true, missing: [] } : { covered: false, missing: missing as [PermissionKey, ...PermissionKey[]] };
};

let log: string[];
let directory: MemoryDirectory;
/** The stand-in scope's capability directory. */
let capabilities: Map<string, Capability>;
/** The scope's role tuples, as the stand-in host keeps them: principal → roles held. */
let scopeRoles: Map<string, Set<string>>;
const holds = (principal: string): string[] => [...(scopeRoles.get(principal) ?? [])].sort();
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
  scopeRoles = new Map();
  capabilities = new Map();
  directory = new MemoryDirectory(log);
  app = mount();
});

/**
 * A fresh app with the routes mounted. A deliberately naive envelope: an HTTPException keeps
 * its status and ANYTHING else is a 500. That is what pins the mount's promise — every error
 * it raises itself is an HTTPException — because a `ZodError` or a `SyntaxError` escaping
 * would show up here as a 500, where a vertical's own envelope might have papered over it.
 */
function mount(overrides: Partial<InviteRouteDeps<Env, typeof NODE>> = {}): Hono<{ Bindings: Env }> {
  const fresh = new Hono<{ Bindings: Env }>();
  fresh.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: err.message }, 500)));
  mountInviteRoutes(fresh, deps(overrides));
  return fresh;
}

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
    assignScopeRoleBounded: async (_env, node, caller, principal, roleKey) => {
      log.push(`assignScopeRoleBounded ${node.scopeId} ${caller} ${principal} ${roleKey}`);
      const bound = boundOf(caller, roleKey);
      if (bound.covered) scopeRoles.set(principal, new Set([...holds(principal), roleKey]));
      return bound;
    },
    revokeScopeRole: async (_env, scopeId, principal, roleKey) => {
      log.push(`revokeScopeRole ${scopeId} ${principal} ${roleKey}`);
      scopeRoles.get(principal)?.delete(roleKey);
    },
    // The host's bounded revoke: the bound over every role the principal HOLDS, a role the
    // tenant does not define taken without one, then all of them or none.
    revokeScopeRolesBounded: async (_env, node, caller, principal) => {
      log.push(`revokeScopeRolesBounded ${node.scopeId} ${caller} ${principal}`);
      const held = holds(principal);
      const missing = [...new Set(held.flatMap((r) => (ROLE_PERMS[r] ? (boundOf(caller, r).missing as string[]) : [])))].sort();
      if (missing.length > 0) return { coverage: { covered: false, missing: missing as [PermissionKey, ...PermissionKey[]] }, revoked: [] };
      scopeRoles.delete(principal);
      return { coverage: { covered: true, missing: [] }, revoked: held };
    },
    // The host's bounded `become` mint: the caller must hold everything the target holds — here,
    // every role the stand-in scope says it holds.
    mintBecomeCapabilityBounded: async (_env, node, caller, input): Promise<BoundedBecomeMint> => {
      log.push(`mintBecomeCapabilityBounded ${node.scopeId} ${caller} ${input.principal}`);
      const missing = [...new Set(holds(input.principal).flatMap((r) => boundOf(caller, r).missing as string[]))];
      if (missing.length > 0) return { ok: false, coverage: { covered: false, missing: missing as [PermissionKey, ...PermissionKey[]] } };
      const id = capabilityId.parse(ulid());
      const secret = mintCapabilitySecret();
      capabilities.set(id, { id, tokenHash: await sha256Hex(secret), principal: input.principal, minter: caller, uses: 0, revokedBy: null });
      return { ok: true, minted: { id, secret, expiresAt: null } };
    },
    revokeBecomeCapability: async (_env, node, id, by) => {
      log.push(`revokeBecomeCapability ${node.scopeId} ${id} ${by}`);
      const cap = capabilities.get(id);
      if (!cap || cap.revokedBy) return { ok: true, revoked: false };
      cap.revokedBy = by;
      return { ok: true, revoked: true };
    },
    becomeLinkStates: async (_env, _node, ids) =>
      ids.map((id) => {
        const cap = capabilities.get(id);
        if (!cap || cap.revokedBy) return { state: 'revoked' as const, reason: null };
        return cap.uses >= 1 ? { state: 'used' as const, reason: null } : { state: 'open' as const, reason: null };
      }),
    // The scope's exchange: single use, refused once revoked.
    exchangeCapability: async (_env, _node, secret): Promise<CapabilityExchange | null> => {
      log.push('exchangeCapability');
      const hash = await sha256Hex(secret);
      const cap = [...capabilities.values()].find((c) => c.tokenHash === hash);
      if (!cap || cap.revokedBy || cap.uses >= 1) return null;
      cap.uses++;
      return { kind: 'principal', capabilityId: capabilityId.parse(cap.id), principal: principalId.parse(cap.principal) };
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
    // #1686: the token is a capability secret, minted for the pre-minted principal by the caller.
    expect(token).toMatch(/^sbcap_/);
    const cap = [...capabilities.values()][0]!;
    expect(cap).toMatchObject({ principal: body.principal, minter: OWNER, uses: 0, revokedBy: null });

    // The directory holds the HASH, never the token — and names the capability it is.
    const row = directory.invites.get(body.principal)!;
    expect(row.tokenHash).toBe(await sha256Hex(token));
    expect(row.tokenHash).not.toBe(token);
    expect(row.capabilityId).toBe(cap.id);

    // The bounded grant first, then the link, then the row: an invite whose principal holds
    // nothing would bind a teammate to no access.
    expect(log).toEqual([
      `assignScopeRoleBounded scope-1 ${OWNER} ${body.principal} editor`,
      `mintBecomeCapabilityBounded scope-1 ${OWNER} ${body.principal}`,
      `createInvite scope-1 ${body.principal} editor`,
    ]);

    const list = (await (await app.request('http://app.example/api/invites', { headers: admin }, env())).json()) as {
      invites: Array<{ principal: string; email: string | null }>;
    };
    expect(list.invites).toEqual([
      { principal: body.principal, roleKey: 'editor', email: 'new@acme.example', createdAt: 1_700_000_000_000, link: { state: 'open', reason: null } },
    ]);
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
    expect(log).toHaveLength(3); // bounded grant, link, then row

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
    // #1686: the link minted for it is revoked too, before the grant goes.
    expect(log.map((l) => l.split(' ')[0])).toEqual([
      'assignScopeRoleBounded', 'mintBecomeCapabilityBounded', 'revokeBecomeCapability', 'revokeScopeRole',
    ]);
    expect([...capabilities.values()].map((c) => c.revokedBy)).toEqual([OWNER]);
    const [grant, , , revoke] = log;
    // The same (scope, principal, role) the grant named.
    const [, grantScope, , grantPrincipal, grantRole] = grant!.split(' ');
    expect(revoke).toBe(`revokeScopeRole ${grantScope} ${grantPrincipal} ${grantRole}`);
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
    // #1686: and its link is revoked in the scope, by the admin who withdrew it.
    expect([...capabilities.values()].map((c) => c.revokedBy)).toEqual([OWNER]);
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
    expect(((await res.json()) as { acceptUrl: string }).acceptUrl).toMatch(/^https:\/\/public\.acme\.example\/\?invite=sbcap_[A-Za-z0-9_-]+$/);
  });
});

/**
 * The assignment bound on the two routes that confer or remove a role (#1931). The admin gate
 * answers "may you manage members at all"; the bound answers "may you confer this much", and
 * removal takes the same bound. Every refusal leaves the directory and the host untouched.
 */
describe('mountInviteRoutes — the assignment bound', () => {
  const create = (roleKey: string, headers: Record<string, string> = admin) =>
    app.request('http://app.example/api/invites', json({ roleKey }, headers), env());
  const revoke = (principal: string, headers: Record<string, string> = admin) =>
    app.request(`http://app.example/api/invites/${principal}/revoke`, { method: 'POST', headers }, env());
  /** What reached the host or the directory's writers — the bound's own reads excluded. */
  const writes = () => log.filter((l) => !l.startsWith('assignScopeRoleBounded'));

  it('refuses an admin who lacks what the role carries — 403 naming it, nothing granted or recorded', async () => {
    const res = await create('admin', junior);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/cannot invite at 'admin': you do not hold billing:manage/);
    expect(log[0]).toMatch(new RegExp(`^assignScopeRoleBounded scope-1 ${JUNIOR} [A-Z0-9]+ admin$`));
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
    expect(log[0]).toMatch(new RegExp(`^assignScopeRoleBounded scope-1 ${OWNER} [A-Z0-9]+ admin$`));
  });

  it('bounds a withdrawal by the roles the invite\'s principal holds — refused, and the invite and its role stay', async () => {
    const created = (await (await create('admin')).json()) as { principal: string };
    log.length = 0;
    const res = await revoke(created.principal, junior);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(new RegExp(`cannot withdraw the invite of '${created.principal}': you do not hold billing:manage`));
    expect(log).toEqual([`revokeScopeRolesBounded scope-1 ${JUNIOR} ${created.principal}`]);
    expect(directory.invites.has(created.principal)).toBe(true);
    expect(holds(created.principal)).toEqual(['admin']);
  });

  it('...while the same admin withdraws one at a role they hold, and the owner the higher one — the grants going too', async () => {
    const editor = (await (await create('editor')).json()) as { principal: string };
    const higher = (await (await create('admin')).json()) as { principal: string };
    expect((await revoke(editor.principal, junior)).status).toBe(204);
    expect(directory.invites.has(editor.principal)).toBe(false);
    expect(holds(editor.principal)).toEqual([]);
    expect((await revoke(higher.principal)).status).toBe(204);
    expect(directory.invites.has(higher.principal)).toBe(false);
    expect(holds(higher.principal)).toEqual([]);
  });

  /**
   * The row's `roleKey` is what was minted, and authorizes nothing (Codex #2057 r2). A role move
   * can land between an invite's grant and its row — the row then says `editor` while its
   * principal holds `admin` — and the withdrawal must still be bounded by `admin`.
   */
  it('refuses a withdrawal by the stale row\'s role when the principal now holds more', async () => {
    const created = (await (await create('editor')).json()) as { principal: string };
    scopeRoles.set(created.principal, new Set(['admin'])); // moved, after the row was written
    expect(directory.invites.get(created.principal)?.roleKey).toBe('editor');
    const res = await revoke(created.principal, junior);
    expect(res.status).toBe(403);
    expect(directory.invites.has(created.principal)).toBe(true);
    expect(holds(created.principal)).toEqual(['admin']);
    expect((await revoke(created.principal)).status).toBe(204);
    expect(holds(created.principal)).toEqual([]);
  });

  it('...and lets it through when the principal now holds less than the row says', async () => {
    const created = (await (await create('admin')).json()) as { principal: string };
    scopeRoles.set(created.principal, new Set(['editor']));
    expect((await revoke(created.principal, junior)).status).toBe(204);
    expect(directory.invites.has(created.principal)).toBe(false);
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
   * An invite at a role the tenant no longer defines (#1931 review). Such a role confers
   * nothing, so the bounded revoke takes it without a bound and the withdrawal goes through.
   * Any error from the revoke still refuses. Create is unchanged: it never gets that far with
   * an unknown role.
   */
  describe('a revoke at a role the tenant no longer defines', () => {
    const seeded = async (roleKey: string) => {
      const principal = ulid();
      await directory.createInvite('scope-1', principal, roleKey, null, 'hash');
      scopeRoles.set(principal, new Set([roleKey]));
      log.length = 0;
      return principal;
    };
    const revokeThrows = (err: unknown) => {
      app = mount({
        revokeScopeRolesBounded: async () => {
          log.push('revokeScopeRolesBounded');
          throw err;
        },
      });
    };

    it('goes through for an admin, and the invite is gone', async () => {
      const principal = await seeded('retired');
      expect((await revoke(principal, junior)).status).toBe(204);
      expect(directory.invites.has(principal)).toBe(false);
      expect(holds(principal)).toEqual([]);
    });

    it('...but a non-admin is still refused by the gate, and the bound is never asked', async () => {
      const principal = await seeded('retired');
      const res = await revoke(principal, { authorization: 'Bearer tok-owner' });
      expect([res.status, await res.text()]).toEqual([403, 'only an admin can manage invites']);
      expect(log).toEqual([]);
      expect(directory.invites.has(principal)).toBe(true);
    });

    it.each([
      ['a not_found about a role', unknownRoleError('some-other-role')],
      ['a not_found about the scope', substratError('not_found', 'unknown scope for tenant: (t, s)')],
      ['an untyped error', new Error('the scope is unreachable')],
    ])('a revoke that throws %s refuses, and the invite stays', async (_case, err) => {
      const principal = await seeded('retired');
      revokeThrows(err);
      expect((await revoke(principal, junior)).status).toBe(500);
      expect(directory.invites.has(principal)).toBe(true);
    });

    it('create refuses an unknown role from the bounded grant', async () => {
      app = mount({ assignScopeRoleBounded: async (_env, _node, _caller, _assignee, roleKey) => {
        throw unknownRoleError(roleKey);
      } });
      expect((await create('editor')).status).toBe(500);
      expect(writes()).toEqual([]);
      expect(directory.invites.size).toBe(0);
    });
  });

  /**
   * Fail closed: a mount wired short refuses the two routes that confer or remove a role,
   * rather than running them unbounded. Each case pairs with the working mount above.
   */
  describe('a mount wired short refuses, never runs unbounded', () => {
    const remount = (overrides: Partial<InviteRouteDeps<Env, typeof NODE>>) => {
      app = mount(overrides);
    };

    it('no bounded-revoke dep (a JS caller, or a cast) — create and revoke refuse, nothing written', async () => {
      const seeded = (await (await create('editor')).json()) as { principal: string };
      log.length = 0;
      remount({ revokeScopeRolesBounded: undefined as never });
      const res = await create('editor');
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/without the bounded revoke/);
      const rev = await revoke(seeded.principal);
      expect(rev.status).toBe(500);
      expect(writes()).toEqual([]);
      expect(directory.invites.size).toBe(1); // the seeded one, untouched
    });

    it('no bounded grant dep refuses create before anything is written', async () => {
      remount({ assignScopeRoleBounded: undefined as never });
      const res = await create('editor');
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/without the bounded grant/);
      expect(log).toEqual([]);
      expect(directory.invites.size).toBe(0);
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
        remount({ assignScopeRoleBounded: (async () => answer) as never });
        const res = await create('editor');
        expect(res.status).toBe(500);
        expect(await res.text()).toMatch(/did not answer with a coverage/);
      }
      expect(writes()).toEqual([]);
      expect(directory.invites.size).toBe(0);
    });

    it('a bound that throws — the throw is the answer, and nothing was written', async () => {
      remount({
        assignScopeRoleBounded: async () => {
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

/**
 * The invite's link as a `become` capability (#1686). Each refusal is paired with the case that
 * goes through, and every refusal before the exchange leaves the capability's one use unspent.
 */
describe('withLinkStates', () => {
  const row = (n: number, link: boolean) => ({
    principal: `p${n}`, roleKey: 'editor', email: null, createdAt: n, capabilityId: link ? capabilityId.parse(ulid()) : null,
  });

  it(`asks in pages of the read's cap (${BECOME_LINK_STATES_MAX_IDS}), and lists every invite`, async () => {
    const rows = [...Array.from({ length: BECOME_LINK_STATES_MAX_IDS + 1 }, (_, n) => row(n, true)), row(999, false)];
    const asked: number[] = [];
    const listed = await withLinkStates(rows, async (ids) => {
      asked.push(ids.length);
      return ids.map(() => ({ state: 'open' as const, reason: null }));
    });
    expect(asked).toEqual([BECOME_LINK_STATES_MAX_IDS, 1]);
    expect(listed).toHaveLength(rows.length);
    expect(listed.at(-1)!.link).toBeNull(); // the legacy one
    expect(listed.every((l, n) => (n < rows.length - 1 ? l.link?.state === 'open' : l.link === null))).toBe(true);
  });

  it('refuses a short page rather than list an invite with no state', async () => {
    const rows = Array.from({ length: 3 }, (_, n) => row(n, true));
    await expect(withLinkStates(rows, async (ids) => ids.slice(1).map(() => ({ state: 'open' as const, reason: null })))).rejects.toThrow(/link state per id/);
  });
});

describe('mountInviteRoutes — the link is a become capability', () => {
  const newcomer = { authorization: 'Bearer tok-newcomer' };
  const invite = async (roleKey = 'editor', headers: Record<string, string> = admin) => {
    const created = (await (await app.request('http://app.example/api/invites', json({ roleKey }, headers), env())).json()) as {
      principal: string;
      acceptUrl: string;
    };
    return { principal: created.principal, token: new URL(created.acceptUrl).searchParams.get('invite')! };
  };
  const accept = (token: string, headers: Record<string, string> = newcomer) =>
    app.request('http://app.example/api/accept-invite', json({ token }, headers), env());
  const capOf = (principal: string) => [...capabilities.values()].find((c) => c.principal === principal)!;

  it('accepting spends the one use in the scope, then binds; a replay is refused like any wrong token', async () => {
    const { principal, token } = await invite();
    log.length = 0;
    const ok = await accept(token);
    expect(ok.status).toBe(200);
    expect(log).toEqual(['inviteMatches', 'exchangeCapability']);
    expect(capOf(principal).uses).toBe(1);
    expect(directory.bound.get('sub-newcomer')).toBe(principal);

    const replay = await accept(token, { authorization: 'Bearer tok-owner' });
    expect([replay.status, await replay.text()]).toEqual([400, 'this invite is invalid or already used']);
    expect(capOf(principal).uses).toBe(1);
  });

  it('a signed-out visitor spends nothing — the directory and the scope are not asked', async () => {
    const { principal, token } = await invite();
    log.length = 0;
    expect((await accept(token, {})).status).toBe(401);
    expect(log).toEqual([]);
    expect(capOf(principal).uses).toBe(0);
    expect((await accept(token)).status).toBe(200); // ...and the link still works once signed in
  });

  it('a withdrawn invite\'s secret is refused before the exchange, so its use is never spent', async () => {
    const { principal, token } = await invite();
    expect((await app.request(`http://app.example/api/invites/${principal}/revoke`, { method: 'POST', headers: admin }, env())).status).toBe(204);
    log.length = 0;
    expect((await accept(token)).status).toBe(400);
    expect(log).toEqual(['inviteMatches']);
    expect(capOf(principal).uses).toBe(0);
    expect(directory.bound.size).toBe(0);
  });

  it('a become secret that is no invite here (a claim link, another scope\'s) is refused without spending it', async () => {
    const stray = capabilityId.parse(ulid());
    const secret = mintCapabilitySecret();
    capabilities.set(stray, { id: stray, tokenHash: await sha256Hex(secret), principal: OWNER, minter: OWNER, uses: 0, revokedBy: null });
    log.length = 0;
    expect((await accept(secret)).status).toBe(400);
    expect(log).toEqual(['inviteMatches']);
    expect(capabilities.get(stray)!.uses).toBe(0);
    expect(directory.bound.size).toBe(0);
  });

  it('a link the scope has revoked is refused at the exchange, even while its row still stands', async () => {
    const { principal, token } = await invite();
    capOf(principal).revokedBy = OWNER; // revoked in the scope (an operator's lever), row untouched
    expect((await accept(token)).status).toBe(400);
    expect(directory.bound.size).toBe(0);
    expect(directory.invites.has(principal)).toBe(true);
  });

  it('binds only the principal the capability names: an exchange answering another is refused', async () => {
    const { principal, token } = await invite();
    app = mount({
      exchangeCapability: async () => ({ kind: 'principal', capabilityId: capabilityId.parse(capOf(principal).id), principal: OWNER }),
    });
    expect((await accept(token)).status).toBe(400);
    expect(directory.bound.size).toBe(0);
  });

  it('refuses a mint the bound refuses — 403 naming what is lacked, and the grant taken back', async () => {
    // The grant's bound passed, but the target holds more than the caller by the time the link is minted.
    app = mount({
      mintBecomeCapabilityBounded: async (_env, node, caller, input) => {
        log.push(`mintBecomeCapabilityBounded ${node.scopeId} ${caller} ${input.principal}`);
        return { ok: false, coverage: { covered: false, missing: ['billing:manage' as PermissionKey] } };
      },
    });
    const res = await app.request('http://app.example/api/invites', json({ roleKey: 'editor' }, junior), env());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/you do not hold billing:manage/);
    expect(log.map((l) => l.split(' ')[0])).toEqual(['assignScopeRoleBounded', 'mintBecomeCapabilityBounded', 'revokeScopeRole']);
    expect(directory.invites.size).toBe(0);
    expect([...scopeRoles.values()].every((r) => r.size === 0)).toBe(true);
  });

  it('a withdrawal whose link revoke fails keeps the row, so the retry finds the link and finishes', async () => {
    const { principal, token } = await invite();
    const link = capOf(principal).id;
    app = mount({
      revokeBecomeCapability: async () => {
        throw new Error('scope unreachable');
      },
    });
    const failed = await app.request(`http://app.example/api/invites/${principal}/revoke`, { method: 'POST', headers: admin }, env());
    expect(failed.status).toBe(500);
    // The row is still there to name the link, and the two still agree: link live, invite open.
    expect(directory.invites.get(principal)?.capabilityId).toBe(link);
    expect(capOf(principal).revokedBy).toBeNull();
    app = mount();
    expect((await app.request(`http://app.example/api/invites/${principal}/revoke`, { method: 'POST', headers: admin }, env())).status).toBe(204);
    expect(directory.invites.has(principal)).toBe(false);
    expect(capOf(principal).revokedBy).toBe(OWNER);
    expect((await accept(token)).status).toBe(400);
  });

  it('a role conferring nothing leaves nothing to become — 409, the grant taken back, nothing recorded', async () => {
    app = mount({
      mintBecomeCapabilityBounded: async (_env, node, caller, input) => {
        log.push(`mintBecomeCapabilityBounded ${node.scopeId} ${caller} ${input.principal}`);
        return { ok: false, refused: 'target-holds-nothing' };
      },
    });
    const res = await app.request('http://app.example/api/invites', json({ roleKey: 'editor' }), env());
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/'editor' confers nothing here/);
    expect(log.map((l) => l.split(' ')[0])).toEqual(['assignScopeRoleBounded', 'mintBecomeCapabilityBounded', 'revokeScopeRole']);
    expect(directory.invites.size).toBe(0);
  });

  it('a mint that throws takes the grant back and rethrows; nothing is recorded', async () => {
    app = mount({
      mintBecomeCapabilityBounded: async () => {
        throw new Error('scope unreachable');
      },
    });
    const res = await app.request('http://app.example/api/invites', json({ roleKey: 'editor' }), env());
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/scope unreachable/);
    expect(log.map((l) => l.split(' ')[0])).toEqual(['assignScopeRoleBounded', 'revokeScopeRole']);
    expect(directory.invites.size).toBe(0);
  });

  it('a mount without the capability verbs refuses create, nothing written', async () => {
    app = mount({ mintBecomeCapabilityBounded: undefined as never });
    const res = await app.request('http://app.example/api/invites', json({ roleKey: 'editor' }), env());
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/without the capability verbs/);
    expect(log).toEqual([]);
  });

  /**
   * LEGACY: an invite minted before #1686 — a hash-only row whose token is 64 hex — still
   * accepts by its hash, and never reaches the scope's exchange. Its twin — a capability-era row
   * is never accepted by hash — is a rule of the directory's SQL, held in member-directory.test.ts.
   */
  it('an invite minted before #1686 still accepts by its hash, without an exchange', async () => {
    const principal = ulid();
    const token = 'ab'.repeat(32);
    await directory.createInvite('scope-1', principal, 'editor', null, await sha256Hex(token));
    log.length = 0;
    const ok = await accept(token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, principal });
    expect(log).toEqual([]);
  });
});
