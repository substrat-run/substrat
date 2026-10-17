/**
 * The migration set digest (#2349): what the uploader injects for a version's stored migrations,
 * and what a scope host compares its registered steps with before it applies a migration.
 */
import { describe, expect, it } from 'vitest';
import { isDerivedMigrationVersion, migrationSetDigest, migrationSetDivergence, migrationSteps, moduleMigrations } from '../src/index.js';

const a1 = { moduleId: 'a', version: '0001', sql: 'CREATE TABLE a (id TEXT);' };
const a2 = { moduleId: 'a', version: '0002', sql: 'ALTER TABLE a ADD COLUMN n TEXT;' };
const b1 = { moduleId: 'b', version: '0001', sql: 'CREATE TABLE b (id TEXT);' };

/** A host's registered module, as both adapters hand it to the check. */
const registered = (id: string, migrations: { version: string; sql: string }[]) => ({
  id,
  steps: migrationSteps({ manifest: { id }, migrations }),
});

describe('migrationSetDigest (#2349)', () => {
  it('is the same whichever order the modules come in, since a push and a host order them independently', async () => {
    expect(await migrationSetDigest([a1, a2, b1])).toBe(await migrationSetDigest([b1, a1, a2]));
  });

  it("changes with any byte of SQL, a version, a module, or the order inside one module", async () => {
    const base = await migrationSetDigest([a1, a2, b1]);
    expect(await migrationSetDigest([a1, { ...a2, sql: `${a2.sql} ` }, b1])).not.toBe(base);
    expect(await migrationSetDigest([a1, { ...a2, version: '0003' }, b1])).not.toBe(base);
    expect(await migrationSetDigest([a1, a2, { ...b1, moduleId: 'c' }])).not.toBe(base);
    expect(await migrationSetDigest([a2, a1, b1])).not.toBe(base);
    expect(await migrationSetDigest([a1, a2])).not.toBe(base);
  });
});

describe('migrationSetDivergence (#2349)', () => {
  it('compares nothing without a stored digest', async () => {
    expect(await migrationSetDivergence([registered('a', [a1])], undefined)).toBeNull();
    expect(await migrationSetDivergence([registered('a', [a1])], null)).toBeNull();
  });

  it('accepts the registered set its stored digest was made from, and refuses one that differs', async () => {
    const stored = await migrationSetDigest([a1, a2, b1]);
    expect(await migrationSetDivergence([registered('b', [b1]), registered('a', [a1, a2])], stored)).toBeNull();
    const error = await migrationSetDivergence([registered('a', [a1, { ...a2, sql: 'ALTER TABLE a ADD COLUMN m TEXT;' }]), registered('b', [b1])], stored);
    expect(error).toContain(`stored ${stored}`);
    expect(error).toContain('registered: a@0001, a@0002, b@0001. Nothing was applied.');
  });

  it('names at most 20 registered migrations, then how many more', async () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ version: String(i).padStart(4, '0'), sql: `SELECT ${i};` }));
    const error = await migrationSetDivergence([registered('a', many)], '0'.repeat(64));
    expect(error).toContain(`registered: ${many.slice(0, 20).map((m) => `a@${m.version}`).join(', ')} and 3 more.`);
  });
});

/**
 * What the set digest rests on (#2349 r2): both sides drop derived migrations BY NAME, so every
 * step `moduleMigrations` derives must be named under a prefix `isDerivedMigrationVersion`
 * knows. A fourth kind of derived step under a new prefix fails here, rather than as a refusal
 * that fails every scope of a correct deployment closed.
 */
describe('isDerivedMigrationVersion against moduleMigrations (#2349)', () => {
  const authored = [
    { version: '0001-init', sql: 'CREATE TABLE ticket (id TEXT PRIMARY KEY, title TEXT, status TEXT, created_at TEXT);' },
    { version: '0002-note', sql: 'ALTER TABLE ticket ADD COLUMN note TEXT;' },
  ];
  /** Every kind of declaration the kernel derives migrations from, each in its widest form. */
  const manifest = {
    id: 'everything',
    searchables: [{ entityType: 'ticket', fields: ['title'], table: 'ticket', idColumn: 'id', tokenizer: 'unicode61' as const }],
    lists: [{ entityType: 'ticket', sortable: ['created_at', 'id'], filterable: ['status'], table: 'ticket', idColumn: 'id' }],
    entityStates: [
      {
        entityType: 'ticket',
        archivePermission: 'ticket:archive',
        trashPermission: 'ticket:trash',
        purgeAfterDays: 30,
        table: 'ticket',
        idColumn: 'id',
      },
    ],
  };

  it('names every derived step as derived, and no authored one', () => {
    const steps = moduleMigrations({ manifest, migrations: authored } as never);
    const derived = steps.slice(authored.length);
    expect(steps.slice(0, authored.length)).toEqual(authored);
    // One of each kind: the search index, the archive and trash columns, their guard, the purge
    // index, and the list index. A kind dropped from the module would shrink this, not pass it.
    expect(derived.map((m) => m.version.split(':')[0]!.split('/')[0])).toEqual(['search', 'state', 'state', 'state', 'state', 'list']);
    for (const m of derived) expect(isDerivedMigrationVersion(m.version), m.version).toBe(true);
    for (const m of authored) expect(isDerivedMigrationVersion(m.version), m.version).toBe(false);
  });
});

