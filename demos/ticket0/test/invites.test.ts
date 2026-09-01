/**
 * How a second person reaches this desk (#1149) — driven over HTTP, because that is
 * the only place it exists.
 *
 * An invite is not an operation and could not be one: it mints a principal and grants
 * it a role, and both live on the kernel's admin surface, which module code
 * deliberately cannot reach. So the scenario suite next door — which drives operations
 * through scope stubs — cannot see any of this, and until this file existed nothing in
 * the repo could tell a desk a colleague can join from one where the owner is alone
 * forever. That was not hypothetical: the routes were written, complete, in the worker,
 * and the whole flow reached no caller in either host.
 *
 * `harness/invites.ts` is mounted here exactly as `src/server.ts` mounts it — same
 * file, same store, same identity directory — so what passes is the dev server's own
 * behaviour and not a re-description of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Page } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { T0_PERM } from '../src/manifest.js';
import { CONTACT_BOUND_ROLE, HUMAN_ROLES, STAFF_ROLES } from '../src/provision.js';
import { buildHost, linkDevPersonas, seed, type World } from '../src/seed.js';
import { mountApi } from '../src/routes.js';
import { mountInvites } from '../harness/invites.js';
import { devInviteDesk } from '../harness/dev-invites.js';

let dir: string;
let host: ScopeHost;
let world: World;
let app: Hono;

interface AgentProfile {
  principal: string;
  display_name: string;
  signature: string | null;
}
interface Conversation {
  id: string;
  assignee: string | null;
}

/**
 * Who the request is from — the seam the real server fills with `login.caller()` and
 * `login.subject()`. A test that went through the issuer would be testing OIDC; what
 * is under test is what the surface does with a verified subject, so the subject is
 * set directly and the login is not simulated at all.
 */
let signedIn: { sub: string; name?: string } | null = null;

import { DEV_PROVIDER } from '../src/personas.js';

/** `Priya` is a seeded CUSTOMER — the one contact a portal invite can be bound to. */
const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-invites-'));
  host = buildHost(dir);
  world = await seed(host);
  // Registers the identity pool the dev issuer's subjects live in — the same call
  // `src/server.ts` makes on boot, and without which nothing may be LINKED into it.
  await linkDevPersonas(host, world);

  app = new Hono();
  /**
   * The declared API too, and not for the routes: `mountApi` installs the app-wide
   * error map, which is what turns the kernel's `PermissionDenied` into a 403 instead
   * of a 500. Both hosts mount both surfaces on one app for exactly that reason, so a
   * test app that mounted only the invites would be a different app.
   */
  mountApi(app, async () => {
    const caller = callerDesk();
    if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
    return host.getScope(caller.principal, world.substrat.tenant, world.substrat.scope);
  });
  mountInvites(app, {
    humanRoles: HUMAN_ROLES,
    staffRoles: STAFF_ROLES,
    contactBoundRole: CONTACT_BOUND_ROLE,
    appOrigin: () => 'http://localhost:5281',
    subjectOf: async () => signedIn,
    /**
     * The admin gate, as `src/server.ts` writes it: `get-desk` IS the check, because
     * it asserts `desk:configure` inside the operation. A role list out here would be
     * a second opinion about the same question.
     */
    requireAdmin: async () => {
      const desk = callerDesk();
      if (!desk) throw new HTTPException(401, { message: 'unauthorized' });
      const scope = await host.getScope(desk.principal, world.substrat.tenant, world.substrat.scope);
      await scope.invoke('ticket0/get-desk', {});
    },
    deskOf: async (_c: Context) => {
      const caller = callerDesk();
      return devInviteDesk({
        file: join(dir, 'invites.json'),
        host,
        actor: world.staff,
        provider: DEV_PROVIDER,
        portalPermission: T0_PERM.conversationReadOwn,
        caller: caller
          ? { tenantId: world.substrat.tenant, scopeId: world.substrat.scope }
          : null,
      });
    },
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The seeded personas, by the sub the dev issuer would present. */
function callerDesk(): { principal: import('@substrat-run/contracts').PrincipalId } | null {
  if (signedIn?.sub === 'dev|markus') return { principal: world.substrat.admin.principal };
  if (signedIn?.sub === 'dev|anna') return { principal: world.substrat.agent.principal };
  return null;
}

const asAdmin = () => (signedIn = { sub: 'dev|markus', name: 'Markus' });
const asAgent = () => (signedIn = { sub: 'dev|anna', name: 'Anna' });
const asNobody = () => (signedIn = null);

describe('inviting somebody onto the desk', () => {
  it('only an admin may see or create invites', async () => {
    asNobody();
    expect((await app.request('/api/invites')).status).toBe(401);

    // An agent works the whole inbox and still may not add people to the desk — the
    // one denial that keeps `desk:configure` meaning anything.
    asAgent();
    expect((await app.request('/api/invites')).status).toBe(403);

    asAdmin();
    const res = await app.request('/api/invites');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[]; invites: unknown[] };
    // The three HUMAN roles, and not the five that exist. Offering `widget` here would
    // be offering to hand somebody the desk's own chat service.
    expect(body.roles).toEqual(['desk-admin', 'agent', 'customer']);
    expect(body.invites).toEqual([]);
  });

  it('refuses a role no person may hold', async () => {
    asAdmin();
    const res = await post('/api/invites', { roleKey: 'widget' });
    expect(res.status).toBe(400);
  });

  it('an invited agent joins, lands in the directory, and can be assigned work', async () => {
    asAdmin();
    const created = await post('/api/invites', { email: 'nils@example.com', roleKey: 'agent' });
    expect(created.status).toBe(201);
    const invite = (await created.json()) as { principal: string; acceptUrl: string };
    const token = new URL(invite.acceptUrl).searchParams.get('invite')!;
    expect(token).toBeTruthy();
    // The link carries the token and the store carries only its hash — a leaked store
    // must not be a leaked set of invitations.
    expect(JSON.stringify(invite)).not.toContain('token_hash');

    // Pending, and NOT in the directory: they hold the role already, but a picker that
    // offered them would be offering a name `assign` refuses.
    const pending = (await (await app.request('/api/invites')).json()) as {
      invites: { principal: string; roleKey: string; email: string | null }[];
    };
    expect(pending.invites).toHaveLength(1);
    expect(pending.invites[0]).toMatchObject({ roleKey: 'agent', email: 'nils@example.com' });
    const admin = await host.getScope(
      world.substrat.admin.principal,
      world.substrat.tenant,
      world.substrat.scope,
    );
    const before = (await admin.invoke('ticket0/list-agents', {})) as Page<AgentProfile>;
    expect(before.entries.map((a) => a.principal)).not.toContain(invite.principal);

    // Nils signs in at the issuer as himself and claims the link.
    signedIn = { sub: 'dev|nils', name: 'Nils Berg' };
    const accepted = await post('/api/accept-invite', { token });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, principal: invite.principal });

    // The whole point: he is in the directory, under the name the ISSUER knew, without
    // having found a settings screen first.
    const after = (await admin.invoke('ticket0/list-agents', {})) as Page<AgentProfile>;
    const nils = after.entries.find((a) => a.principal === invite.principal);
    expect(nils?.display_name).toBe('Nils Berg');

    // And `assign` — which validates against exactly that directory — takes him.
    const inbox = (await admin.invoke('ticket0/list-conversations', {})) as {
      entries: Conversation[];
    };
    const target = inbox.entries[0]!;
    const assigned = (await admin.invoke('ticket0/assign', {
      conversationId: target.id,
      assignee: invite.principal,
    })) as Conversation;
    expect(assigned.assignee).toBe(invite.principal);

    // The invite is spent: the same token a second time is refused, and the pending
    // list no longer offers to revoke somebody who has already arrived.
    signedIn = { sub: 'dev|someone-else' };
    expect((await post('/api/accept-invite', { token })).status).toBe(400);
    asAdmin();
    const left = (await (await app.request('/api/invites')).json()) as { invites: unknown[] };
    expect(left.invites).toEqual([]);
  });

  it('a customer invite names a contact, and does not join the staff directory', async () => {
    asAdmin();
    // The portal is a grant on ONE contact, so the role that opens it takes an
    // argument — and refuses without one rather than opening nothing.
    expect((await post('/api/invites', { roleKey: 'customer' })).status).toBe(400);

    const contacts = (await (
      await host.getScope(
        world.substrat.admin.principal,
        world.substrat.tenant,
        world.substrat.scope,
      )
    ).invoke('ticket0/list-contacts', {})) as Page<{ id: string }>;
    const contactId = contacts.entries[0]!.id;

    const created = await post('/api/invites', { roleKey: 'customer', contactId });
    expect(created.status).toBe(201);
    const invite = (await created.json()) as { principal: string; acceptUrl: string };
    const token = new URL(invite.acceptUrl).searchParams.get('invite')!;

    signedIn = { sub: 'dev|外部', name: 'A Customer' };
    expect((await post('/api/accept-invite', { token })).status).toBe(200);

    // Staff, and a customer, are two sets. A customer in the assignee picker would be
    // a bug rather than a convenience.
    const admin = await host.getScope(
      world.substrat.admin.principal,
      world.substrat.tenant,
      world.substrat.scope,
    );
    const staff = (await admin.invoke('ticket0/list-agents', {})) as Page<AgentProfile>;
    expect(staff.entries.map((a) => a.principal)).not.toContain(invite.principal);
  });

  it('a revoked invite cannot be claimed', async () => {
    asAdmin();
    const created = await post('/api/invites', { roleKey: 'agent' });
    const invite = (await created.json()) as { principal: string; acceptUrl: string };
    const token = new URL(invite.acceptUrl).searchParams.get('invite')!;

    expect((await post(`/api/invites/${invite.principal}/revoke`)).status).toBe(204);

    signedIn = { sub: 'dev|too-late' };
    expect((await post('/api/accept-invite', { token })).status).toBe(400);
  });

  it('accepting requires a login — the token alone is not an identity', async () => {
    asAdmin();
    const created = await post('/api/invites', { roleKey: 'agent' });
    const { acceptUrl } = (await created.json()) as { acceptUrl: string };
    const token = new URL(acceptUrl).searchParams.get('invite')!;

    asNobody();
    expect((await post('/api/accept-invite', { token })).status).toBe(401);
  });
});
