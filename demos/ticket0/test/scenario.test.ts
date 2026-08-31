/**
 * The scenario from spec/concept.md §8, replayed headlessly.
 *
 * Written from the CONCEPT, never from the model: a test derived from the model
 * agrees with a wrong model perfectly and forever.
 *
 * It is one story, and the ids it creates are threaded through rather than
 * re-derived from a list read in each block — a test that re-finds "the first
 * conversation" is asserting about whatever sorted first that day.
 *
 * The denials are not an appendix. Two of them are the demo:
 *   - the same assistant, same code path, allowed in one desk and refused in the
 *     other, because of one grant;
 *   - an agent who works the whole inbox and cannot see what any of it cost.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { principalId, type CountedPage, type Page } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import { T0_PERM } from '../src/manifest.js';
import { buildHost, seed, signIdentity, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

type Role = 'admin' | 'agent' | 'assistant' | 'customer' | 'relay' | 'widget';

/** Everyone addresses their OWN desk. Nobody is handed another's coordinates. */
const at = (desk: Desk, role: Role): Promise<ScopeStub> =>
  host.getScope(desk[role].principal, desk.tenant, desk.scope);

interface Conversation {
  id: string;
  subject: string;
  state: string;
  contact_id: string;
  first_public_reply_at: string | null;
  assignee: string | null;
  priority: string;
  merged_into: string | null;
}
interface Message {
  id: string;
  visibility: string;
  author_kind: string;
  body_text: string;
  conversation_id: string;
}

/** The one story every block below is about. */
const story = {
  conversation: '',
  session: '',
  token: '',
  assistantReply: '',
  note: '',
  kestrelConversation: '',
};

const TURN = 'turn-0001';

/**
 * Open a widget session the way an embedded chat would: as the desk's WIDGET
 * service, carrying a signature the host page's server computed. The customer's own
 * principal plays no part — it is a portal concern.
 */
async function openSession(desk: Desk, identify = true) {
  const widget = await at(desk, 'widget');
  return (await widget.invoke('ticket0/widget-start', {
    origin: desk.origin,
    identity: identify
      ? {
          externalId: desk.customer.email,
          email: desk.customer.email,
          displayName: desk.customer.name,
          signature: await signIdentity(desk.verificationSecret, desk.customer.email),
        }
      : null,
  })) as { sessionId: string; token: string; verified: boolean };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-scenario-'));
  host = buildHost(dir);
  world = await seed(host);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('a question arrives and gets answered', () => {
  it('the customer opens the widget and is recognised without logging in', async () => {
    const started = await openSession(world.substrat);
    // The middle rung: the host site's server vouched for her, and the browser only
    // carried the signature.
    expect(started.verified).toBe(true);
    story.session = started.sessionId;
    story.token = started.token;
  });

  it('she asks, and it lands as a public message', async () => {
    const widget = await at(world.substrat, 'widget');
    const msg = (await widget.invoke('ticket0/widget-post', {
      sessionId: story.session,
      token: story.token,
      body: 'How do I run a migration against a scope that is already live?',
    })) as Message;
    expect(msg.visibility).toBe('public');
    expect(msg.author_kind).toBe('contact');
    // The conversation came into being with this message, not with the session.
    story.conversation = msg.conversation_id;
  });

  it('the assistant finds the answer in the desk’s own docs', async () => {
    const assistant = await at(world.substrat, 'assistant');
    const found = (await assistant.invoke('ticket0/search-kb', { q: 'migration' })) as {
      results: { title: string; url: string }[];
    };
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results[0]!.title).toBe('Migrations against a live scope');
    // Kestrel's docs are in Kestrel's database. Not filtered out — not present.
    expect(found.results.every((r) => r.url.startsWith('https://substrat.net/'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('what a turn costs, counted once', () => {
  it('the assistant records its answer and its tokens in one act', async () => {
    const assistant = await at(world.substrat, 'assistant');
    const turn = (await assistant.invoke('ticket0/record-answer', {
      conversationId: story.conversation,
      turnId: TURN,
      model: 'claude-sonnet-5',
      body: 'Append a new migration — a shipped one is never edited.',
      inputTokens: 1200,
      outputTokens: 300,
      citedArticleIds: [],
      confidence: 0.91,
      outcome: 'drafted',
    })) as { id: string; input_tokens: number; confidence: number; message_id: string };
    expect(turn.id).toBe(TURN);
    expect(turn.input_tokens).toBe(1200);
    // The column is declared INTEGER and holds a fraction — SQLite affinity keeps it
    // REAL rather than truncating. Asserted, because "0.91 became 0" is exactly the
    // failure the migration checkpoint is asking about.
    expect(turn.confidence).toBe(0.91);
  });

  it('the drafted answer is INTERNAL — recording is not sending', async () => {
    const agent = await at(world.substrat, 'agent');
    const msgs = (await agent.invoke('ticket0/list-messages', {
      conversationId: story.conversation,
    })) as CountedPage<Message>;
    const draft = msgs.entries.find((m) => m.author_kind === 'assistant');
    expect(draft).toBeDefined();
    expect(draft!.visibility).toBe('internal');
  });

  /**
   * The single assertion the metering engine exists to make true. A retried turn is
   * the most ordinary failure there is, and it must not become a second bill.
   */
  it('replaying the same turn does not bill twice', async () => {
    const admin = await at(world.substrat, 'admin');
    // Narrowed to THIS conversation, so the assertion is about the turn under test
    // rather than about everything else the seeded world happens to contain.
    const inputLine = async () => {
      const usage = (await admin.invoke('ticket0/usage-summary', {
        conversationId: story.conversation,
      })) as { lines: { meterKey: string; qty: string; entryCount: number }[] };
      return usage.lines.find((l) => l.meterKey === 'ai.tokens.input')!;
    };

    const before = await inputLine();
    expect(before.qty).toBe('1200');
    expect(before.entryCount).toBe(1);

    const assistant = await at(world.substrat, 'assistant');
    await assistant.invoke('ticket0/record-answer', {
      conversationId: story.conversation,
      turnId: TURN,
      model: 'claude-sonnet-5',
      body: 'Append a new migration — a shipped one is never edited.',
      inputTokens: 1200,
      outputTokens: 300,
      citedArticleIds: [],
      outcome: 'drafted',
    });

    const after = await inputLine();
    expect(after.qty).toBe('1200');
    expect(after.entryCount).toBe(1);
  });

  it('the cost is priced from the desk’s own rate card', async () => {
    const admin = await at(world.substrat, 'admin');
    const usage = (await admin.invoke('ticket0/usage-summary', {
      conversationId: story.conversation,
    })) as { currency: string; total: string; lines: { meterKey: string; amount: string }[] };
    // 1200 x 0.000003 = 0.0036 ; 300 x 0.000015 = 0.0045 ; total 0.0081
    expect(usage.lines.find((l) => l.meterKey === 'ai.tokens.input')!.amount).toBe('0.0036');
    expect(usage.lines.find((l) => l.meterKey === 'ai.tokens.output')!.amount).toBe('0.0045');
    expect(usage.total).toBe('0.0081');
    expect(usage.currency).toBe('EUR');
  });

  it('an agent works the whole inbox and cannot see any of it', async () => {
    const agent = await at(world.substrat, 'agent');
    await expect(agent.invoke('ticket0/usage-summary', {})).rejects.toThrow(/permission denied/i);
    await expect(
      agent.invoke('ticket0/set-usage-rate', {
        meterKey: 'ai.tokens.input',
        unitPrice: '0',
        currency: 'EUR',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('...while the doors the agent DOES hold stay open', async () => {
    // Without this control the refusals above would pass just as happily if the
    // agent were a broken principal or the module were never registered.
    const agent = await at(world.substrat, 'agent');
    const page = (await agent.invoke('ticket0/list-conversations', {})) as CountedPage<Conversation>;
    expect(page.total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('the assistant’s authority is a grant, not a setting', () => {
  it('Substrat’s desk lets its assistant answer the customer', async () => {
    const assistant = await at(world.substrat, 'assistant');
    const reply = (await assistant.invoke('ticket0/post-public-reply', {
      conversationId: story.conversation,
      body: 'Append a new migration — a shipped one is never edited.',
    })) as Message;
    expect(reply.visibility).toBe('public');
    expect(reply.author_kind).toBe('assistant');
    story.assistantReply = reply.id;
  });

  /**
   * The same operation, the same code, the same assistant. One key fewer.
   *
   * This pair is the demonstration: nothing in the module branches on a desk
   * setting, so the difference can only be the grant.
   */
  it('Kestrel’s desk refuses the identical call', async () => {
    const omar = await at(world.kestrel, 'agent');
    const page = (await omar.invoke('ticket0/list-conversations', {})) as CountedPage<Conversation>;
    // By subject, not by position: `entries[0]` is whatever sorted first on the day,
    // and three later tests hang off this id.
    story.kestrelConversation = page.entries.find((c) =>
      c.subject.includes('Rotating an API key'),
    )!.id;

    const assistant = await at(world.kestrel, 'assistant');
    await expect(
      assistant.invoke('ticket0/post-public-reply', {
        conversationId: story.kestrelConversation,
        body: 'Rotate the key; the old one stays valid for 24 hours.',
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('...and Kestrel’s assistant can still draft, so the refusal is about ONE key', async () => {
    const assistant = await at(world.kestrel, 'assistant');
    const turn = (await assistant.invoke('ticket0/record-answer', {
      conversationId: story.kestrelConversation,
      turnId: 'kestrel-turn-1',
      model: 'claude-sonnet-5',
      body: 'Rotate the key; the old one stays valid for 24 hours.',
      inputTokens: 400,
      outputTokens: 90,
      citedArticleIds: [],
      outcome: 'drafted',
    })) as { id: string };
    expect(turn.id).toBe('kestrel-turn-1');
  });

  it('a human at Kestrel sends it, and that is the only way it goes out', async () => {
    const omar = await at(world.kestrel, 'agent');
    const reply = (await omar.invoke('ticket0/post-public-reply', {
      conversationId: story.kestrelConversation,
      body: 'Rotate the key; the old one stays valid for 24 hours.',
    })) as Message;
    expect(reply.author_kind).toBe('agent');
  });
});

// ---------------------------------------------------------------------------

describe('internal notes stay internal', () => {
  it('an agent leaves a note', async () => {
    const anna = await at(world.substrat, 'agent');
    const note = (await anna.invoke('ticket0/post-note', {
      conversationId: story.conversation,
      body: 'Priya is on the enterprise plan — escalate if this drags.',
    })) as Message;
    expect(note.visibility).toBe('internal');
    story.note = note.id;
  });

  it('staff see it', async () => {
    const anna = await at(world.substrat, 'agent');
    const msgs = (await anna.invoke('ticket0/list-messages', {
      conversationId: story.conversation,
    })) as CountedPage<Message>;
    expect(msgs.entries.some((m) => m.body_text.includes('enterprise plan'))).toBe(true);
  });

  it('the customer’s own thread does not contain it', async () => {
    const priya = await at(world.substrat, 'customer');
    const thread = (await priya.invoke('ticket0/my-messages', {
      conversationId: story.conversation,
    })) as Page<Message>;
    expect(thread.entries.length).toBeGreaterThan(0);
    expect(thread.entries.every((m) => m.visibility === 'public')).toBe(true);
    expect(thread.entries.some((m) => m.body_text.includes('enterprise plan'))).toBe(false);
  });

  it('and the widget thread does not either', async () => {
    const widget = await at(world.substrat, 'widget');
    const thread = (await widget.invoke('ticket0/widget-thread', {
      sessionId: story.session,
      token: story.token,
    })) as Page<Message>;
    expect(thread.entries.every((m) => m.visibility === 'public')).toBe(true);
    // The author's principal is not in a customer-facing read at all.
    expect(thread.entries.every((m) => !('author_principal' in m))).toBe(true);
  });

  it('the relay refuses to send a note even when asked for it directly', async () => {
    const relay = await at(world.substrat, 'relay');
    await expect(
      relay.invoke('ticket0/read-outbound', { messageId: story.note }),
    ).rejects.toThrow(/internal notes are never sent/i);
  });

  it('...while a public reply IS readable by the relay, body and all', async () => {
    const relay = await at(world.substrat, 'relay');
    const outbound = (await relay.invoke('ticket0/read-outbound', {
      messageId: story.assistantReply,
    })) as {
      toEmail: string | null;
      fromAddress: string;
      agentName: string | null;
      bodyText: string | null;
    };
    expect(outbound.fromAddress).toBe('support@substrat.net');
    expect(outbound.toEmail).toBe(world.substrat.customer.email);
    // The name the design promised on outbound mail, from the table that owns it.
    expect(outbound.agentName).toBe('Assistant');
    expect(outbound.bodyText).toContain('Append a new migration');
  });
});

// ---------------------------------------------------------------------------

describe('the lifecycle, and the two things it will not do', () => {
  it('a conversation with no reply yet cannot be resolved', async () => {
    // A fresh one, so the reply already sent is not in the way.
    const relay = await at(world.substrat, 'relay');
    const fresh = (await relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: 'quiet@customer.example',
      contactName: 'Quiet',
      subject: 'A question nobody answered',
      bodyText: 'Anyone there?',
      emailMessageId: '<quiet-1@mail.example>',
    })) as Message;

    const anna = await at(world.substrat, 'agent');
    await expect(
      anna.invoke('ticket0/resolve', { conversationId: fresh.conversation_id }),
    ).rejects.toThrow(/reply before resolving/i);
  });

  it('a resolved conversation reopens when the customer writes again', async () => {
    const anna = await at(world.substrat, 'agent');
    const resolved = (await anna.invoke('ticket0/resolve', {
      conversationId: story.conversation,
    })) as Conversation;
    expect(resolved.state).toBe('resolved');

    const relay = await at(world.substrat, 'relay');
    await relay.invoke('ticket0/ingest-message', {
      conversationId: story.conversation,
      contactEmail: world.substrat.customer.email,
      subject: 'Re: Chat',
      bodyText: 'That worked, but one more thing.',
      emailMessageId: '<priya-2@mail.example>',
    });

    const after = (await anna.invoke('ticket0/get-conversation', {
      conversationId: story.conversation,
    })) as Conversation;
    // The edge that makes this a conversation and not a work order.
    expect(after.state).toBe('open');
  });

  /**
   * Priority was declared sortable and filterable from the start and no operation
   * ever set it, so every conversation was born `normal` and stayed there — the
   * inbox offered a filter that could only ever match everything (#1084).
   */
  it('priority is settable, and the inbox filter then finds it', async () => {
    const anna = await at(world.substrat, 'agent');
    const before = (await anna.invoke('ticket0/get-conversation', {
      conversationId: story.conversation,
    })) as Conversation;
    expect(before.priority).toBe('normal');

    const urgent = (await anna.invoke('ticket0/set-priority', {
      conversationId: story.conversation,
      priority: 'urgent',
    })) as Conversation;
    expect(urgent.priority).toBe('urgent');
    // Triage, not workflow: ranking the work does not move the conversation.
    expect(urgent.state).toBe(before.state);

    // Read back through the operation the inbox actually calls, not the row.
    const page = (await anna.invoke('ticket0/list-conversations', {
      priority: 'urgent',
    })) as CountedPage<Conversation>;
    expect(page.entries.map((c) => c.id)).toContain(story.conversation);

    // And back down again, so 'urgent' is not a one-way door.
    const calm = (await anna.invoke('ticket0/set-priority', {
      conversationId: story.conversation,
      priority: 'normal',
    })) as Conversation;
    expect(calm.priority).toBe('normal');
  });

  /**
   * Handing work to a colleague — the operation a desk uses every hour, which until
   * #1079 nothing but the seed could reach and which took any string at all.
   */
  it('a conversation is handed to a named colleague, and a stranger is refused', async () => {
    const anna = await at(world.substrat, 'agent');

    // The directory the picker reads. It is people, not principals: the ULID on a
    // conversation only becomes a name because these rows exist.
    const staff = (await anna.invoke('ticket0/list-agents', {})) as Page<{
      principal: string;
      display_name: string;
    }>;
    const markus = staff.entries.find(
      (a) => a.principal === world.substrat.admin.principal,
    );
    expect(markus?.display_name).toBe('Markus');

    const handed = (await anna.invoke('ticket0/assign', {
      conversationId: story.conversation,
      assignee: world.substrat.admin.principal,
    })) as Conversation;
    expect(handed.assignee).toBe(world.substrat.admin.principal);

    // The point of assigning: it lands in the other person's queue, and they are
    // told. Both are read back through the operations the app calls.
    const theirs = (await (
      await at(world.substrat, 'admin')
    ).invoke('ticket0/list-conversations', {
      assignee: world.substrat.admin.principal,
    })) as CountedPage<Conversation>;
    expect(theirs.entries.map((c) => c.id)).toContain(story.conversation);

    const told = (await (
      await at(world.substrat, 'admin')
    ).invoke('ticket0/my-notifications', {})) as Page<{ kind: string; conversation_id: string | null }>;
    expect(
      told.entries.some((n) => n.kind === 'assigned' && n.conversation_id === story.conversation),
    ).toBe(true);

    // A principal with no profile is not staff of this desk. Refused, not written:
    // a typo that sticks is a conversation nobody works and a notification nobody
    // receives.
    const stranger = principalId.parse(ulid());
    await expect(
      anna.invoke('ticket0/assign', {
        conversationId: story.conversation,
        assignee: stranger,
      }),
    ).rejects.toThrow(/not a member of this desk/);

    // The empty string is a string the schema accepts and nobody's principal. It is
    // the worst of the two failures — not null, so the row reads as assigned; not a
    // person, so nobody is told and nobody works it — so it is refused too.
    await expect(
      anna.invoke('ticket0/assign', { conversationId: story.conversation, assignee: '' }),
    ).rejects.toThrow(/not a member of this desk/);

    // And the refusal left the previous owner alone — it threw before the write.
    const unchanged = (await anna.invoke('ticket0/get-conversation', {
      conversationId: story.conversation,
    })) as Conversation;
    expect(unchanged.assignee).toBe(world.substrat.admin.principal);

    // Nobody is always legal: dropping a conversation needs no directory entry.
    const dropped = (await anna.invoke('ticket0/assign', {
      conversationId: story.conversation,
      assignee: null,
    })) as Conversation;
    expect(dropped.assignee).toBeNull();
  });

  it('a closed conversation is closed — the machine has no edge out', async () => {
    const anna = await at(world.substrat, 'agent');
    await anna.invoke('ticket0/post-public-reply', {
      conversationId: story.conversation,
      body: 'Of course — what else can we help with?',
    });
    await anna.invoke('ticket0/resolve', { conversationId: story.conversation });
    const closed = (await anna.invoke('ticket0/close', {
      conversationId: story.conversation,
    })) as Conversation;
    expect(closed.state).toBe('closed');

    // The refusal comes from the DECLARED machine, and says so — including which
    // states would have admitted it.
    await expect(
      anna.invoke('ticket0/assign', { conversationId: story.conversation, assignee: null }),
    ).rejects.toThrow(/invalid transition.*'closed'.*requires new \| open \| snoozed/i);

    // Priority is triage, so it is legal wherever the conversation is still alive —
    // and nowhere else. `closed` is terminal for it too.
    await expect(
      anna.invoke('ticket0/set-priority', {
        conversationId: story.conversation,
        priority: 'urgent',
      }),
    ).rejects.toThrow(/invalid transition.*'closed'/i);
  });
});

// ---------------------------------------------------------------------------

describe('the attacks', () => {
  it('a forged identity signature is refused before a contact exists', async () => {
    const widget = await at(world.substrat, 'widget');
    await expect(
      widget.invoke('ticket0/widget-start', {
        origin: world.substrat.origin,
        identity: { externalId: 'someone.else@customer.example', signature: 'f'.repeat(64) },
      }),
    ).rejects.toThrow(/signature does not verify/i);
  });

  it('...and Kestrel’s secret does not sign for Substrat’s desk', async () => {
    // The strongest form of the same check: a real, correctly-computed signature,
    // made with the wrong desk's key.
    const widget = await at(world.substrat, 'widget');
    const wrongKey = await signIdentity(
      world.kestrel.verificationSecret,
      'someone.else@customer.example',
    );
    await expect(
      widget.invoke('ticket0/widget-start', {
        origin: world.substrat.origin,
        identity: { externalId: 'someone.else@customer.example', signature: wrongKey },
      }),
    ).rejects.toThrow(/signature does not verify/i);
  });

  /**
   * Opening the bubble is not a conversation. Before this, every `widget-start` —
   * a curl, a crawler that ran the script, a person who clicked and left — put an
   * empty "Chat" from a blank contact in the inbox; the live desk collected three
   * for one real chat. The thread exists from the first message.
   */
  it('opening the widget creates nothing an agent can see, until something is said', async () => {
    const anna = await at(world.substrat, 'agent');
    const widget = await at(world.substrat, 'widget');
    const count = async () => {
      const conversations = (await anna.invoke('ticket0/list-conversations', {
        limit: 100,
      })) as CountedPage<Conversation>;
      const contacts = (await anna.invoke('ticket0/list-contacts', { limit: 100 })) as Page<{
        id: string;
      }>;
      return { conversations: conversations.total, contacts: contacts.entries.length };
    };

    const before = await count();
    const started = (await widget.invoke('ticket0/widget-start', {
      origin: world.substrat.origin,
    })) as { sessionId: string; token: string };
    expect(await count()).toEqual(before);

    // The visitor's own view is an empty thread, not a refusal: the widget polls this
    // before anything is said, and a 404 would make it throw the session away.
    const empty = (await widget.invoke('ticket0/widget-thread', {
      sessionId: started.sessionId,
      token: started.token,
    })) as Page<Message>;
    expect(empty.entries).toEqual([]);

    // The first message opens the conversation, and the anonymous contact with it.
    const msg = (await widget.invoke('ticket0/widget-post', {
      sessionId: started.sessionId,
      token: started.token,
      body: 'Is anyone there?',
    })) as Message;
    const after = await count();
    expect(after.conversations).toBe(before.conversations + 1);
    expect(after.contacts).toBe(before.contacts + 1);

    // And the same session — same id, same token — now reads the thread it opened.
    const thread = (await widget.invoke('ticket0/widget-thread', {
      sessionId: started.sessionId,
      token: started.token,
    })) as Page<Message>;
    expect(thread.entries.map((m) => m.id)).toEqual([msg.id]);
    expect(thread.entries[0]!.conversation_id).toBe(msg.conversation_id);
  });

  it('the widget refuses to open on an origin the desk does not embed on', async () => {
    const widget = await at(world.substrat, 'widget');
    await expect(
      widget.invoke('ticket0/widget-start', { origin: 'https://evil.example' }),
    ).rejects.toThrow(/not embedded on/i);
  });

  it('an origin saved as a page URL still admits the page it came from', async () => {
    // A desk admin pastes what the address bar shows. The browser sends only the
    // origin, and the check is a string compare - so the list must hold origins, or
    // the desk looks configured and refuses everyone (that is how the hosted desk
    // stood on substrat.net: 403 on every preflight).
    const admin = await at(world.substrat, 'admin');
    const widget = await at(world.substrat, 'widget');
    const before = [world.substrat.origin, ...world.substrat.devOrigins];

    const saved = (await admin.invoke('ticket0/configure-desk', {
      allowedOrigins: [...before, 'https://docs.example/guide/support?x=1', 'https://docs.example/'],
    })) as { allowed_origins: string };
    expect(JSON.parse(saved.allowed_origins)).toEqual([...before, 'https://docs.example']);

    const started = (await widget.invoke('ticket0/widget-start', {
      origin: 'https://docs.example',
    })) as { sessionId: string };
    expect(started.sessionId).toBeTruthy();

    // Not an origin at all - refused at the door, not stored as a string that can never match.
    await expect(
      admin.invoke('ticket0/configure-desk', { allowedOrigins: ['mailto:hi@docs.example'] }),
    ).rejects.toThrow(/not an http\(s\) origin/i);

    // Restore, so the tests after this one see the seeded desk.
    await admin.invoke('ticket0/configure-desk', { allowedOrigins: before });
  });

  it('a session token that does not match reaches nothing', async () => {
    const widget = await at(world.substrat, 'widget');
    await expect(
      widget.invoke('ticket0/widget-thread', {
        sessionId: story.session,
        token: 'not-the-token',
      }),
    ).rejects.toThrow(/token does not match/i);

    // The control: the real token still works, so the refusal is about the token.
    const thread = (await widget.invoke('ticket0/widget-thread', {
      sessionId: story.session,
      token: story.token,
    })) as Page<Message>;
    expect(Array.isArray(thread.entries)).toBe(true);
  });

  /**
   * The capability boundary, stated as an attack.
   *
   * Two sessions exist. Neither id opens the other's conversation, and the reason is
   * not a check on a conversation id — there IS no conversation id in the input. The
   * only way to name a conversation through the widget is to hold its token.
   */
  it('one session’s token does not open another session’s conversation', async () => {
    const widget = await at(world.substrat, 'widget');
    const other = await openSession(world.substrat, false);
    const said = (await widget.invoke('ticket0/widget-post', {
      sessionId: other.sessionId,
      token: other.token,
      body: 'A different visitor.',
    })) as Message;
    expect(said.conversation_id).not.toBe(story.conversation);

    await expect(
      widget.invoke('ticket0/widget-thread', {
        sessionId: other.sessionId,
        token: story.token,
      }),
    ).rejects.toThrow(/token does not match/i);
    await expect(
      widget.invoke('ticket0/widget-thread', {
        sessionId: story.session,
        token: other.token,
      }),
    ).rejects.toThrow(/token does not match/i);
  });

  /**
   * The widget principal sits on a public surface, so what it can reach is the thing
   * to be precise about. One key: it serves the widget, and it is not a skeleton key.
   */
  it('the widget service reaches no inbox, no contact list and no money', async () => {
    const widget = await at(world.substrat, 'widget');
    await expect(widget.invoke('ticket0/list-conversations', {})).rejects.toThrow(
      /permission denied/i,
    );
    await expect(widget.invoke('ticket0/list-contacts', {})).rejects.toThrow(
      /permission denied/i,
    );
    await expect(widget.invoke('ticket0/usage-summary', {})).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      widget.invoke('ticket0/list-messages', { conversationId: story.conversation }),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      widget.invoke('ticket0/post-public-reply', {
        conversationId: story.conversation,
        body: 'Not from here.',
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('a customer cannot read another customer’s conversation in the same desk', async () => {
    const relay = await at(world.substrat, 'relay');
    const other = (await relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: 'someone.else@customer.example',
      subject: 'A different customer entirely',
      bodyText: 'My export is failing.',
      emailMessageId: '<other-1@mail.example>',
    })) as Message;

    const priya = await at(world.substrat, 'customer');
    await expect(
      priya.invoke('ticket0/my-messages', { conversationId: other.conversation_id }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('...while her OWN conversations are still reachable, by a proof walk', async () => {
    const priya = await at(world.substrat, 'customer');
    const mine = (await priya.invoke('ticket0/my-conversations', {})) as Page<Conversation>;
    expect(mine.entries.length).toBeGreaterThan(0);
    // Every one of them is hers. Not filtered by a WHERE on contact_id — each row
    // was asked about individually, and the ones that said no are simply absent.
    expect(mine.entries.every((c) => c.contact_id === world.substrat.customerContactId)).toBe(true);
  });

  it('a customer cannot read the desk’s inbox, or its money', async () => {
    const priya = await at(world.substrat, 'customer');
    await expect(priya.invoke('ticket0/list-conversations', {})).rejects.toThrow(
      /permission denied/i,
    );
    await expect(priya.invoke('ticket0/usage-summary', {})).rejects.toThrow(/permission denied/i);
    await expect(priya.invoke('ticket0/list-contacts', {})).rejects.toThrow(/permission denied/i);
  });

  /**
   * The one a repointing fix created and a review caught.
   *
   * `merge` moves the loser's widget sessions onto the survivor, so merging across
   * contacts would hand one person's session token another person's thread — and
   * `widget-thread` would serve it, because the token IS the capability it checks.
   */
  it('a conversation cannot be merged into a different contact’s', async () => {
    // A fresh conversation of hers, so the loser is `new`: merge refuses a resolved
    // conversation on state before it ever compares contacts. It used to be the seed's
    // empty "Chat" that stood in here; opening the widget no longer opens anything.
    const widget = await at(world.substrat, 'widget');
    const hers = await openSession(world.substrat);
    const asked = (await widget.invoke('ticket0/widget-post', {
      sessionId: hers.sessionId,
      token: hers.token,
      body: 'One more question.',
    })) as Message;
    const anna = await at(world.substrat, 'agent');
    const page = (await anna.invoke('ticket0/list-conversations', {})) as CountedPage<Conversation>;
    const mine = page.entries.find((c) => c.id === asked.conversation_id)!;
    expect(mine.contact_id).toBe(world.substrat.customerContactId);
    const theirs = page.entries.find((c) => c.contact_id !== world.substrat.customerContactId)!;
    expect(theirs).toBeDefined();

    const admin = await at(world.substrat, 'admin');
    await expect(
      admin.invoke('ticket0/merge', {
        conversationId: mine.id,
        intoConversationId: theirs.id,
      }),
    ).rejects.toThrow(/different contacts/i);
  });

  it('no human role holds the relay’s key — not even the desk admin', async () => {
    const admin = await at(world.substrat, 'admin');
    await expect(
      admin.invoke('ticket0/ingest-message', {
        conversationId: null,
        contactEmail: 'spoof@customer.example',
        subject: 'Forged inbound',
        bodyText: 'Pretending to be a customer.',
        emailMessageId: '<spoof-1@mail.example>',
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  /**
   * Cross-desk, and worth being precise about what the guarantee is.
   *
   * Addressing another desk's scope RESOLVES — a stub is just a pair of coordinates
   * and a function. What Dana does not have is any standing inside it: she holds no
   * role there, so every operation refuses. The isolation is at the check, not at
   * the address, and asserting otherwise would be asserting something untrue.
   */
  it('Kestrel’s admin has no standing in Substrat’s desk', async () => {
    const trespass = await host.getScope(
      world.kestrel.admin.principal,
      world.substrat.tenant,
      world.substrat.scope,
    );
    await expect(trespass.invoke('ticket0/list-conversations', {})).rejects.toThrow(
      /permission denied/i,
    );
    await expect(trespass.invoke('ticket0/usage-summary', {})).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      trespass.invoke('ticket0/get-conversation', { conversationId: story.conversation }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('...and in her OWN desk she is a perfectly normal admin', async () => {
    // The control for the row above: Dana is not a broken principal.
    const dana = await at(world.kestrel, 'admin');
    const page = (await dana.invoke('ticket0/list-conversations', {})) as CountedPage<Conversation>;
    expect(page.total).toBeGreaterThan(0);
    const usage = (await dana.invoke('ticket0/usage-summary', {})) as { lines: unknown[] };
    expect(usage.lines.length).toBe(2);
  });

  it('and the two desks never see each other’s conversations', async () => {
    const dana = await at(world.kestrel, 'admin');
    const hers = (await dana.invoke('ticket0/list-conversations', {})) as CountedPage<Conversation>;
    const anna = await at(world.substrat, 'agent');
    const theirs = (await anna.invoke('ticket0/list-conversations', {})) as CountedPage<Conversation>;
    const kestrelIds = new Set(hers.entries.map((c) => c.id));
    for (const c of theirs.entries) expect(kestrelIds.has(c.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

/**
 * What an anonymous visitor actually costs — which is nothing.
 *
 * A stranger in a chat bubble gets no principal, no grant and no row anybody has to
 * reap later. They hold a session token, and the token reaches exactly one
 * conversation. These assertions are the reason this app needs no kernel-level
 * notion of an unauthenticated user.
 */
describe('a stranger in a chat bubble', () => {
  let session = '';
  let token = '';
  let conversation = '';

  it('opens the widget with no identity at all', async () => {
    const started = await openSession(world.substrat, false);
    expect(started.verified).toBe(false);
    session = started.sessionId;
    token = started.token;
  });

  it('asks a question, and reads the answer back', async () => {
    const widget = await at(world.substrat, 'widget');
    // The question is what opens the conversation — their own, not the story's.
    const asked = (await widget.invoke('ticket0/widget-post', {
      sessionId: session,
      token,
      body: 'Is there a free tier?',
    })) as Message;
    conversation = asked.conversation_id;
    expect(conversation).not.toBe(story.conversation);
    const anna = await at(world.substrat, 'agent');
    await anna.invoke('ticket0/post-public-reply', {
      conversationId: conversation,
      body: 'There is — up to three seats.',
    });

    const thread = (await widget.invoke('ticket0/widget-thread', {
      sessionId: session,
      token,
    })) as Page<Message>;
    expect(thread.entries.map((m) => m.body_text)).toContain('There is — up to three seats.');
  });

  it('...and none of it created a principal or a grant to clean up', async () => {
    // The contact this visitor got has no principal bound to it: there is no login
    // to hang one on, and the token is doing the work a grant would otherwise do.
    const anna = await at(world.substrat, 'agent');
    const conv = (await anna.invoke('ticket0/get-conversation', {
      conversationId: conversation,
    })) as Conversation;
    const contacts = (await anna.invoke('ticket0/list-contacts', {})) as Page<{
      id: string;
      principal: string | null;
      external_id: string | null;
    }>;
    const mine = contacts.entries.find((c) => c.id === conv.contact_id)!;
    expect(mine.principal).toBeNull();
    expect(mine.external_id).toBeNull();
  });

  /**
   * What the host knew about the browser rides in as INPUT, already normalised, is
   * held on the opening, and travels onto the session with the first message — so an
   * agent reads it back off the conversation. Never the token hash, which is the one
   * column that would turn a readable session into a usable one.
   */
  it('remembers what the visitor was holding, and where, when the host says', async () => {
    const widget = await at(world.substrat, 'widget');
    const anna = await at(world.substrat, 'agent');

    // This stranger's host said nothing: a node dev server, or a seed. Every client
    // column is null and the read still answers, rather than throwing on a gap.
    const bare = (await anna.invoke('ticket0/widget-session', {
      conversationId: conversation,
    })) as { session: Record<string, unknown> | null };
    expect(bare.session).toMatchObject({ conversation_id: conversation, browser: null, country: null });
    expect(bare.session).not.toHaveProperty('token_hash');

    const started = (await widget.invoke('ticket0/widget-start', {
      origin: world.substrat.origin,
      client: {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1',
        language: 'sv-SE',
        device: { browser: 'Safari', browserVersion: '17.5', os: 'iOS', osVersion: '17.5.1', kind: 'mobile' },
        geo: { country: 'SE', region: 'Stockholm County', city: 'Stockholm', timezone: 'Europe/Stockholm', continent: 'EU' },
      },
    })) as { sessionId: string; token: string };

    // Opening the widget opened nothing an agent can read. The first message binds
    // the opening to a conversation, and the client columns must come with it: the
    // request that carried them is long gone by then.
    const asked = (await widget.invoke('ticket0/widget-post', {
      sessionId: started.sessionId,
      token: started.token,
      body: 'Does this work on my phone?',
    })) as Message;

    const read = (await anna.invoke('ticket0/widget-session', {
      conversationId: asked.conversation_id,
    })) as { session: Record<string, unknown> | null };
    expect(read.session).toMatchObject({
      id: started.sessionId,
      browser: 'Safari',
      browser_version: '17.5',
      os: 'iOS',
      os_version: '17.5.1',
      device: 'mobile',
      language: 'sv-SE',
      country: 'SE',
      region: 'Stockholm County',
      city: 'Stockholm',
      timezone: 'Europe/Stockholm',
    });
    expect(read.session).not.toHaveProperty('token_hash');

    // The email side has no browser behind it, and says so with a null rather than a refusal.
    const relay = await at(world.substrat, 'relay');
    const mailed = (await relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: 'letter@customer.example',
      contactName: 'Letter',
      subject: 'By post',
      bodyText: 'No browser here.',
      emailMessageId: '<letter-1@mail.example>',
    })) as Message;
    expect(
      await anna.invoke('ticket0/widget-session', { conversationId: mailed.conversation_id }),
    ).toEqual({ session: null });
  });
});

// ---------------------------------------------------------------------------

/**
 * The other door. A signed-in customer is a real principal with a real grant, and
 * the kernel walk is what confines them — capabilities where there is no login,
 * principals where there is one.
 */
describe('a signed-in customer, by contrast', () => {
  it('a bare ULID holds nothing, including the widget’s own key', async () => {
    const stranger = principalId.parse(ulid());
    const stub = await host.getScope(stranger, world.substrat.tenant, world.substrat.scope);
    await expect(stub.invoke('ticket0/list-conversations', {})).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      stub.invoke('ticket0/widget-start', { origin: world.substrat.origin }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('...and ONE narrowed grant is the whole of a portal customer’s access', async () => {
    const stranger = principalId.parse(ulid());
    const desk = world.substrat;

    // No role assignment anywhere. One grant, on one contact.
    await host.admin.grant(world.staff, {
      principalId: stranger,
      permission: T0_PERM.conversationReadOwn,
      node: { tenantId: desk.tenant, scopeId: desk.scope },
      entity: { entityType: 'contact', entityId: desk.customerContactId },
      grantedBy: stranger,
    });

    const stub = await host.getScope(stranger, desk.tenant, desk.scope);
    const thread = (await stub.invoke('ticket0/my-messages', {
      conversationId: story.conversation,
    })) as Page<Message>;
    expect(Array.isArray(thread.entries)).toBe(true);

    // And it reaches that contact's conversations only.
    const relay = await at(desk, 'relay');
    const elsewhere = (await relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: 'elsewhere@customer.example',
      subject: 'Someone else again',
      bodyText: 'Unrelated.',
      emailMessageId: '<elsewhere-1@mail.example>',
    })) as Message;
    await expect(
      stub.invoke('ticket0/my-messages', { conversationId: elsewhere.conversation_id }),
    ).rejects.toThrow(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------

/**
 * Two facts the desk stored and could not read back (#1084).
 *
 * Tagging wrote a row nothing ever selected, so the rail said "None yet" whatever
 * the conversation carried and nothing could take a tag off again. A rating was
 * stored from the portal and no operation read it, which is not the same thing as
 * storing it — the person who handled the conversation could not see what the
 * customer thought of it.
 *
 * Written as one story on one fresh conversation so the reads are asserted against
 * writes made here, not against whatever the seed happened to leave behind.
 */
describe('what the desk wrote down and could not read back', () => {
  const desk = () => world.substrat;
  let conversation = '';

  it('a conversation arrives to hang the tags on', async () => {
    const relay = await at(desk(), 'relay');
    const m = (await relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: desk().customer.email,
      subject: 'The invoice does not match the plan',
      bodyText: 'We were billed twice this month.',
      emailMessageId: '<tags-1@mail.example>',
    })) as Message;
    conversation = m.conversation_id;
  });

  it('the tags an agent puts on are the tags the conversation reports', async () => {
    const anna = await at(desk(), 'agent');
    await anna.invoke('ticket0/tag-conversation', { conversationId: conversation, tag: 'billing' });
    await anna.invoke('ticket0/tag-conversation', { conversationId: conversation, tag: 'vip' });

    const { tags } = (await anna.invoke('ticket0/list-conversation-tags', {
      conversationId: conversation,
    })) as { tags: { conversation_id: string; tag: string; created_at: string }[] };
    // Sorted by tag, so a rail renders the same chips in the same order every load.
    expect(tags.map((t) => t.tag)).toEqual(['billing', 'vip']);
    expect(tags.every((t) => t.conversation_id === conversation)).toBe(true);
  });

  it('the desk’s vocabulary is whatever has been typed, most-used first', async () => {
    const anna = await at(desk(), 'agent');
    const { tags } = (await anna.invoke('ticket0/list-tags', {})) as {
      tags: { tag: string; count: number }[];
    };
    const billing = tags.find((t) => t.tag === 'billing');
    expect(billing).toBeDefined();
    expect(billing!.count).toBeGreaterThanOrEqual(1);
    expect(tags.find((t) => t.tag === 'vip')?.count).toBe(1);
    // Most-used first is the whole point of returning the count: autocomplete offers
    // the tag people mean before the one somebody mistyped once.
    const counts = tags.map((t) => t.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('a tag comes off again, and taking it off twice is not an error', async () => {
    const anna = await at(desk(), 'agent');
    const gone = (await anna.invoke('ticket0/untag-conversation', {
      conversationId: conversation,
      tag: 'vip',
    })) as { removed: boolean };
    expect(gone.removed).toBe(true);

    const { tags } = (await anna.invoke('ticket0/list-conversation-tags', {
      conversationId: conversation,
    })) as { tags: { tag: string }[] };
    expect(tags.map((t) => t.tag)).toEqual(['billing']);

    // Idempotent, and it says which it was: removing nothing is a no-op that
    // answers, not a 404 every caller would have to catch.
    const again = (await anna.invoke('ticket0/untag-conversation', {
      conversationId: conversation,
      tag: 'vip',
    })) as { removed: boolean };
    expect(again.removed).toBe(false);
  });

  it('an unrated conversation reads as unrated rather than throwing', async () => {
    const anna = await at(desk(), 'agent');
    const { csat } = (await anna.invoke('ticket0/get-csat', {
      conversationId: conversation,
    })) as { csat: unknown };
    expect(csat).toBeNull();
  });

  it('and the rating the customer leaves reaches the agent who handled it', async () => {
    const anna = await at(desk(), 'agent');
    // A conversation may not be resolved before a public reply has been sent.
    await anna.invoke('ticket0/post-public-reply', {
      conversationId: conversation,
      body: 'Refunded — the duplicate charge was ours.',
    });
    await anna.invoke('ticket0/resolve', { conversationId: conversation });

    const priya = await at(desk(), 'customer');
    await priya.invoke('ticket0/submit-csat', {
      conversationId: conversation,
      score: 5,
      comment: 'Sorted in an hour.',
    });

    const { csat } = (await anna.invoke('ticket0/get-csat', { conversationId: conversation })) as {
      csat: { conversation_id: string; score: number; comment: string | null } | null;
    };
    expect(csat).not.toBeNull();
    expect(csat!.conversation_id).toBe(conversation);
    expect(csat!.score).toBe(5);
    expect(csat!.comment).toBe('Sorted in an hour.');
  });

  it('a customer cannot read the staff side of any of it', async () => {
    const priya = await at(desk(), 'customer');
    // `conversation:read-own` reaches her thread and nothing else — the tag list and
    // the rating read are `conversation:read`, which she does not hold at all.
    await expect(
      priya.invoke('ticket0/list-conversation-tags', { conversationId: conversation }),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      priya.invoke('ticket0/get-csat', { conversationId: conversation }),
    ).rejects.toThrow(/permission denied/i);
    await expect(priya.invoke('ticket0/list-tags', {})).rejects.toThrow(/permission denied/i);
    await expect(
      priya.invoke('ticket0/untag-conversation', { conversationId: conversation, tag: 'billing' }),
    ).rejects.toThrow(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------

/**
 * Every mutation announces itself, and the announcement is checked here.
 *
 * Not because anything in this demo consumes these events — nothing does — but
 * because an emit is the one thing a handler can quietly stop doing without a
 * single assertion going red. Four of these five operations had no test at all
 * until they started emitting; the fifth is the widget, and what matters about
 * its event is what is NOT in it.
 */
describe('the audit spine', () => {
  const outbox = (desk: Desk, type: string) => {
    const db = new Database(join(dir, `${desk.tenant}__${desk.scope}.sqlite`), { readonly: true });
    const row = db
      .prepare('SELECT * FROM _substrat_outbox WHERE type = ? ORDER BY id DESC LIMIT 1')
      .get(type) as
      | { entity_type: string; entity_id: string; pii_class: string; payload: string | null }
      | undefined;
    db.close();
    return row;
  };

  it('a profile announces the principal and never the person’s name', async () => {
    const anna = await at(world.substrat, 'agent');
    await anna.invoke('ticket0/set-agent-profile', {
      displayName: 'Anna Lindqvist',
      avatarUrl: null,
      signature: 'Anna\nSubstrat Support',
    });
    const evt = outbox(world.substrat, 'ticket0.agent-profile-set')!;
    expect(evt).toBeDefined();
    expect(evt.entity_type).toBe('agentProfile');
    const payload = JSON.parse(evt.payload!) as Record<string, unknown>;
    // The name, the avatar and the signature are all erasable, and an event is the
    // one place in a scope an erasure cannot reach — so none of them is here, ever.
    expect(payload).toEqual({ principal: evt.entity_id, created_at: expect.any(String) });
    expect(JSON.stringify(payload)).not.toContain('Anna');
  });

  it('a tag announces the conversation, because a tag cannot be pointed at', async () => {
    const anna = await at(world.substrat, 'agent');
    const page = (await anna.invoke('ticket0/list-conversations', {})) as CountedPage<Conversation>;
    const target = page.entries[0]!;
    await anna.invoke('ticket0/tag-conversation', { conversationId: target.id, tag: 'billing' });

    const evt = outbox(world.substrat, 'ticket0.conversation-tagged')!;
    expect(evt).toBeDefined();
    expect(evt.entity_type).toBe('conversation');
    expect(evt.entity_id).toBe(target.id);
    expect(JSON.parse(evt.payload!)).toEqual({
      conversation_id: target.id,
      tag: 'billing',
      created_at: expect.any(String),
    });
  });

  it('and taking it off announces the same conversation, once', async () => {
    const anna = await at(world.substrat, 'agent');
    const page = (await anna.invoke('ticket0/list-conversations', {})) as CountedPage<Conversation>;
    const target = page.entries[0]!;
    await anna.invoke('ticket0/tag-conversation', { conversationId: target.id, tag: 'refund' });
    await anna.invoke('ticket0/untag-conversation', { conversationId: target.id, tag: 'refund' });

    const evt = outbox(world.substrat, 'ticket0.conversation-untagged')!;
    expect(evt).toBeDefined();
    expect(evt.entity_type).toBe('conversation');
    expect(evt.entity_id).toBe(target.id);
    // No `created_at`: the row is gone, and an event about a removal that carried
    // the removed row's timestamp would be describing something that no longer is.
    expect(JSON.parse(evt.payload!)).toEqual({ conversation_id: target.id, tag: 'refund' });

    // Removing what is not there is not a removal, so it announces nothing. The
    // outbox still shows the one above rather than a second, later row.
    const before = evt;
    await anna.invoke('ticket0/untag-conversation', { conversationId: target.id, tag: 'refund' });
    expect(outbox(world.substrat, 'ticket0.conversation-untagged')).toEqual(before);
  });

  it('a saved reply announces itself', async () => {
    const anna = await at(world.substrat, 'agent');
    const reply = (await anna.invoke('ticket0/create-saved-reply', {
      title: 'Refund policy',
      body: 'We refund within 30 days.',
    })) as { id: string; created_by: string; created_at: string };
    const evt = outbox(world.substrat, 'ticket0.saved-reply-created')!;
    expect(evt).toBeDefined();
    expect(evt.entity_id).toBe(reply.id);
    // The whole row: a consumer must never need to come back and read it.
    expect(JSON.parse(evt.payload!)).toEqual({
      id: reply.id,
      title: 'Refund policy',
      body: 'We refund within 30 days.',
      created_by: reply.created_by,
      created_at: reply.created_at,
    });
  });

  /**
   * The substitution, end to end, from the concept's promise that a canned answer
   * can say the customer's name and sign itself with the agent's.
   *
   * Every expected value is stated here rather than read back out of the row it
   * came from: an assertion that re-derives its own expectation from the same read
   * the code did agrees with a broken renderer perfectly.
   */
  it('a saved reply fills in the conversation, the contact and the caller — and leaves the rest alone', async () => {
    const anna = await at(world.substrat, 'agent');
    // Stated here rather than inherited from whichever block ran before: the
    // rendered name and signature ARE the assertion, so a test that took them from
    // the current row would pass against a renderer that substituted nothing.
    await anna.invoke('ticket0/set-agent-profile', {
      displayName: 'Anna Lindqvist',
      avatarUrl: null,
      signature: 'Anna\nSubstrat Support',
    });
    const reply = (await anna.invoke('ticket0/create-saved-reply', {
      title: 'Signed greeting',
      body:
        'Hi {{contact.name}}, about "{{ conversation.subject }}" — {{agent.name}} here.\n' +
        'Nothing to do with us: {{ some.other.thing }} and { not a token }.\n' +
        '{{agent.signature}}',
    })) as { id: string };
    const conv = (await anna.invoke('ticket0/get-conversation', {
      conversationId: story.conversation,
    })) as Conversation;

    const rendered = (await anna.invoke('ticket0/render-saved-reply', {
      conversationId: story.conversation,
      savedReplyId: reply.id,
    })) as { id: string; title: string; body: string; blank: string[]; unresolved: string[] };

    expect(rendered.id).toBe(reply.id);
    expect(rendered.title).toBe('Signed greeting');
    expect(rendered.body).toBe(
      `Hi Priya, about "${conv.subject}" — Anna Lindqvist here.\n` +
        'Nothing to do with us: {{ some.other.thing }} and { not a token }.\n' +
        'Anna\nSubstrat Support',
    );
    // Nothing was empty, and the one token nobody declares came through verbatim
    // rather than being deleted — a canned answer about braces stays readable.
    expect(rendered.blank).toEqual([]);
    expect(rendered.unresolved).toEqual(['some.other.thing']);

    // A read: it wrote nothing, so it announced nothing. Rendering a reply is not
    // using one, and a usage counter that ticked here would be counting previews.
    expect(outbox(world.substrat, 'ticket0.saved-reply-rendered')).toBeUndefined();
  });

  /**
   * The assistant has a profile with no signature, so the same reply rendered as
   * them says so instead of pretending. `blank` is what lets the composer warn
   * before "Hi ," reaches a customer.
   */
  it('a variable with nothing behind it renders empty and says which one', async () => {
    const anna = await at(world.substrat, 'agent');
    const assistant = await at(world.substrat, 'assistant');
    const reply = (await anna.invoke('ticket0/create-saved-reply', {
      title: 'Sign-off only',
      body: 'Thanks!\n{{agent.signature}}',
    })) as { id: string };

    const rendered = (await assistant.invoke('ticket0/render-saved-reply', {
      conversationId: story.conversation,
      savedReplyId: reply.id,
    })) as { body: string; blank: string[]; unresolved: string[] };

    expect(rendered.body).toBe('Thanks!\n');
    expect(rendered.blank).toEqual(['agent.signature']);
    expect(rendered.unresolved).toEqual([]);
  });

  it('editing a saved reply announces the whole new row, and changing nothing announces nothing', async () => {
    const anna = await at(world.substrat, 'agent');
    const reply = (await anna.invoke('ticket0/create-saved-reply', {
      title: 'Shipping times',
      body: 'Two to four days.',
    })) as { id: string; created_by: string; created_at: string };

    const updated = (await anna.invoke('ticket0/update-saved-reply', {
      savedReplyId: reply.id,
      body: 'Three to five days.',
    })) as { id: string; title: string; body: string };
    // A PATCH: the title was not sent, so the title did not move.
    expect(updated.title).toBe('Shipping times');
    expect(updated.body).toBe('Three to five days.');

    const evt = outbox(world.substrat, 'ticket0.saved-reply-updated')!;
    expect(evt).toBeDefined();
    expect(evt.entity_id).toBe(reply.id);
    expect(JSON.parse(evt.payload!)).toEqual({
      id: reply.id,
      title: 'Shipping times',
      body: 'Three to five days.',
      created_by: reply.created_by,
      created_at: reply.created_at,
    });

    // Saving the same values again is not an edit, so the outbox still shows the
    // one above rather than a second, later row.
    await anna.invoke('ticket0/update-saved-reply', {
      savedReplyId: reply.id,
      title: 'Shipping times',
      body: 'Three to five days.',
    });
    expect(outbox(world.substrat, 'ticket0.saved-reply-updated')).toEqual(evt);
  });

  it('a rename onto a title somebody else holds is refused', async () => {
    const anna = await at(world.substrat, 'agent');
    await anna.invoke('ticket0/create-saved-reply', { title: 'Taken', body: 'Mine.' });
    const other = (await anna.invoke('ticket0/create-saved-reply', {
      title: 'Not taken',
      body: 'Also mine.',
    })) as { id: string };

    await expect(
      anna.invoke('ticket0/update-saved-reply', { savedReplyId: other.id, title: 'Taken' }),
    ).rejects.toThrow(/already called/);
  });

  it('deleting one announces it, takes it out of the library, and is not repeatable', async () => {
    const anna = await at(world.substrat, 'agent');
    const reply = (await anna.invoke('ticket0/create-saved-reply', {
      title: 'Out of date',
      body: 'Nobody says this any more.',
    })) as { id: string };

    const gone = (await anna.invoke('ticket0/delete-saved-reply', {
      savedReplyId: reply.id,
    })) as { id: string; title: string };
    expect(gone).toEqual({ id: reply.id, title: 'Out of date' });

    const evt = outbox(world.substrat, 'ticket0.saved-reply-deleted')!;
    expect(evt).toBeDefined();
    expect(evt.entity_id).toBe(reply.id);
    // The title rides, because after this there is nowhere left to read it from.
    expect(JSON.parse(evt.payload!)).toEqual({ id: reply.id, title: 'Out of date' });

    const page = (await anna.invoke('ticket0/list-saved-replies', {})) as Page<{ id: string }>;
    expect(page.entries.map((r) => r.id)).not.toContain(reply.id);

    // A ULID that names nothing is a stale client, not a second deletion — the
    // opposite call from `untag-conversation`, whose identifier is typed by hand.
    await expect(
      anna.invoke('ticket0/delete-saved-reply', { savedReplyId: reply.id }),
    ).rejects.toThrow(/not found/);
  });

  it('a read notification announces itself', async () => {
    const anna = await at(world.substrat, 'agent');
    const mine = (await anna.invoke('ticket0/my-notifications', {})) as Page<{
      id: string;
      principal: string;
      kind: string;
      conversation_id: string | null;
      created_at: string;
    }>;
    // The agent was assigned a conversation in the story above, so there is one.
    expect(mine.entries.length).toBeGreaterThan(0);
    const note = mine.entries[0]!;
    await anna.invoke('ticket0/mark-notification-read', { notificationId: note.id });

    const evt = outbox(world.substrat, 'ticket0.notification-read')!;
    expect(evt).toBeDefined();
    expect(evt.entity_id).toBe(note.id);
    // The whole notification, read: everything a consumer could want is on it.
    expect(JSON.parse(evt.payload!)).toEqual({
      id: note.id,
      principal: note.principal,
      kind: note.kind,
      conversation_id: note.conversation_id,
      created_at: note.created_at,
      read_at: expect.any(String),
    });
  });

  it('a widget session announces itself and never the token', async () => {
    const widget = await at(world.substrat, 'widget');
    const started = (await widget.invoke('ticket0/widget-start', {
      origin: world.substrat.origin,
    })) as { sessionId: string; token: string; startedAt: string };

    const evt = outbox(world.substrat, 'ticket0.widget-session-started')!;
    expect(evt).toBeDefined();
    // About the opening, not a conversation: there is none until something is said.
    expect(evt.entity_type).toBe('widgetOpening');
    expect(evt.entity_id).toBe(started.sessionId);
    const payload = JSON.parse(evt.payload!) as Record<string, unknown>;
    // The token is the visitor's whole authority over this thread. An immutable
    // copy of a capability cannot be revoked, so it is not in the event.
    expect(payload.token).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(started.token);
    // And everything else about the session is — exactly this, and no more.
    expect(payload).toEqual({
      sessionId: started.sessionId,
      verified: false,
      origin: world.substrat.origin,
      startedAt: started.startedAt,
    });
  });
});

describe('closing the month', () => {
  it('freezes the window into immutable lines', async () => {
    const admin = await at(world.substrat, 'admin');
    const closed = (await admin.invoke('ticket0/close-usage-period', {
      from: '2026-08-01T00:00:00.000Z',
      to: '2099-01-01T00:00:00.000Z',
    })) as { periodId: string; lines: number };
    expect(closed.lines).toBe(2);
  });

  it('and nothing may land behind the horizon afterwards', async () => {
    const assistant = await at(world.substrat, 'assistant');
    const anna = await at(world.substrat, 'agent');
    const page = (await anna.invoke('ticket0/list-conversations', {})) as CountedPage<Conversation>;
    const open = page.entries.find((c) => c.state !== 'closed')!;
    await expect(
      assistant.invoke('ticket0/record-answer', {
        conversationId: open.id,
        turnId: 'late-turn',
        model: 'claude-sonnet-5',
        body: 'Too late.',
        inputTokens: 10,
        outputTokens: 10,
        citedArticleIds: [],
        outcome: 'drafted',
      }),
    ).rejects.toThrow(/horizon/i);
  });
});
