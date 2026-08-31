import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { orgId as orgIdSchema, type OrgId, type Page } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  invitesModule,
  INVITES_PERM as PERM,
  hashIdentifier,
  type Invitation,
} from '../src/index.js';

/**
 * The invites engine, tested directly — no vertical, no demo world.
 *
 * Most of these assert a *refusal* rather than a feature. That is the shape of
 * this engine: its value is in what it declines to reveal, and every leak here
 * would be silent and permanent.
 */
describe('invites engine', () => {
  let h: EngineHarness;
  let org: OrgId;

  beforeEach(async () => {
    h = await engineHarness({ modules: [invitesModule] });
    org = orgIdSchema.parse(ulid());
  });
  afterEach(async () => {
    await h.close();
  });

  const sender = () => h.as([PERM.send, PERM.read, PERM.revoke]);
  const send = async (identifier: string, roleKey = 'member') =>
    (await (await sender()).invoke<{ id: string }>('invites/send', {
      orgId: org,
      identifier,
      roleKey,
    })).id;

  // -- permissions ---------------------------------------------------------

  it('is default-deny: a principal with no permissions cannot send, list or revoke', async () => {
    const nobody = await h.as([]);
    await expect(
      nobody.invoke('invites/send', { orgId: org, identifier: 'a@b.com', roleKey: 'member' }),
    ).rejects.toThrow(/permission denied/);
    await expect(nobody.invoke('invites/list', { orgId: org })).rejects.toThrow(/permission denied/);
    await expect(nobody.invoke('invites/revoke', { invitationId: 'x' })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('lets the RECIPIENT accept without holding any permission', async () => {
    // The recipient is not a member of anything yet, so there is no grant they
    // could hold. The invitation is the authority — which is why accept is the
    // one operation with no check, and why it re-hashes the identifier instead.
    const id = await send('nina@example.com');
    const nina = await h.as([]);
    const accepted = await nina.invoke<Invitation>('invites/accept', {
      invitationId: id,
      identifier: 'nina@example.com',
    });
    expect(accepted.state).toBe('accepted');
  });

  // -- non-enumerability ---------------------------------------------------

  it('never returns the identifier or its hash', async () => {
    const id = await send('secret@example.com');
    const listed = (
      await (await sender()).invoke<Page<Invitation>>('invites/list', { orgId: org })
    ).entries;
    const row = listed.find((i) => i.id === id)!;
    // A leaked hash lets its holder confirm an address offline, which is the
    // enumeration this engine exists to prevent.
    expect(JSON.stringify(row)).not.toContain('secret@example.com');
    expect(Object.keys(row)).not.toContain('identifier_hash');
  });

  it('gives the same answer whether or not the person is already invited', async () => {
    // Re-inviting must be indistinguishable from a first invite, or the sender
    // can probe membership one address at a time.
    const first = await send('twice@example.com');
    const second = await send('twice@example.com');
    expect(second).toBe(first);
    const listed = (
      await (await sender()).invoke<Page<Invitation>>('invites/list', { orgId: org })
    ).entries;
    expect(listed.filter((i) => i.state === 'invited')).toHaveLength(1);
  });

  it('refuses every bad accept with one indistinguishable error', async () => {
    const id = await send('real@example.com');
    const stranger = await h.as([]);
    const message = /invitation is not acceptable/;
    // Wrong identifier, unknown invitation, and already-settled must not be
    // tellable apart — each distinction would be an oracle.
    await expect(
      stranger.invoke('invites/accept', { invitationId: id, identifier: 'wrong@example.com' }),
    ).rejects.toThrow(message);
    await expect(
      stranger.invoke('invites/accept', { invitationId: ulid(), identifier: 'real@example.com' }),
    ).rejects.toThrow(message);
    await stranger.invoke('invites/accept', { invitationId: id, identifier: 'real@example.com' });
    await expect(
      stranger.invoke('invites/accept', { invitationId: id, identifier: 'real@example.com' }),
    ).rejects.toThrow(message);
  });

  it('salts the hash per scope, so the same address differs across scopes', async () => {
    // A global salt would let the same address produce the same hash everywhere,
    // reintroducing cross-tenant correlation through the back door.
    const a = await hashIdentifier('scope-a', 'same@example.com');
    const b = await hashIdentifier('scope-b', 'same@example.com');
    expect(a).not.toBe(b);
    // ...and normalisation means one human is one hash.
    expect(await hashIdentifier('s', ' Same@Example.com ')).toBe(
      await hashIdentifier('s', 'same@example.com'),
    );
  });

  // -- state machine -------------------------------------------------------

  it('asks the connector to effect membership on accept, never writing it itself', async () => {
    // Membership is tenant-wide directory state. The engine cannot reach it
    // atomically from this transaction, so it emits and an executor effects
    // (K-22 §4.2).
    const id = await send('joiner@example.com', 'editor');
    const joiner = await h.as([]);
    await joiner.invoke('invites/accept', { invitationId: id, identifier: 'joiner@example.com' });

    const requests = h.eventsOfType('member.add-requested');
    expect(requests).toHaveLength(1);
    const payload = requests[0]!.payload as Record<string, unknown>;
    // Fat: everything the executor needs, with no cross-module read.
    expect(payload).toMatchObject({ orgId: org, roleKey: 'editor', invitationId: id });
    expect(payload.principal).toEqual(expect.any(String));
    expect(payload.tenantId).toBe(h.tenant);
  });

  it('does not ask for membership when an invite is merely sent', async () => {
    await send('pending@example.com');
    expect(h.eventsOfType('member.add-requested')).toHaveLength(0);
  });

  it('refuses an expired invitation, and settles it', async () => {
    const id = (
      await (await sender()).invoke<{ id: string }>('invites/send', {
        orgId: org,
        identifier: 'slow@example.com',
        roleKey: 'member',
        ttlMs: -1, // already past
      })
    ).id;
    const slow = await h.as([]);
    await expect(
      slow.invoke('invites/accept', { invitationId: id, identifier: 'slow@example.com' }),
    ).rejects.toThrow(/not acceptable/);
    const listed = (
      await (await sender()).invoke<Page<Invitation>>('invites/list', { orgId: org })
    ).entries;
    expect(listed.find((i) => i.id === id)?.state).toBe('expired');
    expect(h.eventsOfType('member.add-requested')).toHaveLength(0);
  });

  it('revokes an unaccepted invitation, and leaves settled ones alone', async () => {
    const id = await send('gone@example.com');
    const s = await sender();
    await s.invoke('invites/revoke', { invitationId: id });
    let listed = (await s.invoke<Page<Invitation>>('invites/list', { orgId: org })).entries;
    expect(listed.find((i) => i.id === id)?.state).toBe('revoked');

    // Revoking again is silent and changes nothing — idempotent, and no second event.
    await s.invoke('invites/revoke', { invitationId: id });
    expect(h.eventsOfType('invites.revoked')).toHaveLength(1);

    // And a revoked invitation cannot be accepted.
    const late = await h.as([]);
    await expect(
      late.invoke('invites/accept', { invitationId: id, identifier: 'gone@example.com' }),
    ).rejects.toThrow(/not acceptable/);
  });

  it('rate-limits open invitations per sender', async () => {
    const s = await sender();
    for (let i = 0; i < 25; i++) {
      await s.invoke('invites/send', { orgId: org, identifier: `p${i}@example.com`, roleKey: 'm' });
    }
    await expect(
      s.invoke('invites/send', { orgId: org, identifier: 'over@example.com', roleKey: 'm' }),
    ).rejects.toThrow(/rate limit/);
    // Settling one frees a slot — the limit is on OPEN invitations, not on
    // lifetime sends, or a busy admin would eventually be locked out forever.
    const listed = (await s.invoke<Page<Invitation>>('invites/list', { orgId: org })).entries;
    await s.invoke('invites/revoke', { invitationId: listed[0]!.id });
    await expect(
      s.invoke('invites/send', { orgId: org, identifier: 'ok@example.com', roleKey: 'm' }),
    ).resolves.toBeDefined();
  });

  it('answers a PAGE, not the whole book — and the cursor walks it', async () => {
    // #959: this read declared `output: invitation` while returning
    // `Invitation[]`, so `assertListsArePaged` — which only fires on a declared
    // `z.array()` — never saw a list. The declaration said one object, the
    // runtime returned every invitation an org had ever had, and the OpenAPI
    // document and the generated client both described the object.
    const s = await sender();
    for (let i = 0; i < 7; i++) {
      await s.invoke('invites/send', { orgId: org, identifier: `w${i}@example.com`, roleKey: 'm' });
    }

    const first = await s.invoke<Page<Invitation>>('invites/list', { orgId: org, limit: 3 });
    expect(first.entries).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();

    // Walking the cursor reaches every row exactly once. Newest first, so the
    // walk descends — and the ids come back strictly decreasing.
    const seen = [...first.entries];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = await s.invoke<Page<Invitation>>('invites/list', {
        orgId: org,
        limit: 3,
        cursor,
      });
      seen.push(...next.entries);
      cursor = next.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen.map((i) => i.id)).size).toBe(7);
    expect([...seen].sort((a, b) => (a.id < b.id ? 1 : -1))).toEqual(seen);
  });

  it('emits sent and accepted events with no personal data in them', async () => {
    const id = await send('quiet@example.com');
    const joiner = await h.as([]);
    await joiner.invoke('invites/accept', { invitationId: id, identifier: 'quiet@example.com' });
    const accepted = h.eventsOfType('invites.accepted')[0]!.payload as Record<string, unknown>;
    expect(accepted.principal).toEqual(expect.any(String));
    for (const type of ['invites.sent', 'invites.accepted']) {
      const events = h.eventsOfType(type);
      expect(events).toHaveLength(1);
      // The event spine outlives the row it describes, so an address leaked here
      // is leaked for as long as history is kept.
      expect(JSON.stringify(events[0]!.payload)).not.toContain('quiet@example.com');
    }
  });
});
