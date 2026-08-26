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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { principalId, type CountedPage, type Page } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
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
  state: string;
  contact_id: string;
  first_public_reply_at: string | null;
  assignee: string | null;
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
  })) as { sessionId: string; token: string; conversationId: string; verified: boolean };
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
    story.conversation = started.conversationId;
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
    expect(msg.conversation_id).toBe(story.conversation);
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
    })) as { id: string; input_tokens: number; message_id: string };
    expect(turn.id).toBe(TURN);
    expect(turn.input_tokens).toBe(1200);
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
    story.kestrelConversation = page.entries[0]!.id;

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

  it('the widget refuses to open on an origin the desk does not embed on', async () => {
    const widget = await at(world.substrat, 'widget');
    await expect(
      widget.invoke('ticket0/widget-start', { origin: 'https://evil.example' }),
    ).rejects.toThrow(/not embedded on/i);
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
    expect(other.conversationId).not.toBe(story.conversation);

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

  it('opens a conversation with no identity at all', async () => {
    const started = await openSession(world.substrat, false);
    expect(started.verified).toBe(false);
    session = started.sessionId;
    token = started.token;
    conversation = started.conversationId;
    expect(conversation).not.toBe(story.conversation);
  });

  it('asks a question, and reads the answer back', async () => {
    const widget = await at(world.substrat, 'widget');
    await widget.invoke('ticket0/widget-post', {
      sessionId: session,
      token,
      body: 'Is there a free tier?',
    });
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
      permission: 'conversation:read-own' as never,
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
