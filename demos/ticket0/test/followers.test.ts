/**
 * A colleague put on ONE conversation, and shut out of every other (#1086).
 *
 * The whole feature is `ctx.grant(principal, 'conversation:read', conversationRef(id))`
 * and its revoke, so the only thing worth testing is whether that grant is genuinely
 * what decides the answer. That is harder to prove here than it sounds: every staff
 * role in this desk holds `conversation:read` scope-wide, so a suite that followed an
 * agent in would pass identically with the `ctx.grant` line deleted — which is exactly
 * the shape of test that proves nothing.
 *
 * So the follower is built narrow on purpose. `Rae` is a bare principal holding ONE
 * key, `conversation:draft`, and holding it for one reason: the desk's directory is
 * `ticket0_agent_profiles`, a row you get by writing your own profile, and
 * `follow-conversation` refuses anybody who is not in it (the rule `assign` has taken
 * since #1079). No role, no `conversation:read` anywhere — so every read Rae gets
 * below, the grant gave.
 *
 * Time is a `manualClock` and moves once, for one assertion: a grant does not lapse.
 * Nothing sleeps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionKey, principalId, type PrincipalId } from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import { ASSISTANT_NAME } from '../src/module.js';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let clock: ManualClock;

/** The colleague. No role — see the header. */
const rae = principalId.parse(ulid());
/** Somebody with an account nowhere near this desk, for the directory refusal. */
const stranger = principalId.parse(ulid());

let admin: ScopeStub;
let raeStub: ScopeStub;
/** The thread Rae is put on, and one she is not. */
let followed: string;
let other: string;
let arrivals = 0;

/** A conversation, made the way one really arrives: through the relay. */
async function arrive(subject: string): Promise<string> {
  arrivals += 1;
  const relay = await host.getScope(
    world.substrat.relay.principal,
    world.substrat.tenant,
    world.substrat.scope,
  );
  const m = await relay.invoke<{ conversation_id: string }>('ticket0/ingest-message', {
    conversationId: null,
    contactEmail: 'followers@example.test',
    subject,
    bodyText: 'Something a colleague will want to see.',
    emailMessageId: `<followers-${arrivals}@mail.example>`,
  });
  return m.conversation_id;
}

/** The platform actor's verb, used only to set the suite up — never by the vertical. */
async function adminGrant(principal: PrincipalId, permission: string): Promise<void> {
  await host.admin.grant(world.staff, {
    principalId: principal,
    permission: permissionKey.parse(permission),
    node: { tenantId: world.substrat.tenant, scopeId: world.substrat.scope },
    grantedBy: world.substrat.admin.principal,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-followers-'));
  clock = manualClock('2026-03-02T09:00:00.000Z');
  host = buildHost(dir, clock.read);
  world = await seed(host);

  admin = await host.getScope(
    world.substrat.admin.principal,
    world.substrat.tenant,
    world.substrat.scope,
  );
  raeStub = await host.getScope(rae, world.substrat.tenant, world.substrat.scope);

  // The one key Rae gets from the suite, and only so she can write the profile that
  // puts her in the directory. `set-agent-profile` writes the CALLER's principal and
  // takes none from the input, so this is the only way into the directory there is.
  await adminGrant(rae, 'conversation:draft');
  await raeStub.invoke('ticket0/set-agent-profile', {
    displayName: 'Rae Okonjo',
    avatarUrl: null,
    signature: null,
  });

  followed = await arrive('The thread Rae is brought onto');
  other = await arrive('The thread she is not');
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('following a conversation', () => {
  /**
   * The claim, in three steps, in one case — because it is one claim: the grant is
   * what decides, and nothing else in the desk changed between the refusal and the
   * read. Split across three `it`s the middle step would still pass on its own with
   * a handler that let everybody in.
   *
   * Deliberately BOTH narrowed reads. They are separate handlers with separate SQL,
   * and `get-conversation` passing says nothing about `list-messages` — the thread
   * body is the thing a follower is actually being shown.
   */
  it('is the only thing that opens the thread, and closing it shuts it again', async () => {
    await expect(raeStub.invoke('ticket0/get-conversation', { conversationId: followed })).rejects.toThrow(
      /permission denied/i,
    );
    await expect(raeStub.invoke('ticket0/list-messages', { conversationId: followed })).rejects.toThrow(
      /permission denied/i,
    );

    await admin.invoke('ticket0/follow-conversation', {
      conversationId: followed,
      follower: rae,
    });

    const conversation = await raeStub.invoke<{ id: string; subject: string }>(
      'ticket0/get-conversation',
      { conversationId: followed },
    );
    expect(conversation.id).toBe(followed);
    expect(conversation.subject).toBe('The thread Rae is brought onto');
    const messages = await raeStub.invoke<{ entries: unknown[] }>('ticket0/list-messages', {
      conversationId: followed,
    });
    expect(messages.entries.length).toBeGreaterThan(0);

    await admin.invoke('ticket0/unfollow-conversation', {
      conversationId: followed,
      follower: rae,
    });

    await expect(raeStub.invoke('ticket0/get-conversation', { conversationId: followed })).rejects.toThrow(
      /permission denied/i,
    );
    await expect(raeStub.invoke('ticket0/list-messages', { conversationId: followed })).rejects.toThrow(
      /permission denied/i,
    );
  });

  /**
   * ONE conversation, which is the unit the issue asks for and the unit a role cannot
   * express. A follower who could read the desk by being put on one thread would be
   * the bug this feature exists to avoid, and it would be invisible — every screen
   * would look right.
   */
  it('opens that conversation and no other', async () => {
    await admin.invoke('ticket0/follow-conversation', {
      conversationId: followed,
      follower: rae,
    });
    await expect(
      raeStub.invoke('ticket0/get-conversation', { conversationId: followed }),
    ).resolves.toMatchObject({ id: followed });
    await expect(raeStub.invoke('ticket0/get-conversation', { conversationId: other })).rejects.toThrow(
      /permission denied/i,
    );
    // And the inbox stays shut, which is the cost this slice does not pay: the list is
    // gated on scope-wide `conversation:read`, and a narrowed grant does not widen. A
    // follower opens the thread by link and sees it in no list. See #1086.
    await expect(raeStub.invoke('ticket0/list-conversations', {})).rejects.toThrow(
      /permission denied/i,
    );
  });

  /**
   * A grant carries no expiry, so the one the case above made is still there a year
   * later — and it has to be the one above, which is why this does not re-follow
   * first. Access that quietly lapsed would read as the colleague being removed by
   * somebody, and nothing would say otherwise.
   *
   * The clock stays advanced for the cases after this. Nothing below is a function of
   * elapsed time, so that costs nothing.
   */
  it('does not lapse with time', async () => {
    clock.advance(365 * 86_400_000);
    await expect(
      raeStub.invoke('ticket0/get-conversation', { conversationId: followed }),
    ).resolves.toMatchObject({ id: followed });
  });

  /**
   * A grant either exists on that conversation or it does not — it is not a count —
   * so saying either verb twice has to mean the same as saying it once. The second
   * call is not an error and does not undo the first.
   */
  it('says the same thing twice', async () => {
    await admin.invoke('ticket0/follow-conversation', { conversationId: followed, follower: rae });
    await expect(
      raeStub.invoke('ticket0/get-conversation', { conversationId: followed }),
    ).resolves.toMatchObject({ id: followed });

    const off = await admin.invoke<{ following: boolean }>('ticket0/unfollow-conversation', {
      conversationId: followed,
      follower: rae,
    });
    expect(off.following).toBe(false);
    // Again, on somebody who is already not following. It answers where they stand
    // rather than raising a `not_found` every caller would have to catch.
    const again = await admin.invoke<{ following: boolean }>('ticket0/unfollow-conversation', {
      conversationId: followed,
      follower: rae,
    });
    expect(again.following).toBe(false);
    await expect(raeStub.invoke('ticket0/get-conversation', { conversationId: followed })).rejects.toThrow(
      /permission denied/i,
    );
  });

  /**
   * The directory rule, on both verbs.
   *
   * A stranger's ULID is the failure that matters: a grant leaves no row anybody
   * lists, so a typo here would mint durable access for a principal nobody at the desk
   * can name, and nothing would ever show it. Refused BEFORE the grant is written.
   */
  it('refuses a principal the desk cannot name', async () => {
    await expect(
      admin.invoke('ticket0/follow-conversation', { conversationId: followed, follower: stranger }),
    ).rejects.toThrow(/not a member of this desk/);
    const strangerStub = await host.getScope(
      stranger,
      world.substrat.tenant,
      world.substrat.scope,
    );
    await expect(
      strangerStub.invoke('ticket0/get-conversation', { conversationId: followed }),
    ).rejects.toThrow(/permission denied/i);
    // Unfollowing them is NOT refused, and that is the asymmetry on purpose: taking
    // away what was never given is a no-op, and the answer is where they stand.
    await expect(
      admin.invoke('ticket0/unfollow-conversation', {
        conversationId: followed,
        follower: stranger,
      }),
    ).resolves.toMatchObject({ following: false });
    // A string that is not a principal at all is still a refusal a caller can read,
    // rather than the Zod error a bare `.parse` would have raised.
    await expect(
      admin.invoke('ticket0/unfollow-conversation', {
        conversationId: followed,
        follower: 'not-a-ulid',
      }),
    ).rejects.toThrow(/not a principal id/);
  });

  /**
   * Revocation must not depend on anything its SUBJECT controls.
   *
   * `display_name` is set by the principal it belongs to, through
   * `ticket0/set-agent-profile`, and no name is reserved. So a follower can call
   * themselves whatever the follow rule refuses — and if `unfollow` applied that same
   * rule, they would have made their own grant permanent by renaming themselves. A
   * refusal to ADD withholds access; a refusal to REMOVE leaves it standing.
   *
   * Reported by CodeRabbit on PR #1563, against a first cut that ran the follow
   * eligibility test on the way out too.
   */
  it('takes away a follower who renamed themselves past the rule that let them in', async () => {
    await admin.invoke('ticket0/follow-conversation', { conversationId: followed, follower: rae });
    await expect(
      raeStub.invoke('ticket0/get-conversation', { conversationId: followed }),
    ).resolves.toMatchObject({ id: followed });

    // Rae calls herself what `follow-conversation` refuses. Nothing stops her: the
    // profile is hers, and this is the whole reason the directory is a weak test.
    await raeStub.invoke('ticket0/set-agent-profile', {
      displayName: ASSISTANT_NAME,
      avatarUrl: null,
      signature: null,
    });
    // Following her again is now refused — which is fine, that direction is safe.
    await expect(
      admin.invoke('ticket0/follow-conversation', { conversationId: followed, follower: rae }),
    ).rejects.toThrow(/assistant cannot follow a conversation/);
    // Removing her is NOT, and the access is actually gone.
    await expect(
      admin.invoke('ticket0/unfollow-conversation', { conversationId: followed, follower: rae }),
    ).resolves.toMatchObject({ following: false });
    await expect(raeStub.invoke('ticket0/get-conversation', { conversationId: followed })).rejects.toThrow(
      /permission denied/i,
    );

    // Put the directory back, so the cases after this read the desk they expect.
    await raeStub.invoke('ticket0/set-agent-profile', {
      displayName: 'Rae Okonjo',
      avatarUrl: null,
      signature: null,
    });
  });

  /** The assistant has a directory row for its byline, not so it can watch a thread. */
  it('refuses the assistant', async () => {
    await expect(
      admin.invoke('ticket0/follow-conversation', {
        conversationId: followed,
        follower: world.substrat.assistant.principal,
      }),
    ).rejects.toThrow(/assistant cannot follow a conversation/);
  });

  /**
   * `ctx.grant` DELEGATES, and this is the case that says so out loud.
   *
   * A caller holding `conversation:assign` on the thread passes the operation's own
   * gate and is still refused, because handing somebody a read of a conversation you
   * cannot read yourself would be elevation rather than sharing. Every staff role here
   * holds both keys, so nobody meets this in practice — which is exactly why it is
   * worth pinning: the day a desk invents a narrower role, this is the answer it gets.
   */
  it('refuses a caller who may route the thread but not read it', async () => {
    const router = principalId.parse(ulid());
    await host.admin.grant(world.staff, {
      principalId: router,
      permission: permissionKey.parse('conversation:assign'),
      node: { tenantId: world.substrat.tenant, scopeId: world.substrat.scope },
      entity: { entityType: 'conversation', entityId: followed },
      grantedBy: world.substrat.admin.principal,
    });
    const routerStub = await host.getScope(router, world.substrat.tenant, world.substrat.scope);
    await expect(
      routerStub.invoke('ticket0/follow-conversation', {
        conversationId: followed,
        follower: rae,
      }),
    ).rejects.toThrow(/cannot grant 'conversation:read'/);
    // And the refusal is the whole operation: nothing was handed out on the way past.
    await expect(raeStub.invoke('ticket0/get-conversation', { conversationId: followed })).rejects.toThrow(
      /permission denied/i,
    );
  });

  /**
   * A closed thread is precisely the one you may still need to show a colleague, so
   * following takes no `step` and appears in no state's `allow` — the standing the
   * reads have. Asserted rather than assumed: adding it to the lifecycle later would
   * make this red, which is the conversation worth having.
   */
  it('works on a closed conversation, because it is access and not work', async () => {
    const archived = await arrive('A thread that is already over');
    await admin.invoke('ticket0/close', { conversationId: archived });
    await admin.invoke('ticket0/follow-conversation', {
      conversationId: archived,
      follower: rae,
    });
    await expect(
      raeStub.invoke('ticket0/get-conversation', { conversationId: archived }),
    ).resolves.toMatchObject({ id: archived, state: 'closed' });
  });
});
