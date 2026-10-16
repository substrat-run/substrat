import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPUTED_TARGETS, findBypasses } from './attachment-writers.mjs';

const at = (text, path = 'packages/a/src/x.ts', targets = {}) => findBypasses([{ path, text }], targets);

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

// Round 3: every spelling of a writer, and every target the text cannot name.

const WRITE = 'an attachment row is written without its own refuseCondemnedAttachment() before it, in its function';

test('a quoted or schema-qualified table name is the same table', () => {
  for (const target of [
    'main._substrat_attachments',
    '"main"."_substrat_attachments"',
    '[_substrat_attachments]',
    '"_substrat_attachments"',
    'main . [_substrat_attachments]',
  ]) {
    assert.deepEqual(at(`function f(db) { db.exec('INSERT INTO ${target} (id) VALUES (?)'); }`), [
      `packages/a/src/x.ts:1: ${WRITE}`,
    ], target);
  }
});

test('a backtick-quoted table name inside a string is the same table', () => {
  const text = "function f(db) { db.exec(\"INSERT INTO `_substrat_attachments` (id) VALUES (?)\"); }";
  assert.equal(at(text).length, 1);
});

test('an UPDATE of the attachments table is a writer, guarded like an insert', () => {
  assert.equal(at("function f(db) { db.exec('UPDATE _substrat_attachments SET id = ? WHERE id = ?'); }").length, 1);
  assert.equal(at("function f(db) { db.exec('UPDATE OR REPLACE main._substrat_attachments SET filename = ?'); }").length, 1);
  assert.deepEqual(at("function f(db, id) { refuseCondemnedAttachment(db, id); db.exec('UPDATE _substrat_attachments SET id = ?', id); }"), []);
});

test('a concatenated INSERT target is refused', () => {
  const text = "function f(db, t) { db.exec('INSERT INTO ' + t + ' (id) VALUES (?)'); }";
  assert.equal(at(text).length, 1);
  assert.match(at(text)[0], /computed/);
});

test('an interpolated INSERT target is refused, a constant one included, quoted or qualified', () => {
  for (const target of ['${table}', '"${t.name}"', '[${t}]', 'main.${t}', '${ATTACHMENTS_TABLE}']) {
    const text = `const ATTACHMENTS_TABLE = '_substrat_attachments';\nfunction f(db, t, table) { db.exec(\`INSERT INTO ${target} (id) VALUES (?)\`); }`;
    assert.equal(at(text).length, 1, target);
  }
  // INSERT OR IGNORE INTO ${x} too.
  assert.equal(at('function f(db, t) { db.exec(`INSERT OR IGNORE INTO ${t} (id) VALUES (?)`); }').length, 1);
});

test('a computed target guarded by refuseCondemnedInDump passes, and so does one in an allowlisted file', () => {
  const guarded = 'function load(db, tables) { refuseCondemnedInDump(db, tables); for (const t of tables) db.exec(`INSERT INTO "${t.name}" VALUES (?)`); }';
  assert.deepEqual(at(guarded), []);
  const listed = 'function f(db, t) { db.exec(`INSERT INTO ${t} (id) VALUES (?)`); }';
  assert.deepEqual(at(listed, 'packages/a/src/x.ts', { 'packages/a/src/x.ts': 'a reason' }), []);
});

test('an allowlist entry whose file computes no target any more is refused', () => {
  assert.deepEqual(at('function f() {}', 'packages/a/src/x.ts', { 'packages/a/src/x.ts': 'a reason' }), [
    'packages/a/src/x.ts: is in COMPUTED_TARGETS but computes no INSERT target any more; remove the entry',
  ]);
});

test('every COMPUTED_TARGETS entry carries a reason', () => {
  for (const [path, reason] of Object.entries(COMPUTED_TARGETS)) assert.ok(reason.length > 10, path);
});

test('the replayer under another name (an import alias, a binding) needs its guard too', () => {
  const aliased = "import { dumpRowsInsert as replay } from '@substrat-run/kernel';\nfunction load(db, tables) { for (const t of tables) db.exec(replay(t, cols)); }";
  assert.equal(at(aliased).length, 1);
  const bound = 'const rowsOf = dumpRowsInsert;\nfunction load(db, tables) { for (const t of tables) db.exec(rowsOf(t, cols)); }';
  assert.equal(at(bound).length, 1);
  const guarded = "import { dumpRowsInsert as replay } from '@substrat-run/kernel';\nfunction load(db, tables) { refuseCondemnedInDump(db, tables); for (const t of tables) db.exec(replay(t, cols)); }";
  assert.deepEqual(at(guarded), []);
  // An alias declared in one file reaches a call in another.
  const files = [
    { path: 'packages/a/src/reexport.ts', text: "export { dumpRowsInsert as replayRows } from '@substrat-run/kernel';" },
    { path: 'packages/a/src/load.ts', text: 'function load(db, tables) { for (const t of tables) db.exec(replayRows(t, cols)); }' },
  ];
  assert.equal(findBypasses(files, {}).length, 1);
});

test('every source extension is read: .tsx, .cts, .cjs, .mjs, .js; a declaration file is not', () => {
  const text = "function f(db) { db.exec('INSERT INTO _substrat_attachments (id) VALUES (?)'); }";
  for (const ext of ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs']) assert.equal(at(text, `packages/a/src/x.${ext}`).length, 1, ext);
  assert.deepEqual(at(text, 'packages/a/src/x.d.ts'), []);
});
