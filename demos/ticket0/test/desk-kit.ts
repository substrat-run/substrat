/**
 * A fresh desk per test block, and the handful of verbs the built-in behaviours' suites
 * (#1083) all need — one place, so `automation.test.ts` and `off-boarding.test.ts` build
 * their worlds the same way and neither restates the other.
 *
 * Every block builds its OWN desk rather than reading the seeded one. Asserting "exactly
 * these conversations were closed" means knowing exactly what exists, and a shared world
 * would make every count a fact about whichever test ran first. Time moves on purpose, on
 * a `manualClock`: a window measured in days is only testable at its boundary if the test
 * owns the clock.
 *
 * Harness code, so the scope's own SQLite file is fair game where a test needs the spine
 * (`SqliteScopeHost` names it after the pair). Read-only unless it says otherwise.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type Page,
  type PrincipalId,
} from '@substrat-run/contracts';
import {
  manualClock,
  ulid,
  type ManualClock,
  type PermissionChecker,
  type ScopeHost,
  type ScopeStub,
} from '@substrat-run/kernel';
import { ticket0Manifest } from '../src/manifest.js';
import { ASSISTANT_NAME } from '../src/module.js';
import { ROLES } from '../src/provision.js';
import { buildHost } from '../src/seed.js';

export const TICKET0 = moduleId.parse(ticket0Manifest.id);
export const ORIGIN = 'https://desk.example';
const staff = platformActorId.parse(ulid());

export interface Desk {
  readonly tenant: ReturnType<typeof tenantId.parse>;
  readonly scope: ReturnType<typeof scopeId.parse>;
  readonly admin: PrincipalId;
  readonly relay: PrincipalId;
  readonly widget: PrincipalId;
  /** The people on the desk, in the order they joined — NOT ring order. */
  readonly agents: PrincipalId[];
}

export interface ConversationRead {
  id: string;
  state: string;
  assignee: string | null;
  subject: string;
  updated_at: string;
  resolved_at: string | null;
  auto_tagged_at: string | null;
  no_reply_notified_at: string | null;
  no_reply_notified_message_id: string | null;
}

export interface Kit {
  readonly dir: string;
  readonly host: ScopeHost;
  readonly clock: ManualClock;
  freshDesk(opts: { agents: number }): Promise<Desk>;
  hire(desk: Desk): Promise<PrincipalId>;
  /**
   * Somebody on the directory whose ONLY grant is `conversation:draft` — enough to write a
   * profile, and no read access to any thread. What a follow gives them is the whole of
   * what they can see, which makes a follow observable. Not in the ring's `agents` list.
   */
  guest(desk: Desk): Promise<PrincipalId>;
  as(desk: Desk, who: PrincipalId): Promise<ScopeStub>;
  /** The schedule's own principal, as the platform sweep invokes an operation. */
  system(desk: Desk): Promise<ScopeStub>;
  configure(desk: Desk, settings: Record<string, unknown>): Promise<void>;
  /** Run one schedule's operation as the schedule's own principal, and read one count off its answer. */
  sweep(desk: Desk, operation: string, count: string): Promise<number>;
  /** Take the schedule principal's grant for `permission` away — the desk's off switch of last resort. */
  revokeSystemGrant(desk: Desk, permission: string): void;
  /** How many `escalated` notices `who` holds for a conversation. */
  escalations(desk: Desk, who: PrincipalId, conversationId: string): Promise<number>;
  /** An agent answers in public, then parks the conversation until `ms` from now. */
  park(desk: Desk, id: string, ms: number): Promise<void>;
  /** A customer writes in — a new conversation, or a new message into `into`. A minute after the last. */
  mail(desk: Desk, opts?: { subject?: string; body?: string; into?: string; from?: string }): Promise<string>;
  /** A visitor opens the widget and says something, a minute after the last thing. */
  chat(desk: Desk): Promise<{ conversationId: string; sessionId: string; token: string }>;
  read(desk: Desk, id: string): Promise<ConversationRead>;
  /** An agent answers in public and resolves. */
  resolve(desk: Desk, id: string): Promise<void>;
  tags(desk: Desk, id: string): Promise<string[]>;
  notifications(desk: Desk, who: PrincipalId): Promise<{ kind: string; conversation_id: string | null }[]>;
  runs(desk: Desk): Promise<{ behaviour: string; last_fired_at: string; last_count: number }[]>;
  /** The spine, read the way an auditor would. */
  events(
    desk: Desk,
    type: string,
    entityId?: string,
  ): { actor: string; operation: string | null; authorization: string | null; payload: string }[];
  /**
   * Make the host's permission checker refuse any PER-ENTITY check the schedule's own
   * principal makes on these conversations — and nothing else, so a node-level check and a
   * person's read still pass. The only way to see a
   * per-conversation check at all: a schedule's principal holds a node-wide grant, so with
   * the real checker a per-row check and a node check cannot be told apart. Pass an empty
   * list to lift it.
   */
  denyEntities(ids: readonly string[]): void;
  /** Run harness SQL on a desk's own database (a stand-in for a row this version never wrote). */
  sql<T>(desk: Desk, fn: (db: Database.Database) => T): T;
  dispose(): void;
}

export function createKit(prefix: string): Kit {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const clock = manualClock('2026-09-30T08:00:00.000Z');
  const host = buildHost(dir, clock.read);
  let desks = 0;
  let mails = 0;
  const denied = new Set<string>();
  // Wrap the checker the host built. It is read again for every invocation's context, so
  // swapping it here takes effect on the next call. Node-level checks carry no entity and
  // fall through to the real checker untouched.
  const wrapped = host as unknown as { checker: PermissionChecker };
  const inner = wrapped.checker;
  wrapped.checker = {
    covers: (...args) => inner.covers(...args),
    check: async (subject, permission, node, entity) =>
      entity && denied.has(entity.entityId) && subject.kind === 'system'
        ? { allowed: false, checked: permission, node }
        : inner.check(subject, permission, node, entity),
  };

  const as = (desk: Desk, who: PrincipalId): Promise<ScopeStub> => host.getScope(who, desk.tenant, desk.scope);
  const dbPath = (desk: Desk) => join(dir, `${desk.tenant}__${desk.scope}.sqlite`);

  const kit: Kit = {
    dir,
    host,
    clock,
    as,
    system: (desk) => host.getSystemScope(TICKET0, desk.tenant, desk.scope),

    async freshDesk({ agents }) {
      desks += 1;
      const tenant = tenantId.parse(ulid());
      const scope = scopeId.parse(ulid());
      await host.admin.createTenant(staff, { id: tenant, slug: `automation-${desks}`, name: `Desk ${desks}` });
      await host.admin.grantEntitlement(staff, tenant, ticket0Manifest.entitlementKey as string);
      await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'ticket0' });
      await host.admin.activateScope(staff, tenant, scope);
      for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);

      const node = { tenantId: tenant, scopeId: scope };
      const mint = async (roleKey: string) => {
        const p = principalId.parse(ulid());
        await host.admin.assignRole(staff, { principalId: p, roleKey, node });
        return p;
      };
      const admin = await mint('desk-admin');
      const relay = await mint('relay');
      const widget = await mint('widget');
      const assistant = await mint('assistant');

      await (await host.getScope(admin, tenant, scope)).invoke('ticket0/configure-desk', {
        allowedOrigins: [ORIGIN],
      });
      // The assistant has a profile, as on a real desk: it needs a byline. It is in the
      // directory and must never be in a ring or a broadcast.
      await (await host.getScope(assistant, tenant, scope)).invoke('ticket0/set-agent-profile', {
        displayName: ASSISTANT_NAME,
        avatarUrl: null,
        signature: null,
      });

      const desk: Desk = { tenant, scope, admin, relay, widget, agents: [] };
      for (let i = 0; i < agents; i++) await kit.hire(desk);
      return desk;
    },

    async hire(desk) {
      const p = principalId.parse(ulid());
      await host.admin.assignRole(staff, {
        principalId: p,
        roleKey: 'agent',
        node: { tenantId: desk.tenant, scopeId: desk.scope },
      });
      await (await host.getScope(p, desk.tenant, desk.scope)).invoke('ticket0/set-agent-profile', {
        displayName: `Agent ${desk.agents.length + 1}`,
        avatarUrl: null,
        signature: null,
      });
      desk.agents.push(p);
      return p;
    },

    async sweep(desk, operation, count) {
      const answer = (await (await kit.system(desk)).invoke(operation)) as Record<string, number>;
      return answer[count]!;
    },

    revokeSystemGrant(desk, permission) {
      const removed = kit.sql(desk, (db) =>
        db
          .prepare(`DELETE FROM _substrat_tuples WHERE subject = ? AND relation = ?`)
          .run(`system:${ticket0Manifest.id}`, `granted:${permission}`),
      );
      if (removed.changes < 1) throw new Error(`the schedule principal held no grant for ${permission}`);
    },

    async escalations(desk, who, conversationId) {
      return (await kit.notifications(desk, who)).filter(
        (n) => n.kind === 'escalated' && n.conversation_id === conversationId,
      ).length;
    },

    async park(desk, id, ms) {
      const agent = await as(desk, desk.admin);
      await agent.invoke('ticket0/post-public-reply', { conversationId: id, body: 'Looking.' });
      await agent.invoke('ticket0/snooze', {
        conversationId: id,
        until: new Date(Date.parse(clock.read()) + ms).toISOString(),
      });
    },

    async guest(desk) {
      const p = principalId.parse(ulid());
      await host.admin.grant(staff, {
        principalId: p,
        permission: permissionKey.parse('conversation:draft'),
        node: { tenantId: desk.tenant, scopeId: desk.scope },
        grantedBy: desk.admin,
      });
      await (await host.getScope(p, desk.tenant, desk.scope)).invoke('ticket0/set-agent-profile', {
        displayName: 'Guest',
        avatarUrl: null,
        signature: null,
      });
      return p;
    },

    async configure(desk, settings) {
      await (await as(desk, desk.admin)).invoke('ticket0/configure-desk', { settings });
    },

    async mail(desk, opts = {}) {
      clock.advance(60_000);
      mails += 1;
      const arrived = (await (await as(desk, desk.relay)).invoke('ticket0/ingest-message', {
        conversationId: opts.into ?? null,
        contactEmail: opts.from ?? `customer-${mails}@customer.example`,
        contactName: null,
        subject: opts.subject ?? `Question ${mails}`,
        bodyText: opts.body ?? 'Something is not working.',
        emailMessageId: `<automation-${mails}@mail.example>`,
      })) as { conversation_id: string };
      return arrived.conversation_id;
    },

    async chat(desk) {
      clock.advance(60_000);
      const widget = await as(desk, desk.widget);
      const started = (await widget.invoke('ticket0/widget-start', { origin: ORIGIN })) as {
        sessionId: string;
        token: string;
      };
      const posted = (await widget.invoke('ticket0/widget-post', {
        sessionId: started.sessionId,
        token: started.token,
        body: 'How do I rotate a key?',
      })) as { conversation_id: string };
      return { conversationId: posted.conversation_id, ...started };
    },

    async read(desk, id) {
      return (await (await as(desk, desk.admin)).invoke('ticket0/get-conversation', {
        conversationId: id,
      })) as ConversationRead;
    },

    async resolve(desk, id) {
      const agent = await as(desk, desk.admin);
      await agent.invoke('ticket0/post-public-reply', { conversationId: id, body: 'Sorted — anything else?' });
      await agent.invoke('ticket0/resolve', { conversationId: id });
    },

    async tags(desk, id) {
      const out = (await (await as(desk, desk.admin)).invoke('ticket0/list-conversation-tags', {
        conversationId: id,
      })) as { tags: { tag: string }[] };
      return out.tags.map((t) => t.tag);
    },

    async notifications(desk, who) {
      const page = (await (await as(desk, who)).invoke('ticket0/my-notifications', {})) as Page<{
        kind: string;
        conversation_id: string | null;
      }>;
      return page.entries;
    },

    async runs(desk) {
      const out = (await (await as(desk, desk.admin)).invoke('ticket0/list-behaviour-runs', {})) as {
        runs: { behaviour: string; last_fired_at: string; last_count: number }[];
      };
      return out.runs;
    },

    events(desk, type, entityId) {
      const db = new Database(dbPath(desk), { readonly: true });
      try {
        return db
          .prepare(
            `SELECT actor, operation, authorization, payload FROM _substrat_outbox
              WHERE type = ? ${entityId ? 'AND entity_id = ?' : ''} ORDER BY id`,
          )
          .all(...(entityId ? [type, entityId] : [type])) as {
          actor: string;
          operation: string | null;
          authorization: string | null;
          payload: string;
        }[];
      } finally {
        db.close();
      }
    },

    sql(desk, fn) {
      const db = new Database(dbPath(desk));
      try {
        return fn(db);
      } finally {
        db.close();
      }
    },

    denyEntities(ids) {
      denied.clear();
      for (const id of ids) denied.add(id);
    },

    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return kit;
}
