/**
 * #1974 — an enum is a CHECK, and the planner has to read it.
 *
 * An enum field is emitted as `state TEXT NOT NULL CHECK (state IN ('a','b'))`.
 * The planner used to compare columns, keys and uniques only, so a value added
 * to the model planned as `up-to-date` while every database the journal builds
 * went on refusing it. These tests run the journal's SQL against a real SQLite
 * to show what the database does, and hold the planner to agreeing with it.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { z, defineEntities } from '@substrat-run/contracts';
import { columnChecks, journalChecks, normaliseSql, planMigration, type Journal } from '../src/index.js';

const ticketWith = (values: readonly [string, ...string[]], extra?: { renamedFrom?: Record<string, string> }) =>
  defineEntities({
    ticket: {
      table: 'acme_tickets',
      fields: z.object({ id: z.string(), title: z.string(), state: z.enum(values) }),
      ...extra,
    },
  });

const original = ticketWith(['new', 'open', 'closed']);

const journalOf = (entities: Parameters<typeof planMigration>[0]): Journal => {
  const plan = planMigration(entities, { entries: [] });
  if (plan.kind !== 'append') throw new Error(`expected an append, got ${plan.kind}`);
  return { entries: [plan.entry] };
};
const shipped = journalOf(original);
const sqlOf = (journal: Journal) => journal.entries.map((e) => e.sql).join('\n');

/** Build a real database from a journal and try to write `state`. */
function accepts(journal: Journal, state: string): boolean {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sqlOf(journal));
    db.prepare('INSERT INTO acme_tickets (id, title, state) VALUES (?, ?, ?)').run('t1', 'x', state);
    return true;
  } catch (cause) {
    if (/CHECK constraint failed/.test((cause as Error).message)) return false;
    throw cause;
  } finally {
    db.close();
  }
}

const reasonsOf = (plan: ReturnType<typeof planMigration>): string => {
  expect(plan.kind).toBe('refused');
  return plan.kind === 'refused' ? plan.reasons.join('\n') : '';
};

describe('#1974 — an enum whose values moved', () => {
  it('refuses a widened enum, which the database the journal builds would refuse at runtime', () => {
    const widened = ticketWith(['new', 'open', 'closed', 'suspended']);
    // The gap, shown on the engine itself: the journal's table refuses the new value.
    expect(accepts(shipped, 'suspended')).toBe(false);

    const reasons = reasonsOf(planMigration(widened, shipped));
    expect(reasons).toMatch(/'acme_tickets\.state'/);
    expect(reasons).toMatch(/gained \('suspended'\)/);
    expect(reasons).toMatch(/refuse at runtime a value the model allows/);
    // What a rebuild must also re-create, named in the refusal itself.
    expect(reasons).toMatch(/derived list indexes/);
    expect(reasons).toMatch(/search-index triggers/);
    expect(reasons).toMatch(/REFERENCES/);
  });

  it('refuses a narrowed enum, and asks about the rows holding the dropped value', () => {
    const narrowed = ticketWith(['new', 'open']);
    expect(accepts(shipped, 'closed')).toBe(true);

    const reasons = reasonsOf(planMigration(narrowed, shipped));
    expect(reasons).toMatch(/lost \('closed'\)/);
    expect(reasons).toMatch(/go on accepting a value the model no longer does/);
    expect(reasons).toMatch(/deciding what happens to rows holding a value the model drops/);
  });

  it('refuses a plain string becoming an enum, and an enum becoming a plain string', () => {
    const asString = defineEntities({
      ticket: { table: 'acme_tickets', fields: z.object({ id: z.string(), title: z.string(), state: z.string() }) },
    });
    expect(reasonsOf(planMigration(asString, shipped))).toMatch(/restricts 'acme_tickets\.state' to .* model admits any value/);
    expect(reasonsOf(planMigration(original, journalOf(asString)))).toMatch(/lets 'acme_tickets\.state' hold any value/);
  });

  it('does not treat a reordered enum as a migration — the values are a set', () => {
    expect(planMigration(ticketWith(['closed', 'new', 'open']), shipped).kind).toBe('up-to-date');
  });

  it('is up to date once a hand-written rebuild carries the new CHECK', () => {
    // The fix the refusal asks for, written the way an append-only journal
    // writes it. The planner reads the rebuilt table, not the original CREATE.
    const widened = ticketWith(['new', 'open', 'closed', 'suspended']);
    const rebuilt: Journal = {
      entries: [
        ...shipped.entries,
        {
          version: '0002',
          slug: 'widen-acme_tickets-state',
          sql: [
            'CREATE TABLE acme_tickets_new (',
            '  id TEXT PRIMARY KEY NOT NULL,',
            '  title TEXT NOT NULL,',
            "  state TEXT NOT NULL CHECK (state IN ('new','open','closed','suspended'))",
            ');',
            'INSERT INTO acme_tickets_new (id, title, state) SELECT id, title, state FROM acme_tickets;',
            'DROP TABLE acme_tickets;',
            'ALTER TABLE acme_tickets_new RENAME TO acme_tickets;',
          ].join('\n'),
        },
      ],
    };
    expect(accepts(rebuilt, 'suspended')).toBe(true);
    expect(planMigration(widened, rebuilt).kind).toBe('up-to-date');
    // ...and the original model is now the one that is out of step.
    expect(reasonsOf(planMigration(original, rebuilt))).toMatch(/lost \('suspended'\)/);
  });

  it('follows a rename this plan emits, rather than reading the renamed enum as changed', () => {
    // SQLite rewrites the CHECK along with the column; the journal still names
    // the old one until the rename is applied.
    const renamed = defineEntities({
      ticket: {
        table: 'acme_tickets',
        fields: z.object({ id: z.string(), title: z.string(), status: z.enum(['new', 'open', 'closed']) }),
        renamedFrom: { status: 'state' },
      },
    });
    const plan = planMigration(renamed, shipped);
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    expect(plan.entry.sql).toBe('ALTER TABLE acme_tickets RENAME COLUMN state TO status;');

    // A rename AND a widening in one change is still the widening's refusal.
    const renamedAndWidened = defineEntities({
      ticket: {
        table: 'acme_tickets',
        fields: z.object({ id: z.string(), title: z.string(), status: z.enum(['new', 'open', 'closed', 'held']) }),
        renamedFrom: { status: 'state' },
      },
    });
    expect(reasonsOf(planMigration(renamedAndWidened, shipped))).toMatch(/'acme_tickets\.status'.*gained \('held'\)/);
  });

  it('plans an enum column added to an existing table, and reads it back as up to date', () => {
    const withPriority = defineEntities({
      ticket: {
        table: 'acme_tickets',
        fields: z.object({
          id: z.string(),
          title: z.string(),
          state: z.enum(['new', 'open', 'closed']),
          priority: z.enum(['low', 'high']).nullable(),
        }),
      },
    });
    const plan = planMigration(withPriority, shipped);
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    const next: Journal = { entries: [...shipped.entries, plan.entry] };
    expect(planMigration(withPriority, next).kind).toBe('up-to-date');
    expect(journalChecks(sqlOf(next)).get('acme_tickets')?.get('priority')).toEqual(["priority in ('low','high')"]);
  });

  it('reads the same CHECK written another way as the same CHECK', () => {
    const handWritten: Journal = {
      entries: [
        {
          version: '0001',
          slug: 'hand-written',
          sql:
            'CREATE TABLE acme_tickets (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, ' +
            '"state" TEXT NOT NULL CHECK ( "STATE"  in ( \'open\' , \'new\', -- a comment\n \'closed\' ) ));',
        },
      ],
    };
    expect(planMigration(original, handWritten).kind).toBe('up-to-date');
  });

  it('leaves a hand-written CHECK the model cannot declare alone', () => {
    // `title <> ''` is not an enum; the model has no way to say it, so its
    // presence in the journal is the journal's business, not a difference.
    const handWritten: Journal = {
      entries: [
        {
          version: '0001',
          slug: 'hand-written',
          sql:
            "CREATE TABLE acme_tickets (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL CHECK (title <> ''), " +
            "state TEXT NOT NULL CHECK (state IN ('new','open','closed')));",
        },
      ],
    };
    expect(planMigration(original, handWritten).kind).toBe('up-to-date');
  });

  it('keeps a value whose case differs as a different value', () => {
    const shouting = ticketWith(['NEW', 'open', 'closed']);
    expect(reasonsOf(planMigration(shouting, shipped))).toMatch(/gained \('NEW'\).*lost \('new'\)/);
  });
});

describe('columnChecks — reading a CHECK out of a stored CREATE TABLE', () => {
  it('attributes column-level CHECKs, and not table-level ones, to their column', () => {
    const checks = columnChecks(
      "CREATE TABLE t (a TEXT CHECK (a IN ('x','y')), b INTEGER NOT NULL CHECK(b > 0) CHECK (b < 10), " +
        'c TEXT, CHECK (c IS NOT NULL OR a IS NULL))',
    );
    expect([...checks]).toEqual([
      ['a', ["a in ('x','y')"]],
      ['b', ['b > 0', 'b < 10']],
    ]);
  });

  it('is not fooled by CHECK inside a string literal or a quoted identifier', () => {
    const checks = columnChecks(
      'CREATE TABLE t ("check" TEXT DEFAULT \'CHECK (x)\', b TEXT NOT NULL DEFAULT \'a, CHECK (b)\')',
    );
    expect(checks.size).toBe(0);
  });

  it('keeps a literal exactly while normalising everything around it', () => {
    expect(normaliseSql("  State  IN ( 'A, b' ,  'it''s' )  ")).toBe("state in ('A, b','it''s')");
  });
});
