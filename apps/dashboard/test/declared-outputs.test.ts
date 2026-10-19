import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LIST_PAGE_MAX, orgId, pageSchema, principalId, scopeId, tenantId, platformActorId, type Page } from '@substrat-run/contracts';
import { WALK_PAGE_LIMIT } from '@substrat-run/control-plane-client';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { MODULES, provisionDashboard, type DashboardNode } from '../src/index.js';
import { registerDashboardMembership } from '../src/membership.js';
import { dashboardOperations } from '../src/module.js';
import { walkAll } from '../src/walk-all.js';

/**
 * The dashboard's declared outputs are real schemas (#2426), and its six list reads page.
 *
 * Before, every output was an opaque `z.custom` typed from the handler, which an
 * `instanceof z.ZodArray` check cannot see into, so the six reads that answered a bare
 * array got past `defineOperations`' #811 gate and answered the whole table. Here every
 * operation is driven once and its answer parsed with its declaration (a paged read's as a
 * page of its entry), and each list read is walked two rows at a time.
 */

type Scope = Awaited<ReturnType<SqliteScopeHost['getScope']>>;
type OpName = keyof typeof dashboardOperations;
const LIST_READS = [
  'dashboard/list-apps',
  'dashboard/app-events',
  'dashboard/install-steps',
  'dashboard/list-app-env',
  'dashboard/list-members',
  'dashboard/list-connect-links',
] as const satisfies readonly OpName[];

/** What a declaration says the operation answers: its output, or a page of it when it pages. */
function answerSchema(name: OpName): z.ZodType {
  const decl = dashboardOperations[name] as { output: z.ZodType; paged?: unknown };
  return decl.paged === undefined ? decl.output : pageSchema(decl.output);
}

describe('the dashboard’s declared outputs (#2426)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let node: DashboardNode;
  let own: Scope;
  const staff = platformActorId.parse(ulid());

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-declared-outputs-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m);
    registerDashboardMembership(host);
    node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'acme',
      name: 'Acme',
    });
    own = await host.getScope(node.principal, node.tenantId, node.scopeId);
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('declares no opaque output: a `z.custom` hides a bare array from the #811 gate', () => {
    const opaque = Object.entries(dashboardOperations)
      .filter(([, decl]) => (decl.output as z.ZodType) instanceof z.ZodCustom)
      .map(([name]) => name);
    expect(opaque).toEqual([]);
    for (const name of LIST_READS) expect(dashboardOperations[name], name).toHaveProperty('paged');
  });

  it('every operation answers what it declares', async () => {
    const answered = new Set<string>();
    const call = async <T>(scope: Scope, name: OpName, input?: unknown): Promise<T> => {
      const result = await scope.invoke<T>(name, input);
      const parsed = answerSchema(name).safeParse(result);
      expect(parsed.error?.issues, name).toBeUndefined();
      answered.add(name);
      return result;
    };
    const app = scopeId.parse(ulid());
    const stuck = scopeId.parse(ulid());

    // -- apps
    await call(own, 'dashboard/provision-app', { appScopeId: app, verticalSlug: 'protocol', name: 'One' });
    await call(own, 'dashboard/record-install-step', { appScopeId: app, step: 'directory', seq: 0, status: 'running' });
    await call(own, 'dashboard/install-steps', { appScopeId: app });
    await call(own, 'dashboard/mark-app-active', { appScopeId: app, hostname: 'one.example.test', provisionResult: { clientId: 'c1' } });
    await call(own, 'dashboard/update-app', { appScopeId: app, detail: '0.1 → 0.2' });
    await call(own, 'dashboard/reconcile-app-vertical', { appScopeId: app, verticalSlug: 'acme/protocol' });
    for (const name of [
      'dashboard/snapshot-app',
      'dashboard/delete-app-snapshot',
      'dashboard/export-app-data',
      'dashboard/restore-app-data',
      'dashboard/bind-app-hostname',
      'dashboard/unbind-app-hostname',
    ] as const) {
      await call(own, name, { appScopeId: app, detail: 'detail' });
    }
    for (const name of ['dashboard/authorize-scope-change', 'dashboard/authorize-findings-read', 'dashboard/authorize-findings-change'] as const) {
      await call(own, name);
    }
    await call(own, 'dashboard/provision-app', { appScopeId: stuck, verticalSlug: 'protocol', name: 'Two' });
    await call(own, 'dashboard/resume-app', { appScopeId: stuck });
    await call(own, 'dashboard/mark-app-failed', { appScopeId: stuck, reason: 'boom' });
    await call(own, 'dashboard/app-events', { appScopeId: app });
    await call(own, 'dashboard/list-apps');
    await call(own, 'dashboard/delete-app', { appScopeId: stuck });

    // -- env + identity
    await call(own, 'dashboard/set-app-env', {
      appScopeId: app,
      entries: [{ key: 'PUBLIC_ORIGIN', value: 'https://one.example.test' }, { key: 'API_KEY', value: 'k', secret: true }],
    });
    await call(own, 'dashboard/list-app-env', { appScopeId: app });
    await call(own, 'dashboard/delete-app-env', { appScopeId: app, key: 'PUBLIC_ORIGIN' });
    await call(own, 'dashboard/set-app-auth', {
      appScopeId: app,
      config: { mode: 'oidc', issuer: 'https://issuer.example.test', clientId: 'client', clientSecret: 'secret' },
    });
    await call(own, 'dashboard/get-app-auth', { appScopeId: app });

    // -- team + members
    const org = orgId.parse(ulid());
    await host.admin.createOrg(staff, { id: org, tenantId: node.tenantId, slug: 'team', name: 'Acme' });
    await call(own, 'dashboard/init-team', { orgId: org, ownerEmail: 'owner@acme.test' });
    const { invitationId } = await call<{ invitationId: string }>(own, 'dashboard/invite-member', { email: 'jane@acme.test', roleKey: 'member' });
    const jane = principalId.parse(ulid());
    const janeScope = await host.getScope(jane, node.tenantId, node.scopeId);
    await call(janeScope, 'dashboard/preview-invite', { invitationId });
    await call(own, 'dashboard/invite-link', { invitationId });
    await call(own, 'dashboard/resend-invite', { invitationId });
    await call(janeScope, 'dashboard/accept-invite', { invitationId, identifier: 'jane@acme.test' });
    const roster = await call<Page<{ id: string; email: string }>>(own, 'dashboard/list-members');
    const kim = await call<{ invitationId: string }>(own, 'dashboard/invite-member', { email: 'kim@acme.test', roleKey: 'viewer' });
    await call(own, 'dashboard/revoke-invite', { invitationId: kim.invitationId });
    await call(own, 'dashboard/remove-member', { memberId: roster.entries.find((m) => m.email === 'jane@acme.test')!.id });

    // -- connections
    await call(own, 'dashboard/begin-connection', { provider: 'fortnox' });
    const link = await call<{ id: string }>(own, 'dashboard/mint-connect-link', { provider: 'fortnox', appScopeId: app });
    await call(own, 'dashboard/list-connect-links', { provider: 'fortnox' });
    await call(own, 'dashboard/consume-connect-link', { linkId: link.id, provider: 'fortnox', accountRef: '1', accountLabel: 'One AB' });
    await call(own, 'dashboard/restore-connect-link', { linkId: link.id });
    await call(own, 'dashboard/revoke-connect-link', { linkId: link.id });

    // -- last, since they empty the roster
    await call(own, 'dashboard/delete-team');
    await call(own, 'dashboard/leave-self');

    expect([...answered].sort()).toEqual(Object.keys(dashboardOperations).sort());
  });

  it('refuses a cursor that no page handed out', async () => {
    await expect(own.invoke('dashboard/install-steps', { appScopeId: ulid(), cursor: 'no-separator' })).rejects.toThrow(/invalid cursor/);
    await expect(own.invoke('dashboard/list-apps', { cursor: `a\u0000b` })).rejects.toThrow(/invalid cursor/);
  });

  /**
   * Walk `name` two rows at a time and return the pages. The concatenation must equal one
   * page large enough to hold everything — no row skipped or repeated at a boundary — and
   * only the last page may say the walk is over.
   */
  async function byTwo<T>(name: OpName, input: Record<string, unknown> = {}): Promise<T[]> {
    const pages: Page<T>[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<T> = await own.invoke<Page<T>>(name, { ...input, limit: 2, ...(cursor === null ? {} : { cursor }) });
      expect(answerSchema(name).safeParse(page).error?.issues, name).toBeUndefined();
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== null && pages.length < 10);
    const rows = pages.flatMap((p) => p.entries);
    const whole = await own.invoke<Page<T>>(name, { ...input, limit: LIST_PAGE_MAX });
    expect(rows, name).toEqual(whole.entries);
    expect(whole.nextCursor).toBeNull();
    expect(pages.map((p) => p.entries.length), name).toEqual([2, 2, 1]);
    return rows;
  }

  const desc = (ids: string[]) => [...ids].sort().reverse();

  it('list-apps pages newest first, and honours an ascending walk', async () => {
    for (let i = 0; i < 5; i++) {
      await own.invoke('dashboard/provision-app', { appScopeId: ulid(), verticalSlug: 'protocol', name: `App ${i}` });
    }
    const rows = await byTwo<{ id: string }>('dashboard/list-apps');
    expect(rows.map((r) => r.id)).toEqual(desc(rows.map((r) => r.id)));
    const asc = await own.invoke<Page<{ id: string }>>('dashboard/list-apps', { order: 'asc' });
    expect(asc.entries.map((r) => r.id)).toEqual(rows.map((r) => r.id).reverse());
    // A call that names no page gets the default one, never the whole table.
    expect((await own.invoke<Page<unknown>>('dashboard/list-apps')).entries).toHaveLength(5);
  });

  it('app-events pages newest first', async () => {
    const app = ulid();
    await own.invoke('dashboard/provision-app', { appScopeId: app, verticalSlug: 'protocol', name: 'One' });
    for (const detail of ['a', 'b', 'c', 'd']) await own.invoke('dashboard/update-app', { appScopeId: app, detail });
    const rows = await byTwo<{ id: string }>('dashboard/app-events', { appScopeId: app });
    expect(rows.map((r) => r.id)).toEqual(desc(rows.map((r) => r.id)));
  });

  it('install-steps pages in (seq, step) order: numerically, and through a tie at a page boundary', async () => {
    const app = ulid();
    // 9 before 10 only when seq compares as a number; c and d share a seq and fall either side of the first page.
    for (const [step, seq] of [['a', 10], ['b', 9], ['c', 2], ['d', 2], ['e', 0]] as const) {
      await own.invoke('dashboard/record-install-step', { appScopeId: app, step, seq, status: 'done' });
    }
    const rows = await byTwo<{ step: string }>('dashboard/install-steps', { appScopeId: app });
    expect(rows.map((r) => r.step)).toEqual(['e', 'c', 'd', 'b', 'a']);
  });

  it('list-app-env pages in key order', async () => {
    const app = ulid();
    await own.invoke('dashboard/set-app-env', {
      appScopeId: app,
      entries: ['E_KEY', 'B_KEY', 'D_KEY', 'A_KEY', 'C_KEY'].map((key) => ({ key, value: key.toLowerCase() })),
    });
    const rows = await byTwo<{ key: string }>('dashboard/list-app-env', { appScopeId: app });
    expect(rows.map((r) => r.key)).toEqual(['A_KEY', 'B_KEY', 'C_KEY', 'D_KEY', 'E_KEY']);
  });

  it('list-members pages newest first', async () => {
    const org = orgId.parse(ulid());
    await host.admin.createOrg(staff, { id: org, tenantId: node.tenantId, slug: 'team', name: 'Acme' });
    await own.invoke('dashboard/init-team', { orgId: org, ownerEmail: 'owner@acme.test' });
    for (const who of ['a', 'b', 'c', 'd']) await own.invoke('dashboard/invite-member', { email: `${who}@acme.test`, roleKey: 'viewer' });
    const rows = await byTwo<{ id: string }>('dashboard/list-members');
    expect(rows.map((r) => r.id)).toEqual(desc(rows.map((r) => r.id)));
  });

  it('list-connect-links pages newest first', async () => {
    for (let i = 0; i < 5; i++) await own.invoke('dashboard/mint-connect-link', { provider: 'fortnox', appScopeId: 'app-1' });
    const rows = await byTwo<{ id: string }>('dashboard/list-connect-links', { provider: 'fortnox' });
    expect(rows.map((r) => r.id)).toEqual(desc(rows.map((r) => r.id)));
  });
});

describe('walkAll', () => {
  it('sends the read its filters and the page, and no cursor at all on the first request', async () => {
    // `walkPages` (control-plane-client) owns the loop; what is the dashboard's is the request.
    const rows = Array.from({ length: WALK_PAGE_LIMIT + 1 }, (_, i) => String(i).padStart(3, '0'));
    const seen: Array<Record<string, unknown>> = [];
    const scope = {
      invoke: async <O>(_op: string, input?: unknown): Promise<O> => {
        const page = input as { limit: number; cursor?: string };
        seen.push(input as Record<string, unknown>);
        const from = page.cursor === undefined ? 0 : rows.indexOf(page.cursor) + 1;
        const entries = rows.slice(from, from + page.limit);
        return { entries, nextCursor: entries.length === page.limit ? entries.at(-1)! : null } as O;
      },
    };
    expect(await walkAll(scope, 'dashboard/app-events', { appScopeId: 'x' })).toEqual(rows);
    // A `null` cursor would be refused by the read's parse, so the first request names none.
    expect(seen).toEqual([
      { appScopeId: 'x', limit: WALK_PAGE_LIMIT },
      { appScopeId: 'x', limit: WALK_PAGE_LIMIT, cursor: rows[WALK_PAGE_LIMIT - 1] },
    ]);
  });
});
