import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBypasses } from './attachment-writers.mjs';

const at = (text, path = 'packages/a/src/x.ts') => findBypasses([{ path, text }]);

const checked = `
async function add(sql, record) {
  refuseCondemnedAttachment(sql, record.id);
  sql.exec(\`INSERT INTO _substrat_attachments (id) VALUES (?)\`, record.id);
}
`;

test('an insert with its check before it, in its function, passes', () => {
  assert.deepEqual(at(checked), []);
});

test('an insert with no check is refused, with its line', () => {
  const text = `\nfunction add(sql, id) {\n  sql.exec('INSERT INTO _substrat_attachments (id) VALUES (?)', id);\n}\n`;
  assert.deepEqual(at(text), [
    'packages/a/src/x.ts:3: an attachment row is written without its own refuseCondemnedAttachment() before it, in its function',
  ]);
});

test('a guard in a SIBLING function does not cover an insert in another', () => {
  const text = `
function guarded(sql, id) {
  refuseCondemnedAttachment(sql, id);
  sql.exec('INSERT INTO _substrat_attachments (id) VALUES (?)', id);
}
const unguarded = (sql, id) => {
  sql.exec('INSERT INTO _substrat_attachments (id) VALUES (?)', id);
};
`;
  assert.deepEqual(at(text), [
    'packages/a/src/x.ts:7: an attachment row is written without its own refuseCondemnedAttachment() before it, in its function',
  ]);
});

test('a guard in one arrow callback does not cover an insert in a sibling arrow inside the same function', () => {
  const text = `
function surface(sql, id) {
  const check = () => {
    refuseCondemnedAttachment(sql, id);
  };
  const write = async () => {
    sql.exec('INSERT INTO _substrat_attachments (id) VALUES (?)', id);
  };
  return { check, write };
}
`;
  assert.equal(at(text).length, 1);
});

test('a guard whose function has ended does not cover a later function, even right after it', () => {
  const text = `
class Host {
  check(sql, id): void { refuseCondemnedAttachment(sql, id); }
  async write(sql, id): Promise<void> { sql.exec('INSERT INTO _substrat_attachments (id) VALUES (?)', id); }
}
`;
  assert.equal(at(text).length, 1);
});

test('one guard covers one insert: two inserts after one guard leave the second refused', () => {
  const text = `
function add(sql, a, b) {
  refuseCondemnedAttachment(sql, a);
  sql.exec('INSERT INTO _substrat_attachments (id) VALUES (?)', a);
  sql.exec('INSERT INTO _substrat_attachments (id) VALUES (?)', b);
}
`;
  assert.equal(at(text).length, 1);
});

test('a guard in an enclosing function covers an insert in a callback inside it; one after the insert does not', () => {
  const inside = `
async function add(ctx, sql, id) {
  refuseCondemnedAttachment(sql, id);
  await ctx.transaction(async () => {
    if (id) {
      sql.exec(\`INSERT INTO _substrat_attachments (id) VALUES (?)\`, id);
    }
  });
}
`;
  assert.deepEqual(at(inside), []);
  const after = `
function add(sql, id) {
  sql.exec('INSERT INTO _substrat_attachments (id) VALUES (?)', id);
  refuseCondemnedAttachment(sql, id);
}
`;
  assert.equal(at(after).length, 1);
});

test('a guard written in a string or a comment is not a call', () => {
  const text = `
function add(sql, id) {
  // refuseCondemnedAttachment(sql, id);
  const note = 'refuseCondemnedAttachment(sql, id)';
  sql.exec('INSERT INTO _substrat_attachments (id) VALUES (?)', id);
}
`;
  assert.equal(at(text).length, 1);
});

test('INSERT OR REPLACE, REPLACE INTO and a quoted name are writers too', () => {
  for (const sql of [
    'INSERT OR REPLACE INTO _substrat_attachments (id) VALUES (?)',
    'replace into _substrat_attachments (id) values (?)',
    'INSERT INTO "_substrat_attachments" (id) VALUES (?)',
  ]) {
    assert.equal(at(`function f(db) { db.exec(\`${sql}\`); }`).length, 1, sql);
  }
});

test('another table whose name starts the same is not an attachment row', () => {
  const text = "function f(db) { db.exec('INSERT INTO _substrat_attachments_text (id) VALUES (?)'); db.exec('INSERT INTO _substrat_attachment_condemned (id) VALUES (?)'); }";
  assert.deepEqual(at(text), []);
});

test('a dump replay needs its own guard in its function or one around it; a sibling\'s does not count', () => {
  const guarded = `
function load(db, tables) {
  refuseCondemnedInDump(db, tables);
  db.transaction(() => {
    for (const t of tables) db.exec(dumpRowsInsert(t, columnsOf));
  });
}
`;
  assert.deepEqual(at(guarded), []);
  const sibling = `
function check(db, tables) { refuseCondemnedInDump(db, tables); }
function load(db, tables) {
  for (const t of tables) db.exec(dumpRowsInsert(t, columnsOf));
}
`;
  assert.deepEqual(at(sibling), [
    'packages/a/src/x.ts:4: a dump load replays rows without refuseCondemnedInDump() before them, in its function',
  ]);
  assert.deepEqual(at('export function dumpRowsInsert(table, columnsOf) { return ""; }', 'packages/kernel/src/spine-restore.ts'), []);
});

test('tests and built output are not shipped writers', () => {
  const text = "function f(db) { db.exec('INSERT INTO _substrat_attachments (id) VALUES (?)'); }";
  for (const path of ['packages/a/test/x.test.ts', 'packages/a/src/x.test.ts', 'packages/a/dist/x.js', 'tools/x.mjs']) {
    assert.deepEqual(at(text, path), [], path);
  }
});
