import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { errorCodeOf, orgId as orgIdSchema, type OrgId, type Page } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  invitesModule,
  INVITES_PERM as PERM,
  acceptInvite,
  listInvites,
  sendInvite,
  type Invitation,
} from '../src/index.js';
import { columnsOf } from '../src/seam.js';
import { invitation, invitationRow } from '../src/entities.js';

/**
 * The seam, under drift (#771/#970) — engine-invites' copy of workorder's suite.
 *
 * Every test here answers one question: when the stored row stops matching the
 * shape this engine PUBLISHES, does the caller get a throw or wrong data? Before
 * this, the answer was wrong data — the return values crossed the seam typed by a
 * TypeScript assertion that is not there at runtime.
 *
 * This engine has a second thing to lose, and it is worse than wrong data: the
 * hash. `PUBLIC_COLUMNS` was a hand-written string, so the only thing keeping
 * `identifier_hash` out of a read was that nobody had written `SELECT *` yet.
 *
 * The drift is simulated the only honest way available: by moving the table under
 * a running engine, which is what a vertical compiled against 0.3 and running
 * against 0.4 is actually looking at.
 */

const ALL = [PERM.send, PERM.read, PERM.revoke];

describe('engine-invites — the seam is parsed, not asserted', () => {
  let h: EngineHarness;
  let org: OrgId;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({ modules: [invitesModule] });
    org = orgIdSchema.parse(ulid());
    staff = await h.as(ALL);
  });
  afterEach(async () => {
    await h.close();
  });

  const send = (identifier = 'ada@example.com') =>
    h.run((ctx) => sendInvite(ctx, { orgId: org, identifier, roleKey: 'member' }), ALL);

  /** Move the table under the engine, the way a version bump would. */
  const drift = (sql: string) => h.run((ctx) => void ctx.sql.exec(sql), ALL);

  // -- the SELECT list is derived from the row schema ---------------------------

  it('names the columns a row schema describes, in its order', () => {
    expect(columnsOf(invitationRow)).toBe(
      'id, org_id, identifier_hash, role_key, state, invited_by, accepted_by, created_at, expires_at, settled_at',
    );
    // The published list is the same MINUS the hash, derived rather than
    // transcribed — which is what makes the omission structural.
    expect(columnsOf(invitation)).toBe(
      'id, org_id, role_key, state, invited_by, accepted_by, created_at, expires_at, settled_at',
    );
  });

  it('the hash never crosses the seam, on any read', async () => {
    const sent = await send();
    const accepted = await h.run(
      (ctx) => acceptInvite(ctx, { invitationId: sent.id, identifier: 'ada@example.com' }),
      ALL,
    );
    const listed = await h.run((ctx) => listInvites(ctx, org), ALL);
    const paged = await staff.invoke<Page<Invitation>>('invites/list', { orgId: org });

    for (const row of [accepted, ...listed, ...paged.entries]) {
      expect(row).not.toHaveProperty('identifier_hash');
    }
  });

  it('a column that vanished fails AT THE READ, naming itself', async () => {
    await send();
    // The published shape still says `settled_at`; the table no longer does.
    await drift('ALTER TABLE invites_invitation DROP COLUMN settled_at');

    // `SELECT *` would have returned a row quietly missing the field. Naming the
    // columns makes the read itself refuse, and say which column it wanted.
    await expect(h.run((ctx) => listInvites(ctx, org), ALL)).rejects.toThrow(
      /no such column: settled_at/,
    );
  });

  it('a column added upstream never crosses the seam', async () => {
    await send();
    await drift('ALTER TABLE invites_invitation ADD COLUMN internal_note TEXT');
    await drift(`UPDATE invites_invitation SET internal_note = 'do not publish'`);

    const listed = await h.run((ctx) => listInvites(ctx, org), ALL);
    const paged = await staff.invoke<Page<Invitation>>('invites/list', { orgId: org });
    for (const row of [...listed, ...paged.entries]) {
      expect(Object.keys(row)).toEqual([
        'id',
        'org_id',
        'role_key',
        'state',
        'invited_by',
        'accepted_by',
        'created_at',
        'expires_at',
        'settled_at',
      ]);
      expect(row).not.toHaveProperty('internal_note');
    }
  });

  // -- a drifted row throws instead of surfacing as wrong data ------------------

  it('a state this engine does not know throws at the seam', async () => {
    await send();
    // `state` is the whole machine. A value outside it is exactly the retype an
    // additive-only rule forbids and nothing enforced.
    await drift(`UPDATE invites_invitation SET state = 'pending'`);

    await expect(h.run((ctx) => listInvites(ctx, org), ALL)).rejects.toThrow(
      /does not match the shape this engine publishes.*state/s,
    );
    await expect(staff.invoke('invites/list', { orgId: org })).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
  });

  it('accepting reads a row it has parsed, so a drifted state is not filed as "not acceptable"', async () => {
    const sent = await send();
    await drift(`UPDATE invites_invitation SET state = 'pending'`);

    // The refusal this engine gives a wrong identifier is deliberately
    // indistinguishable from every other refusal — which is why an ENGINE fault
    // must not land in the same bucket. It would be invisible forever.
    const err = await h
      .run((ctx) => acceptInvite(ctx, { invitationId: sent.id, identifier: 'ada@example.com' }), ALL)
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/does not match the shape this engine publishes/);
    expect(String(err)).not.toMatch(/not acceptable/);
  });

  it('blames the engine, not the caller: a drifted row is `internal`', async () => {
    await send();
    await drift(`UPDATE invites_invitation SET state = 'pending'`);

    // The caller's input was already parsed and is not what went wrong, so this
    // must not answer 400 `validation_failed` — that is a lie a client acts on.
    const err = await h.run((ctx) => listInvites(ctx, org), ALL).catch((e: unknown) => e);
    expect(errorCodeOf(err)).toBe('internal');
  });
});
