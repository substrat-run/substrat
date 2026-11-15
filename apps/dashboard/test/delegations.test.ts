import { describe, expect, it } from 'vitest';
import { scopeId, type ManifestDelegation } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  delegationGrantsFor,
  delegationsConverged,
  logDelegations,
  reconcileDelegations,
  runningDelegationsReader,
} from '../src/delegations.js';
import type { DashboardAppRow } from '../src/module.js';

/**
 * The dashboard's half of delegation (#3161): what a host app's running version declares,
 * turned into the grants its team auth-server holds. The issuer's half, which turns a delivery
 * into rows and refuses an exchange without one, is `demos/auth-server/src/delegations.ts`.
 */

const row = (over: Partial<DashboardAppRow>): DashboardAppRow =>
  ({
    id: ulid(),
    app_scope_id: scopeId.parse(ulid()),
    vertical_slug: 'notes',
    name: 'App',
    status: 'active',
    hostname: null,
    created_at: '2026-11-01T00:00:00.000Z',
    ...over,
  }) as DashboardAppRow;

const ISSUER_A = scopeId.parse(ulid());
const ISSUER_B = scopeId.parse(ulid());

describe('the grants a host declares', () => {
  it('resolves each slug to the one app of the team on the same issuer, and skips the rest', () => {
    const todo = row({ vertical_slug: 'acme/todo' });
    const crmA = row({ vertical_slug: 'crm' });
    const crmB = row({ vertical_slug: 'acme/crm' });
    const desk = row({ vertical_slug: 'desk' });
    const elsewhere = row({ vertical_slug: 'other/wiki' });
    const declared: ManifestDelegation[] = [
      { actor: 'todo', permissions: ['note:read', 'note:write'] as ManifestDelegation['permissions'], channels: ['peer'] },
      { actor: 'crm', permissions: ['note:read'] as ManifestDelegation['permissions'] },
      { actor: 'desk', permissions: ['note:read'] as ManifestDelegation['permissions'] },
      { actor: 'billing', permissions: ['note:read'] as ManifestDelegation['permissions'] },
      // Another tenant's pinned spelling is never this tenant's app.
      { actor: 'wiki', permissions: ['note:read'] as ManifestDelegation['permissions'] },
      // A second spelling of an app already granted: the issuer would refuse a set naming it twice.
      { actor: 'acme/todo', permissions: ['note:read'] as ManifestDelegation['permissions'] },
    ];
    const extraCrm = row({ vertical_slug: 'crm' });
    const { grants, skipped } = delegationGrantsFor({
      declared,
      hostIssuerScopeId: ISSUER_A,
      apps: [todo, crmA, crmB, extraCrm, desk, elsewhere, row({ vertical_slug: 'billing', status: 'provisioning' })],
      tenantSlug: 'acme',
      issuerOfApp: new Map([
        [todo.app_scope_id, ISSUER_A],
        [crmA.app_scope_id, ISSUER_A],
        [extraCrm.app_scope_id, ISSUER_A],
        [desk.app_scope_id, ISSUER_B],
      ]),
    });
    // The pinned `acme/todo` answers the bare slug; channels travel as declared.
    expect(grants).toEqual([{ actor: todo.app_scope_id, permissions: ['note:read', 'note:write'], channels: ['peer'] }]);
    expect(skipped).toEqual([
      // Two exact `crm` installs: which one is meant is not guessed (the pinned one loses to exact spellings).
      { actor: 'crm', reason: 'ambiguous', scopeIds: [crmA.app_scope_id, extraCrm.app_scope_id].sort() },
      { actor: 'desk', reason: 'other-issuer', scopeId: desk.app_scope_id },
      { actor: 'billing', reason: 'not-installed' },
      { actor: 'wiki', reason: 'not-installed' },
      { actor: 'acme/todo', reason: 'duplicate', scopeId: todo.app_scope_id },
    ]);
  });

  it('carries no channels when none were declared, which the issuer reads as mcp alone', () => {
    const todo = row({ vertical_slug: 'todo' });
    const { grants } = delegationGrantsFor({
      declared: [{ actor: 'todo', permissions: ['note:read'] as ManifestDelegation['permissions'] }],
      hostIssuerScopeId: ISSUER_A,
      apps: [todo],
      tenantSlug: null,
      issuerOfApp: new Map([[todo.app_scope_id, ISSUER_A]]),
    });
    expect(grants).toEqual([{ actor: todo.app_scope_id, permissions: ['note:read'] }]);
  });
});

describe('the reconcile pass', () => {
  const issuerApp = row({ vertical_slug: 'auth-server', hostname: 'auth-acme.global.substrat.run' });
  const otherIssuer = row({ vertical_slug: 'auth-server', hostname: 'auth2-acme.global.substrat.run' });
  const isIssuer = (a: DashboardAppRow) => a.vertical_slug === 'auth-server';
  const READS: ManifestDelegation[] = [{ actor: 'todo', permissions: ['note:read'] as ManifestDelegation['permissions'] }];

  const world = (opts: { declared: Map<string, ManifestDelegation[] | null>; issuerOf: Map<string, string | null> }) => {
    const configured: Array<{ scopeId: string; key: string; value: string }> = [];
    const controlPlane = {
      listHostnames: async () => [],
      configureInstance: async (sid: string, entries: Array<{ key: string; value: string }>) => {
        for (const e of entries) configured.push({ scopeId: sid, ...e });
      },
    };
    return {
      configured,
      run: (apps: DashboardAppRow[]) =>
        reconcileDelegations({
          apps: [issuerApp, otherIssuer, ...apps],
          isIssuer,
          issuerOf: async (id) => opts.issuerOf.get(id) ?? null,
          declaredOf: async (a) => opts.declared.get(a.app_scope_id) ?? null,
          tenantSlug: null,
          controlPlane: controlPlane as never,
        }),
    };
  };

  it('grants when the actor is installed, revokes when it goes, and leaves an undeclared version alone', async () => {
    const notes = row({ vertical_slug: 'notes' });
    const todo = row({ vertical_slug: 'todo' });
    const legacy = row({ vertical_slug: 'ticket0' });
    const issuer = 'https://auth-acme.global.substrat.run';
    const w = world({
      declared: new Map([
        [notes.app_scope_id, READS],
        [todo.app_scope_id, []],
        [legacy.app_scope_id, null],
      ]),
      issuerOf: new Map([
        [notes.app_scope_id, issuer],
        [todo.app_scope_id, issuer],
        [legacy.app_scope_id, issuer],
      ]),
    });
    const key = `substrat:delegations:${notes.app_scope_id}`;

    const order = (cs: typeof w.configured) => [...cs].sort((a, b) => `${a.key}${a.scopeId}`.localeCompare(`${b.key}${b.scopeId}`));

    // The actor is installed: the host's set names it at its own issuer, and is `""` at the
    // team's other one (what an Identity change leaves behind). An app that declares nothing
    // is told so, which is what revokes a declaration a later version removed.
    const installed = await w.run([notes, todo, legacy]);
    expect(delegationsConverged(installed)).toBe(true);
    expect(order(w.configured)).toEqual(
      order([
        { scopeId: issuerApp.app_scope_id, key, value: JSON.stringify([{ actor: todo.app_scope_id, permissions: ['note:read'] }]) },
        { scopeId: otherIssuer.app_scope_id, key, value: '' },
        { scopeId: issuerApp.app_scope_id, key: `substrat:delegations:${todo.app_scope_id}`, value: '' },
        { scopeId: otherIssuer.app_scope_id, key: `substrat:delegations:${todo.app_scope_id}`, value: '' },
      ]),
    );

    // The actor is removed: the host's whole set is delivered without it.
    w.configured.length = 0;
    await w.run([notes, legacy]);
    expect(order(w.configured)).toEqual(
      order([
        { scopeId: issuerApp.app_scope_id, key, value: '' },
        { scopeId: otherIssuer.app_scope_id, key, value: '' },
      ]),
    );
  });

  it('grants nothing to an app on an issuer that is not a team auth-server, and says so once', async () => {
    const notes = row({ vertical_slug: 'notes' });
    const todo = row({ vertical_slug: 'todo' });
    const w = world({
      declared: new Map([[notes.app_scope_id, READS]]),
      issuerOf: new Map([
        [notes.app_scope_id, 'https://login.example.com'],
        [todo.app_scope_id, 'https://auth-acme.global.substrat.run'],
      ]),
    });
    const result = await w.run([notes, todo]);
    // Cleared at the team's auth-servers, in case it signed in at one before.
    expect(w.configured.map((c) => [c.scopeId, c.key, c.value]).sort()).toEqual(
      [issuerApp.app_scope_id, otherIssuer.app_scope_id].sort().map((sid) => [sid, `substrat:delegations:${notes.app_scope_id}`, '']),
    );
    const lines: string[] = [];
    const seen = new Set<string>();
    logDelegations('t', result, (m) => lines.push(m), seen);
    logDelegations('t', result, (m) => lines.push(m), seen);
    expect(lines).toEqual(['dashboard: delegations not delivered: the app does not sign in at a team auth-server']);
  });

  it('delivers nothing when an app\'s stored identity cannot be read, and does not converge', async () => {
    const notes = row({ vertical_slug: 'notes' });
    const configured: unknown[] = [];
    const result = await reconcileDelegations({
      apps: [issuerApp, notes],
      isIssuer,
      issuerOf: async () => {
        throw new Error('scope away');
      },
      declaredOf: async () => READS,
      tenantSlug: null,
      controlPlane: { listHostnames: async () => [], configureInstance: async (...a: unknown[]) => void configured.push(a) } as never,
    });
    expect(configured).toEqual([]);
    expect(result.unreadable).toEqual([notes.app_scope_id]);
    expect(delegationsConverged(result)).toBe(false);
  });
});

describe("the running version's declaration", () => {
  it('is the bound version, else prod, and none without either', async () => {
    const asked: string[] = [];
    const pinned = row({ vertical_slug: 'notes' });
    const following = row({ vertical_slug: 'notes' });
    const loose = row({ vertical_slug: 'wiki' });
    const read = runningDelegationsReader({
      boundVersionId: async (sid: string) => (sid === pinned.app_scope_id ? 'v1' : null),
      listChannels: async (slug: string) => (slug === 'notes' ? [{ channel: 'prod', versionId: 'v2' }] : []),
      versionDelegations: async (slug: string, v: string) => {
        asked.push(`${slug}@${v}`);
        return v === 'v1' ? [] : null;
      },
    } as never);
    expect(await read(pinned)).toEqual([]);
    expect(await read(following)).toBeNull();
    expect(await read(loose)).toBeNull();
    expect(asked).toEqual(['notes@v1', 'notes@v2']);
  });
});
