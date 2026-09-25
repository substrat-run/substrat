import { describe, expect, it } from 'vitest';
import type { MigrationDiff } from '@substrat-run/contracts';
import { diffRegistries, hasRegistryChange, registryDirection, type RegistryLike } from '../web/src/lib/registry-diff.js';
import {
  classifyRefusal,
  honour,
  planMigration,
  planPermission,
  promoteWithCheckpoint,
  type Acks,
  type Checkpoint,
  type PromoteReviewWire,
} from '../web/src/lib/promote-review.js';

/**
 * The promote dialog's decisions (#1677). The dashboard has no DOM test setup, so the two
 * claims worth making about it live in plain functions:
 *
 *   1. what the person is shown is a true diff of the two registries, said plainly; and
 *   2. an acknowledgement is only ever sent for a change that was shown, and ticked on its own.
 *
 * The second is the security-relevant one, so the flow tests run against a GATE that behaves
 * like the registry's (`promoteVersion`): it refuses a promote whose permission digest, then
 * whose migration digest, differs until that kind is acknowledged — and it records what it
 * was sent. "The gate was never sent the flag" is then something an assertion can say.
 */

const reg = (over: Partial<RegistryLike> = {}): RegistryLike => ({
  permissions: [
    { key: 'desk:read', description: 'Read tickets' },
    { key: 'desk:write', description: 'Write tickets' },
  ],
  roles: [
    { key: 'agent', permissions: ['desk:read', 'desk:write'] },
    { key: 'viewer', permissions: ['desk:read'] },
  ],
  entityGrants: [{ entityType: 'ticket', permissions: ['desk:read'] }],
  ...over,
});

const review = (over: Partial<PromoteReviewWire> = {}): PromoteReviewWire => ({
  serving: { versionId: 'v1' },
  incoming: { versionId: 'v2' },
  servingRegistry: reg(),
  incomingRegistry: reg(),
  // A new-CLI version whose SQL adds nothing: the "no change" baseline. `null` is not that.
  migrations: { baseline: 'version', added: [], changed: [], total: 0, truncated: false },
  ...over,
});

// The refusal texts the two adapters throw, verbatim.
const PERM_REFUSAL = 'promotion changes the permission surface (aaa111 → bbb222) — acknowledge it explicitly to promote';
const MIG_REFUSAL = 'promotion changes migrations (ccc333 → ddd444) — acknowledge it explicitly to promote';

describe('diffRegistries', () => {
  it('is empty for equal registries, and order is not a change', () => {
    const a = reg();
    const b = reg({
      permissions: [...a.permissions].reverse(),
      roles: [{ key: 'viewer', permissions: ['desk:read'] }, { key: 'agent', permissions: ['desk:write', 'desk:read'] }],
    });
    const d = diffRegistries(a, b);
    expect(hasRegistryChange(d)).toBe(false);
    expect(registryDirection(d)).toBe('none');
  });

  it('reads new keys, widened roles and new grant shapes as additions', () => {
    const d = diffRegistries(
      reg(),
      reg({
        permissions: [...reg().permissions, { key: 'desk:admin', description: 'Administer' }],
        roles: [
          { key: 'agent', permissions: ['desk:read', 'desk:write', 'desk:admin'] },
          { key: 'viewer', permissions: ['desk:read'] },
        ],
        entityGrants: [
          { entityType: 'ticket', permissions: ['desk:read', 'desk:write'] },
          { entityType: 'queue', permissions: ['desk:read'] },
        ],
      }),
    );
    expect(d.addedKeys).toEqual(['desk:admin']);
    expect(d.roleChanges).toEqual([{ key: 'agent', added: ['desk:admin'], removed: [], isNew: false, isGone: false }]);
    expect(d.grantChanges).toEqual([
      { entityType: 'ticket', added: ['desk:write'], removed: [], isNew: false, isGone: false },
      { entityType: 'queue', added: ['desk:read'], removed: [], isNew: true, isGone: false },
    ]);
    expect(registryDirection(d)).toBe('adds');
  });

  it('reads removed keys, narrowed roles and gone grant shapes as removals', () => {
    const d = diffRegistries(
      reg(),
      reg({
        permissions: [{ key: 'desk:read', description: 'Read tickets' }],
        roles: [{ key: 'agent', permissions: ['desk:read'] }],
        entityGrants: [],
      }),
    );
    expect(d.removedKeys).toEqual(['desk:write']);
    expect(d.roleChanges.map((r) => [r.key, r.removed, r.isGone])).toEqual([
      ['agent', ['desk:write'], false],
      ['viewer', ['desk:read'], true],
    ]);
    expect(d.grantChanges).toEqual([{ entityType: 'ticket', added: [], removed: ['desk:read'], isNew: false, isGone: true }]);
    expect(registryDirection(d)).toBe('removes');
  });

  it('never rounds a mixed change to a side', () => {
    // gains one key and loses another in ONE role
    const both = diffRegistries(
      reg({ roles: [{ key: 'agent', permissions: ['desk:read'] }] }),
      reg({ roles: [{ key: 'agent', permissions: ['desk:write'] }] }),
    );
    expect(registryDirection(both)).toBe('mixed');
    // a re-worded description beside an addition is not "only adds"
    const reworded = diffRegistries(
      reg(),
      reg({
        permissions: [
          { key: 'desk:read', description: 'Read every ticket' },
          { key: 'desk:write', description: 'Write tickets' },
          { key: 'desk:admin', description: 'Administer' },
        ],
      }),
    );
    expect(reworded.changedKeys).toEqual(['desk:read']);
    expect(registryDirection(reworded)).toBe('mixed');
    // a re-worded description alone is a change, and points nowhere
    const only = diffRegistries(reg(), reg({ permissions: [{ key: 'desk:read', description: 'x' }, { key: 'desk:write', description: 'Write tickets' }] }));
    expect(hasRegistryChange(only)).toBe(true);
    expect(registryDirection(only)).toBe('mixed');
  });
});

describe('planPermission', () => {
  it('asks nothing of a first promotion, which the gate does not gate either', () => {
    expect(planPermission(review({ serving: null, servingRegistry: null, incomingRegistry: null }))).toBeNull();
  });

  it('asks nothing when the two registries are equal', () => {
    expect(planPermission(review())).toBeNull();
  });

  it('shows the diff when they differ', () => {
    const p = planPermission(review({ incomingRegistry: reg({ permissions: [...reg().permissions, { key: 'desk:admin', description: 'Administer' }] }) }));
    expect(p).toMatchObject({ kind: 'diff', diff: { addedKeys: ['desk:admin'] } });
  });

  // A version pushed before D-39 has `registry: null`. "Nothing to compare" is not "no change".
  it.each([
    ['serving', { servingRegistry: null }, 'serving-has-no-registry'],
    ['incoming', { incomingRegistry: null }, 'incoming-has-no-registry'],
    ['both', { servingRegistry: null, incomingRegistry: null }, 'neither-has-a-registry'],
  ] as const)('a registry missing on the %s side cannot be diffed, and is not read as no change', (_side, over, why) => {
    expect(planPermission(review(over))).toEqual({ kind: 'unverifiable', why });
  });
});

describe('classifyRefusal', () => {
  it('reads both gate messages, with their digest pairs', () => {
    expect(classifyRefusal(PERM_REFUSAL)).toEqual({ kind: 'permission', digests: 'aaa111 → bbb222' });
    expect(classifyRefusal(MIG_REFUSAL)).toEqual({ kind: 'migration', digests: 'ccc333 → ddd444' });
  });
  it('reads any other failure as not a refusal', () => {
    expect(classifyRefusal('version v2 is pending, not admitted — it cannot be promoted')).toBeNull();
    expect(classifyRefusal('control plane unreachable: boom')).toBeNull();
  });
  it('does not guess at a refusal for something it has no section for', () => {
    expect(classifyRefusal('promotion changes the egress policy (a → b) — acknowledge it explicitly to promote')).toBe('unrecognised');
  });
});

describe('honour', () => {
  const shown = (over: Partial<Checkpoint>): Checkpoint => ({ permission: null, migration: null, acknowledged: {}, ...over });
  const diffSection = { kind: 'unverifiable', why: 'neither-has-a-registry' } as const;

  it('counts a kind only when it was shown AND ticked', () => {
    expect(honour(shown({ permission: diffSection }), { permissionChange: true })).toEqual({ permissionChange: true });
    expect(honour(shown({ permission: diffSection }), {})).toEqual({});
  });
  it('drops a flag for a change that was not shown', () => {
    expect(honour(shown({ permission: diffSection }), { permissionChange: true, migrationChange: true })).toEqual({ permissionChange: true });
    expect(honour(shown({}), { permissionChange: true, migrationChange: true })).toEqual({});
  });
  it('keeps what an earlier round acknowledged', () => {
    expect(honour(shown({ migration: { digests: null, sql: null, enforced: false }, acknowledged: { permissionChange: true } }), { migrationChange: true })).toEqual({
      permissionChange: true,
      migrationChange: true,
    });
  });
});

/** A registry gate: refuses per digest, in the order the real one does, and remembers what it was sent. */
function gate(differs: { permission?: boolean; migration?: boolean }) {
  const sent: Array<Acks | undefined> = [];
  return {
    sent,
    promote: async (ack: Acks | undefined) => {
      sent.push(ack);
      if (differs.permission && !ack?.permissionChange) throw new Error(PERM_REFUSAL);
      if (differs.migration && !ack?.migrationChange) throw new Error(MIG_REFUSAL);
    },
  };
}

/** A dialog that records each checkpoint it was shown and answers from a script. */
function dialog(...answers: Array<Acks | null>) {
  const shown: Checkpoint[] = [];
  return {
    shown,
    ask: async (c: Checkpoint) => {
      shown.push(c);
      return answers[shown.length - 1] ?? null;
    },
  };
}

const widened = review({
  incomingRegistry: reg({ permissions: [...reg().permissions, { key: 'desk:admin', description: 'Administer' }] }),
});

describe('promoteWithCheckpoint', () => {
  it('no change: no dialog, and the promote is the request it always was', async () => {
    const g = gate({});
    const d = dialog();
    expect(await promoteWithCheckpoint({ review: async () => review(), promote: g.promote, ask: d.ask })).toBe('promoted');
    expect(d.shown).toEqual([]);
    expect(g.sent).toEqual([undefined]); // no `acknowledge` at all
  });

  it('a first promotion: no dialog, no review-driven ack', async () => {
    const g = gate({});
    const d = dialog();
    const first = review({ serving: null, servingRegistry: null, incomingRegistry: null });
    expect(await promoteWithCheckpoint({ review: async () => first, promote: g.promote, ask: d.ask })).toBe('promoted');
    expect(d.shown).toEqual([]);
    expect(g.sent).toEqual([undefined]);
  });

  it('a permission-only change shows the diff and sends only permissionChange', async () => {
    const g = gate({ permission: true });
    const d = dialog({ permissionChange: true });
    expect(await promoteWithCheckpoint({ review: async () => widened, promote: g.promote, ask: d.ask })).toBe('promoted');
    expect(d.shown).toHaveLength(1);
    expect(d.shown[0]!.permission).toMatchObject({ kind: 'diff' });
    expect(d.shown[0]!.migration).toBeNull();
    expect(g.sent).toEqual([{ permissionChange: true }]);
    expect(g.sent[0]).not.toHaveProperty('migrationChange');
  });

  it('cancelling at the dialog promotes nothing', async () => {
    const g = gate({ permission: true });
    const d = dialog(null);
    expect(await promoteWithCheckpoint({ review: async () => widened, promote: g.promote, ask: d.ask })).toBe('cancelled');
    expect(g.sent).toEqual([]);
  });

  it('an untouched dialog is not an acknowledgement', async () => {
    const g = gate({ permission: true });
    const d = dialog({}); // confirmed with nothing ticked
    expect(await promoteWithCheckpoint({ review: async () => widened, promote: g.promote, ask: d.ask })).toBe('cancelled');
    expect(g.sent).toEqual([]);
  });

  // ---- the security points --------------------------------------------------------------

  describe('never sends an acknowledgement for a change it did not show', () => {
    it('an answer carrying both flags acknowledges only the shown kind', async () => {
      const g = gate({ permission: true });
      const d = dialog({ permissionChange: true, migrationChange: true });
      await promoteWithCheckpoint({ review: async () => widened, promote: g.promote, ask: d.ask });
      expect(g.sent).toEqual([{ permissionChange: true }]);
    });

    it('a flag for an unshown change never reaches the gate even when nothing was shown', async () => {
      // The gate wants nothing; the dialog is never asked; a stray answer could not be applied.
      const g = gate({});
      const d = dialog({ permissionChange: true, migrationChange: true });
      await promoteWithCheckpoint({ review: async () => review(), promote: g.promote, ask: d.ask });
      expect(g.sent).toEqual([undefined]);
    });

    it('a migration refusal after a permission ack is a new question: the permission tick does not cover it', async () => {
      const g = gate({ permission: true, migration: true });
      // Round 1 ticks permission. Round 2 (the migration refusal) answers WITHOUT the migration tick.
      const d = dialog({ permissionChange: true }, { permissionChange: true });
      expect(await promoteWithCheckpoint({ review: async () => widened, promote: g.promote, ask: d.ask })).toBe('cancelled');
      expect(g.sent.every((a) => a?.migrationChange !== true)).toBe(true);
      expect(g.sent).toEqual([{ permissionChange: true }]); // the second promote was never made
    });

    it('acknowledging each kind on its own sends each flag exactly once it has been ticked', async () => {
      const g = gate({ permission: true, migration: true });
      const d = dialog({ permissionChange: true }, { migrationChange: true });
      expect(await promoteWithCheckpoint({ review: async () => widened, promote: g.promote, ask: d.ask })).toBe('promoted');
      // permission was shown first (from the review), migration second (from the refusal)
      expect(d.shown[0]!.migration).toBeNull();
      expect(d.shown[1]!.migration).not.toBeNull();
      expect(d.shown[1]!.acknowledged).toEqual({ permissionChange: true });
      expect(g.sent).toEqual([{ permissionChange: true }, { permissionChange: true, migrationChange: true }]);
    });

    it('a migration-only change shows no permission section and sends only migrationChange', async () => {
      const g = gate({ migration: true });
      const d = dialog({ migrationChange: true });
      expect(await promoteWithCheckpoint({ review: async () => review(), promote: g.promote, ask: d.ask })).toBe('promoted');
      expect(d.shown).toHaveLength(1);
      expect(d.shown[0]!.permission).toBeNull();
      // The SQL diff is empty (the digest moved on a Durable-Object class), and is shown as such.
      expect(d.shown[0]!.migration).toEqual({ digests: 'ccc333 → ddd444', sql: review().migrations, enforced: true });
      expect(g.sent).toEqual([undefined, { migrationChange: true }]);
      expect(g.sent[1]).not.toHaveProperty('permissionChange');
    });

    it('declining the migration section promotes nothing, whatever was ticked before it', async () => {
      const g = gate({ permission: true, migration: true });
      const d = dialog({ permissionChange: true }, null);
      expect(await promoteWithCheckpoint({ review: async () => widened, promote: g.promote, ask: d.ask })).toBe('cancelled');
      expect(g.sent.some((a) => a?.migrationChange)).toBe(false);
    });
  });

  describe('a review that could not be read blocks the promote', () => {
    it('rejects, asks nothing, and sends nothing', async () => {
      const g = gate({});
      const d = dialog({ permissionChange: true });
      await expect(
        promoteWithCheckpoint({
          review: async () => {
            throw new Error('control plane unreachable: boom');
          },
          promote: g.promote,
          ask: d.ask,
        }),
      ).rejects.toThrow('unreachable');
      expect(g.sent).toEqual([]);
      expect(d.shown).toEqual([]);
    });

    it('does not degrade to "no changes, promote" even when the surface would in fact be unchanged', async () => {
      // The positive twin of the "no change" test above: same gate, same versions — the only
      // difference is that the read failed.
      const g = gate({});
      await expect(
        promoteWithCheckpoint({ review: () => Promise.reject(new Error('502')), promote: g.promote, ask: dialog().ask }),
      ).rejects.toThrow('502');
      expect(g.sent).toEqual([]);
    });
  });

  describe('a version with no stored registry requires an explicit acknowledgement', () => {
    it.each([
      ['serving', { servingRegistry: null }],
      ['incoming', { incomingRegistry: null }],
      ['both', { servingRegistry: null, incomingRegistry: null }],
    ] as const)('%s side null: the dialog says it cannot diff and the promote waits for the tick', async (_side, over) => {
      const g = gate({ permission: true });
      const declined = dialog(null);
      expect(await promoteWithCheckpoint({ review: async () => review(over), promote: g.promote, ask: declined.ask })).toBe('cancelled');
      expect(declined.shown[0]!.permission).toMatchObject({ kind: 'unverifiable' });
      expect(g.sent).toEqual([]);

      const ticked = dialog({ permissionChange: true });
      expect(await promoteWithCheckpoint({ review: async () => review(over), promote: gate({ permission: true }).promote, ask: ticked.ask })).toBe('promoted');
    });
  });

  describe('the gate stays the authority', () => {
    it('digests differ but no diff could be drawn: the same dialog opens, as server-reported', async () => {
      const g = gate({ permission: true });
      const d = dialog({ permissionChange: true });
      // the registries diff equal, so the review asks nothing — and the gate still refuses
      expect(await promoteWithCheckpoint({ review: async () => review(), promote: g.promote, ask: d.ask })).toBe('promoted');
      expect(d.shown[0]!.permission).toEqual({ kind: 'server-reported', digests: 'aaa111 → bbb222' });
      expect(g.sent).toEqual([undefined, { permissionChange: true }]);
    });

    it('a refusal for something it has no section for is rethrown with nothing acknowledged', async () => {
      const d = dialog({ permissionChange: true, migrationChange: true });
      const sent: Array<Acks | undefined> = [];
      await expect(
        promoteWithCheckpoint({
          review: async () => review(),
          promote: async (a) => {
            sent.push(a);
            throw new Error('promotion changes the egress policy (a → b) — acknowledge it explicitly to promote');
          },
          ask: d.ask,
        }),
      ).rejects.toThrow('egress policy');
      expect(d.shown).toEqual([]);
      expect(sent).toEqual([undefined]);
    });

    it('other failures are rethrown untouched', async () => {
      await expect(
        promoteWithCheckpoint({
          review: async () => review(),
          promote: async () => {
            throw new Error('version v2 is pending, not admitted — it cannot be promoted');
          },
          ask: dialog().ask,
        }),
      ).rejects.toThrow('not admitted');
    });

    it('a refusal for a kind that WAS acknowledged is surfaced, not retried', async () => {
      // The digest moved under the person between the dialog and the promote.
      const sent: Array<Acks | undefined> = [];
      const d = dialog({ permissionChange: true });
      await expect(
        promoteWithCheckpoint({
          review: async () => widened,
          promote: async (a) => {
            sent.push(a);
            throw new Error(PERM_REFUSAL);
          },
          ask: d.ask,
        }),
      ).rejects.toThrow('permission surface');
      expect(sent).toEqual([{ permissionChange: true }]);
      expect(d.shown).toHaveLength(1);
    });
  });
});

/**
 * The migrations a promote would run (#1677 part b). The gate's migration digest does not
 * cover SQL (#1754), so the review is what raises a SQL-only change, and the dialog asks for
 * it on its own. That acknowledgement is client-side, and these hold it to the same rules as
 * the rest: shown before it can be given, ticked on its own, and never skipped.
 */
describe('the migration section from the review (#1677)', () => {
  const ADD = { moduleId: 'desk', version: '0002-priority', sql: 'ALTER TABLE ticket ADD COLUMN priority TEXT;' };
  const withSql = (over: Partial<MigrationDiff> = {}): PromoteReviewWire =>
    review({ migrations: { baseline: 'version', added: [ADD], changed: [], total: 1, truncated: false, ...over } });

  it('planMigration: shown when the review adds or edits one; null only for an empty diff or nothing to compare', () => {
    expect(planMigration(withSql())).toEqual({ digests: null, sql: withSql().migrations, enforced: false });
    expect(planMigration(withSql({ added: [], total: 0 }))).toBeNull();
    expect(planMigration(review({ serving: null, migrations: null }))).toBeNull();
    expect(planMigration(review({ serving: { versionId: 'v2' }, migrations: null }))).toBeNull();
  });

  it('planMigration: NO SQL carried is "not available" and asked about — never read as no change', () => {
    expect(planMigration(review({ migrations: null }))).toEqual({ digests: null, sql: null, enforced: false });
  });

  it('a version with no SQL, which the gate lets through, still waits for the migration tick', async () => {
    const g = gate({});
    const declined = dialog({});
    expect(await promoteWithCheckpoint({ review: async () => review({ migrations: null }), promote: g.promote, ask: declined.ask })).toBe('cancelled');
    expect(declined.shown[0]!.migration).toEqual({ digests: null, sql: null, enforced: false });
    expect(g.sent).toEqual([]);
    const ticked = dialog({ migrationChange: true });
    expect(await promoteWithCheckpoint({ review: async () => review({ migrations: null }), promote: g.promote, ask: ticked.ask })).toBe('promoted');
    expect(g.sent).toEqual([{ migrationChange: true }]);
  });

  it('a SQL-only change the gate does not see is asked for BEFORE the promote, and sent only if ticked', async () => {
    const g = gate({});
    const d = dialog({ migrationChange: true });
    expect(await promoteWithCheckpoint({ review: async () => withSql(), promote: g.promote, ask: d.ask })).toBe('promoted');
    expect(d.shown).toHaveLength(1);
    expect(d.shown[0]!.migration).toMatchObject({ enforced: false, sql: { added: [ADD] } });
    expect(g.sent).toEqual([{ migrationChange: true }]);
  });

  it('not ticked → nothing is promoted, though the gate would have let it through', async () => {
    const g = gate({});
    expect(await promoteWithCheckpoint({ review: async () => withSql(), promote: g.promote, ask: dialog({}).ask })).toBe('cancelled');
    expect(await promoteWithCheckpoint({ review: async () => withSql(), promote: g.promote, ask: dialog(null).ask })).toBe('cancelled');
    expect(g.sent).toEqual([]);
  });

  it('the permission tick does not cover it', async () => {
    const g = gate({ permission: true });
    const both = { ...withSql(), incomingRegistry: widened.incomingRegistry };
    expect(await promoteWithCheckpoint({ review: async () => both, promote: g.promote, ask: dialog({ permissionChange: true }).ask })).toBe('cancelled');
    expect(g.sent).toEqual([]);
  });

  it('a gate refusal with SQL in the review shows the SQL, now enforced', async () => {
    const g = gate({ migration: true });
    const noSqlChange = withSql({ added: [], total: 0 });
    const d = dialog({ migrationChange: true });
    expect(await promoteWithCheckpoint({ review: async () => noSqlChange, promote: g.promote, ask: d.ask })).toBe('promoted');
    expect(d.shown[0]!.migration).toEqual({ digests: 'ccc333 → ddd444', sql: noSqlChange.migrations, enforced: true });
  });

  it('a gate refusal with NO SQL carried was already asked about, and the tick carries through', async () => {
    const g = gate({ migration: true });
    const d = dialog({ migrationChange: true });
    expect(await promoteWithCheckpoint({ review: async () => review({ migrations: null }), promote: g.promote, ask: d.ask })).toBe('promoted');
    expect(d.shown).toHaveLength(1);
    expect(d.shown[0]!.migration).toEqual({ digests: null, sql: null, enforced: false });
    expect(g.sent).toEqual([{ migrationChange: true }]);
  });
});
