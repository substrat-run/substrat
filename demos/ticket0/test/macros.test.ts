/**
 * Macros (#1087): a saved reply that also acts, and the rule that keeps it from being a
 * way around the desk's permissions.
 *
 * The rule is the maintainer's: a macro checks the UNION of what its parts check, not
 * merely `conversation:draft`. Every claim here is driven in both directions. A suite
 * that only watched a macro be refused would pass against a handler that refused
 * everything, and one that only watched it apply would pass against a handler that
 * checked nothing.
 *
 * Refusal is observed through what did NOT happen as well as through the error: no
 * message, no assignee, no priority, and no event on the spine. "All or nothing" is a
 * claim about the second half.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  permissionsUsedBy,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type Page,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import {
  MACRO_ACTION_OPERATIONS,
  macroAction,
  ticket0Operations,
  type MacroAction,
} from '../spec/model.js';
import { T0_PERM, ticket0Manifest } from '../src/manifest.js';
import { macroPermissions } from '../src/module.js';
import { ROLES } from '../src/provision.js';
import { buildHost } from '../src/seed.js';

let dir: string;
let host: ScopeHost;

const staff = platformActorId.parse(ulid());

/**
 * Somebody who may write and send a reply but may not route, rank or resolve work.
 *
 * Declared here rather than taken from `ROLES` so the test says exactly which keys are
 * in play: the reply half of a macro is fully covered, and the assign half is not. If a
 * refusal comes back, it can only be the assign key's.
 */
const REPLIER = {
  key: 'replier',
  source: 'vertical' as const,
  permissions: [T0_PERM.conversationRead, T0_PERM.conversationDraft, T0_PERM.conversationReplyPublic],
};

interface Desk {
  tenant: ReturnType<typeof tenantId.parse>;
  scope: ReturnType<typeof scopeId.parse>;
  admin: PrincipalId;
  agent: PrincipalId;
  replier: PrincipalId;
  assistant: PrincipalId;
  relay: PrincipalId;
}

interface Conversation {
  id: string;
  state: string;
  assignee: string | null;
  priority: string;
  resolved_at: string | null;
}

interface SavedReply {
  id: string;
  title: string;
  body: string;
  actions: MacroAction[];
}

interface Applied {
  saved_reply_id: string;
  conversation_id: string;
  message_id: string;
  actions: string[];
  conversation: Conversation;
}

let desks = 0;

async function freshDesk(): Promise<Desk> {
  desks += 1;
  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: tenant, slug: `macros-${desks}`, name: `Desk ${desks}` });
  await host.admin.grantEntitlement(staff, tenant, ticket0Manifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'ticket0' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of [...ROLES, REPLIER]) await host.admin.defineRole(staff, tenant, role);

  const node = { tenantId: tenant, scopeId: scope };
  const mint = async (roleKey: string, name?: string) => {
    const p = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: p, roleKey, node });
    if (name) {
      await (await host.getScope(p, tenant, scope)).invoke('ticket0/set-agent-profile', {
        displayName: name,
        avatarUrl: null,
        signature: `${name}\nSupport`,
      });
    }
    return p;
  };
  const desk: Desk = {
    tenant,
    scope,
    admin: await mint('desk-admin'),
    agent: await mint('agent', 'Anna'),
    replier: await mint('replier', 'Rolf'),
    assistant: await mint('assistant'),
    relay: await mint('relay'),
  };
  await (await as(desk, desk.admin)).invoke('ticket0/configure-desk', { allowedOrigins: ['https://desk.example'] });
  return desk;
}

const as = (desk: Desk, who: PrincipalId): Promise<ScopeStub> => host.getScope(who, desk.tenant, desk.scope);

let mails = 0;
async function mail(desk: Desk): Promise<string> {
  mails += 1;
  const arrived = (await (await as(desk, desk.relay)).invoke('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: `customer-${mails}@customer.example`,
    contactName: 'Kim',
    subject: `Question ${mails}`,
    bodyText: 'Something is not working.',
    emailMessageId: `<macro-${mails}@mail.example>`,
  })) as { conversation_id: string };
  return arrived.conversation_id;
}

async function macro(desk: Desk, title: string, actions: MacroAction[], body = 'Hi {{contact.name}}, on it.'): Promise<SavedReply> {
  return (await (await as(desk, desk.agent)).invoke('ticket0/create-saved-reply', {
    title,
    body,
    actions,
  })) as SavedReply;
}

async function read(desk: Desk, id: string): Promise<Conversation> {
  return (await (await as(desk, desk.admin)).invoke('ticket0/get-conversation', { conversationId: id })) as Conversation;
}

async function messages(desk: Desk, id: string): Promise<{ visibility: string; body_text: string; author_kind: string }[]> {
  const page = (await (await as(desk, desk.admin)).invoke('ticket0/list-messages', { conversationId: id })) as Page<{
    visibility: string;
    body_text: string;
    author_kind: string;
  }>;
  return page.entries;
}

interface SpineRow {
  type: string;
  operation: string | null;
  authorization: string | null;
  payload: Record<string, unknown>;
}

/** Every event about this conversation or this saved reply — harness code, read-only. */
function spine(desk: Desk, ...entityIds: string[]): SpineRow[] {
  const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
  try {
    return (
      db
        .prepare(
          `SELECT type, operation, authorization, payload FROM _substrat_outbox
            WHERE entity_id IN (${entityIds.map(() => '?').join(', ')}) ORDER BY id`,
        )
        .all(...entityIds) as (Omit<SpineRow, 'payload'> & { payload: string })[]
    ).map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  } finally {
    db.close();
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-macros-'));
  host = buildHost(dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the rule: a macro needs every key its parts need', () => {
  it('is the union of the declared keys, read from the operations and not written per macro', () => {
    expect(macroPermissions('public', [])).toEqual(['conversation:draft', 'conversation:reply-public']);
    expect(macroPermissions('internal', [])).toEqual(['conversation:draft']);
    expect(
      macroPermissions('public', [
        { type: 'assign', assignee: null },
        { type: 'set-priority', priority: 'urgent' },
      ]),
    ).toEqual(['conversation:assign', 'conversation:draft', 'conversation:reply-public']);
    expect(macroPermissions('internal', [{ type: 'resolve' }])).toEqual([
      'conversation:draft',
      'conversation:resolve',
    ]);
  });

  it('covers every action the bag can hold, each by the key its own operation declares', () => {
    // Enumerated from the SCHEMA, so an action added there is in this loop whether or
    // not anybody remembers this test exists.
    const types = macroAction.options.map((o) => o.shape.type.value);
    expect(new Set(Object.keys(MACRO_ACTION_OPERATIONS))).toEqual(new Set(types));
    for (const type of types) {
      const op = MACRO_ACTION_OPERATIONS[type];
      const declared = permissionsUsedBy({ [op]: ticket0Operations[op] });
      expect(declared, `${type} → ${op}`).toHaveLength(1);
      expect(macroPermissions('internal', [{ type } as MacroAction])).toContain(declared[0]);
    }
  });

  it('refuses to compile an action with no operation behind it', () => {
    // The gate is the `satisfies` on `MACRO_ACTION_OPERATIONS`: a map missing an action
    // type is a type error. This is that error, pinned, so a loosened annotation fails
    // `pnpm typecheck` here instead of passing quietly.
    type Action = 'tag' | 'set-priority' | 'assign' | 'resolve' | 'close';
    const missing = {
      tag: 'ticket0/tag-conversation',
      'set-priority': 'ticket0/set-priority',
      assign: 'ticket0/assign',
      resolve: 'ticket0/resolve',
      // @ts-expect-error — `close` is in the bag and names no operation.
    } as const satisfies Record<Action, keyof typeof ticket0Operations>;
    expect(Object.keys(missing)).not.toContain('close');
  });
});

describe('refused: holding draft is not holding assign', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk();
  });

  it('refuses a macro that assigns and re-prioritises, and applies nothing — not even the reply', async () => {
    const conversation = await mail(desk);
    const reply = await macro(desk, 'Escalate to Anna', [
      { type: 'assign', assignee: desk.agent },
      { type: 'set-priority', priority: 'urgent' },
    ]);
    const before = await read(desk, conversation);
    const eventsBefore = spine(desk, conversation, reply.id).length;

    await expect(
      (await as(desk, desk.replier)).invoke('ticket0/apply-saved-reply', {
        conversationId: conversation,
        savedReplyId: reply.id,
      }),
    ).rejects.toThrow(/denied/i);

    const after = await read(desk, conversation);
    expect(after).toEqual(before);
    expect(after.assignee).toBeNull();
    expect(after.priority).toBe('normal');
    expect((await messages(desk, conversation)).filter((m) => m.author_kind !== 'contact')).toEqual([]);
    expect(spine(desk, conversation, reply.id)).toHaveLength(eventsBefore);
  });

  it('checks the whole union BEFORE any part runs, not part by part as each handler gets to it', async () => {
    // What tells the two apart: this reply renders to nothing for this conversation,
    // which `apply-saved-reply` refuses as `validation_failed` once it gets that far.
    // Checked up front, the missing assign key is the answer. Checked only inside each
    // handler, the empty body would be found first and the key never asked about. The
    // second is the shape where an action whose handler forgot its check would run.
    const conversation = await mail(desk);
    const blank = await macro(desk, 'Signature only', [{ type: 'assign', assignee: desk.agent }], '{{agent.signature}}');
    const replier = await as(desk, desk.replier);
    // A replier with no signature, so the body renders to nothing for them. Confirmed
    // through the render first, so the premise is observed rather than assumed.
    await replier.invoke('ticket0/set-agent-profile', { displayName: 'Rolf', avatarUrl: null, signature: null });
    const rendered = (await replier.invoke('ticket0/render-saved-reply', {
      conversationId: conversation,
      savedReplyId: blank.id,
    })) as { body: string };
    expect(rendered.body).toBe('');
    await expect(
      replier.invoke('ticket0/apply-saved-reply', { conversationId: conversation, savedReplyId: blank.id }),
    ).rejects.toThrow(/denied/i);
    // Its twin: without the action, the same caller reaches the empty-body refusal.
    const blankPlain = await macro(desk, 'Blank, no actions', [], '{{agent.signature}}');
    await expect(
      replier.invoke('ticket0/apply-saved-reply', { conversationId: conversation, savedReplyId: blankPlain.id }),
    ).rejects.toThrow(/renders to nothing/);
  });

  it('is the ACTION being refused: the same person may send the same reply with no actions', async () => {
    // Without this twin, the refusal above could be the replier failing the reply half.
    const conversation = await mail(desk);
    const plain = await macro(desk, 'Plain answer', []);
    const applied = (await (await as(desk, desk.replier)).invoke('ticket0/apply-saved-reply', {
      conversationId: conversation,
      savedReplyId: plain.id,
    })) as Applied;
    expect(applied.actions).toEqual([]);
    expect((await messages(desk, conversation)).map((m) => m.body_text)).toContain('Hi Kim, on it.');
  });

  it('counts the reply as a part too: the assistant holds draft and not reply-public', async () => {
    const conversation = await mail(desk);
    const plain = await macro(desk, 'Plain answer, again', []);
    const assistant = await as(desk, desk.assistant);
    await expect(
      assistant.invoke('ticket0/apply-saved-reply', { conversationId: conversation, savedReplyId: plain.id }),
    ).rejects.toThrow(/denied/i);
    expect((await messages(desk, conversation)).filter((m) => m.visibility === 'public' && m.author_kind !== 'contact')).toEqual([]);
    // Internal needs only draft, which it holds.
    await assistant.invoke('ticket0/apply-saved-reply', {
      conversationId: conversation,
      savedReplyId: plain.id,
      visibility: 'internal',
    });
    expect((await messages(desk, conversation)).map((m) => m.visibility)).toContain('internal');
  });

  it('refuses an internal macro that resolves, to somebody who holds draft and not resolve', async () => {
    const conversation = await mail(desk);
    const closer = await macro(desk, 'Note and resolve', [{ type: 'resolve' }]);
    await expect(
      (await as(desk, desk.assistant)).invoke('ticket0/apply-saved-reply', {
        conversationId: conversation,
        savedReplyId: closer.id,
        visibility: 'internal',
      }),
    ).rejects.toThrow(/denied/i);
    expect(await messages(desk, conversation)).toHaveLength(1);
  });
});

describe('applied: with every key held, the whole macro goes through', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk();
  });

  it('sends the rendered reply and runs every action, in one call', async () => {
    const conversation = await mail(desk);
    const reply = await macro(desk, 'Billing, urgent, mine', [
      { type: 'tag', tag: 'billing' },
      { type: 'set-priority', priority: 'urgent' },
      { type: 'assign', assignee: desk.agent },
    ]);
    const applied = (await (await as(desk, desk.agent)).invoke('ticket0/apply-saved-reply', {
      conversationId: conversation,
      savedReplyId: reply.id,
    })) as Applied;

    expect(applied.actions).toEqual(['tag', 'set-priority', 'assign']);
    expect(applied.conversation).toMatchObject({ assignee: desk.agent, priority: 'urgent', state: 'open' });
    const sent = (await messages(desk, conversation)).find((m) => m.visibility === 'public' && m.author_kind === 'agent');
    expect(sent?.body_text).toBe('Hi Kim, on it.');
    const tags = (await (await as(desk, desk.agent)).invoke('ticket0/list-conversation-tags', {
      conversationId: conversation,
    })) as { tags: { tag: string }[] };
    expect(tags.tags.map((t) => t.tag)).toEqual(['billing']);
  });

  it('leaves the same trail a person’s own clicks would, each event under its own check', async () => {
    const conversation = await mail(desk);
    const reply = await macro(desk, 'Assign and rank', [
      { type: 'assign', assignee: desk.agent },
      { type: 'set-priority', priority: 'low' },
    ]);
    const applied = (await (await as(desk, desk.agent)).invoke('ticket0/apply-saved-reply', {
      conversationId: conversation,
      savedReplyId: reply.id,
    })) as Applied;
    // The reply's event is about the MESSAGE, as a person's reply's is.
    const events = spine(desk, conversation, reply.id, applied.message_id).filter(
      (e) => e.operation === 'ticket0/apply-saved-reply',
    );
    expect(events.map((e) => e.type)).toEqual([
      'ticket0.reply-requested',
      'ticket0.conversation-assigned',
      'ticket0.conversation-priority-set',
      'ticket0.saved-reply-applied',
    ]);
    const checked = (e: SpineRow) =>
      (JSON.parse(e.authorization ?? '[]') as { permission: string }[]).map((a) => a.permission);
    expect(checked(events[1]!)).toContain('conversation:assign');
    expect(checked(events[2]!)).toContain('conversation:assign');
    expect(events[3]!.payload).toEqual({
      saved_reply_id: reply.id,
      conversation_id: conversation,
      message_id: applied.message_id,
      actions: ['assign', 'set-priority'],
    });

    // The same payloads a person assigning by hand produces: the macro ran that code.
    const other = await mail(desk);
    await (await as(desk, desk.agent)).invoke('ticket0/assign', { conversationId: other, assignee: desk.agent });
    const manual = spine(desk, other).find((e) => e.type === 'ticket0.conversation-assigned')!;
    expect(Object.keys(manual.payload).sort()).toEqual(Object.keys(events[1]!.payload).sort());
  });

  it('replies before it resolves, so "answer and resolve" works on a conversation nobody has answered', async () => {
    const conversation = await mail(desk);
    const done = await macro(desk, 'Answer and resolve', [{ type: 'resolve' }], 'Fixed, {{contact.name}}.');
    const applied = (await (await as(desk, desk.agent)).invoke('ticket0/apply-saved-reply', {
      conversationId: conversation,
      savedReplyId: done.id,
    })) as Applied;
    expect(applied.conversation.state).toBe('resolved');
    expect(applied.conversation.resolved_at).not.toBeNull();
  });

  it('sends the words the agent actually sent when they edited the rendered text', async () => {
    const conversation = await mail(desk);
    const reply = await macro(desk, 'Editable', [{ type: 'tag', tag: 'edited' }]);
    await (await as(desk, desk.agent)).invoke('ticket0/apply-saved-reply', {
      conversationId: conversation,
      savedReplyId: reply.id,
      body: 'Hi Kim, on it. Back within the hour.',
    });
    expect((await messages(desk, conversation)).map((m) => m.body_text)).toContain('Hi Kim, on it. Back within the hour.');
  });
});

describe('all or nothing: a part refused halfway rolls back the parts before it', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk();
  });

  it('takes the reply back when an action’s own operation refuses', async () => {
    // Every key is held, so the union passes. `ticket0/assign` then refuses a principal
    // outside the directory, which is its own rule, reached by running its own handler.
    const conversation = await mail(desk);
    const reply = await macro(desk, 'Tag then assign a stranger', [
      { type: 'tag', tag: 'lost' },
      { type: 'assign', assignee: 'nobody-here' },
    ]);
    const before = spine(desk, conversation, reply.id).length;
    await expect(
      (await as(desk, desk.agent)).invoke('ticket0/apply-saved-reply', {
        conversationId: conversation,
        savedReplyId: reply.id,
      }),
    ).rejects.toThrow();
    expect(await messages(desk, conversation)).toHaveLength(1);
    const tags = (await (await as(desk, desk.agent)).invoke('ticket0/list-conversation-tags', {
      conversationId: conversation,
    })) as { tags: unknown[] };
    expect(tags.tags).toEqual([]);
    expect((await read(desk, conversation)).state).toBe('new');
    expect(spine(desk, conversation, reply.id)).toHaveLength(before);
  });

  it('and the positive twin: the same macro with a real assignee lands whole', async () => {
    const conversation = await mail(desk);
    const reply = await macro(desk, 'Tag then assign Anna', [
      { type: 'tag', tag: 'found' },
      { type: 'assign', assignee: desk.agent },
    ]);
    await (await as(desk, desk.agent)).invoke('ticket0/apply-saved-reply', {
      conversationId: conversation,
      savedReplyId: reply.id,
    });
    expect((await read(desk, conversation)).assignee).toBe(desk.agent);
    expect(await messages(desk, conversation)).toHaveLength(2);
  });
});

describe('the bag on the saved reply itself', () => {
  let desk: Desk;
  beforeAll(async () => {
    desk = await freshDesk();
  });

  it('is handed out parsed, edited whole, and emptied by an empty list', async () => {
    const reply = await macro(desk, 'Round trip', [{ type: 'tag', tag: 'a' }]);
    expect(reply.actions).toEqual([{ type: 'tag', tag: 'a' }]);
    const agent = await as(desk, desk.agent);
    const got = (await agent.invoke('ticket0/get-saved-reply', { savedReplyId: reply.id })) as SavedReply;
    const edited = (await agent.invoke('ticket0/update-saved-reply', {
      savedReplyId: got.id,
      actions: [{ type: 'resolve' }],
    })) as SavedReply;
    expect(edited.actions).toEqual([{ type: 'resolve' }]);
    // Title only: the bag is left as it was.
    const renamed = (await agent.invoke('ticket0/update-saved-reply', {
      savedReplyId: got.id,
      title: 'Round trip, renamed',
    })) as SavedReply;
    expect(renamed.actions).toEqual([{ type: 'resolve' }]);
    const emptied = (await agent.invoke('ticket0/update-saved-reply', { savedReplyId: got.id, actions: [] })) as SavedReply;
    expect(emptied.actions).toEqual([]);
    const page = (await agent.invoke('ticket0/list-saved-replies', {})) as Page<SavedReply>;
    expect(page.entries.find((r) => r.id === reply.id)?.actions).toEqual([]);
  });

  it('refuses an action it does not know at save time, rather than saving a macro that does nothing', async () => {
    await expect(
      (await as(desk, desk.agent)).invoke('ticket0/create-saved-reply', {
        title: 'Typo',
        body: 'Hello.',
        actions: [{ type: 'tag', tags: 'x' }],
      }),
    ).rejects.toThrow();
    await expect(
      (await as(desk, desk.agent)).invoke('ticket0/create-saved-reply', {
        title: 'Unknown',
        body: 'Hello.',
        actions: [{ type: 'delete-everything' }],
      }),
    ).rejects.toThrow();
  });

  it('refuses to apply a bag this version cannot read, instead of running part of it', async () => {
    const conversation = await mail(desk);
    const reply = await macro(desk, 'Corrupted later', [{ type: 'tag', tag: 'x' }]);
    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`));
    try {
      db.prepare('UPDATE ticket0_saved_replies SET actions = ? WHERE id = ?').run('[{"type":"close"}]', reply.id);
    } finally {
      db.close();
    }
    await expect(
      (await as(desk, desk.agent)).invoke('ticket0/apply-saved-reply', {
        conversationId: conversation,
        savedReplyId: reply.id,
      }),
    ).rejects.toThrow(/cannot read/);
    expect(await messages(desk, conversation)).toHaveLength(1);
  });
});
