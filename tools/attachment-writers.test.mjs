import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WINDOW, findBypasses } from './attachment-writers.mjs';

const checked = `
  refuseCondemnedAttachment(sql, record.id);
  sql.exec(\`INSERT INTO _substrat_attachments (id) VALUES (?)\`, record.id);
`;

test('an insert with its check before it passes', () => {
  assert.deepEqual(findBypasses([{ path: 'packages/a/src/x.ts', text: checked }]), []);
});

test('an insert with no check is refused, with its line', () => {
  const text = `\n\nsql.exec('INSERT INTO _substrat_attachments (id) VALUES (?)', id);\n`;
  assert.deepEqual(findBypasses([{ path: 'packages/a/src/x.ts', text }]), [
    'packages/a/src/x.ts:3: an attachment row is written without refuseCondemnedAttachment() before it',
  ]);
});

test('INSERT OR REPLACE, REPLACE INTO and a quoted name are writers too', () => {
  for (const sql of [
    'INSERT OR REPLACE INTO _substrat_attachments (id) VALUES (?)',
    'replace into _substrat_attachments (id) values (?)',
    'INSERT INTO "_substrat_attachments" (id) VALUES (?)',
  ]) {
    assert.equal(findBypasses([{ path: 'packages/a/src/x.ts', text: sql }]).length, 1, sql);
  }
});

test('a check further back than the window does not count', () => {
  const text = `refuseCondemnedAttachment(sql, id);${' '.repeat(WINDOW)}INSERT INTO _substrat_attachments (id) VALUES (?)`;
  assert.equal(findBypasses([{ path: 'packages/a/src/x.ts', text }]).length, 1);
});

test('another table whose name starts the same is not an attachment row', () => {
  const text = 'INSERT INTO _substrat_attachments_text (id) VALUES (?); INSERT INTO _substrat_attachment_condemned (id) VALUES (?)';
  assert.deepEqual(findBypasses([{ path: 'packages/a/src/x.ts', text }]), []);
});

test('a dump load must refuse condemned ids; the replayer\'s definition is not a load', () => {
  const load = 'for (const t of tables) db.exec(dumpRowsInsert(t, columnsOf));';
  assert.equal(findBypasses([{ path: 'packages/a/src/load.ts', text: load }]).length, 1);
  assert.deepEqual(
    findBypasses([{ path: 'packages/a/src/load.ts', text: `refuseCondemnedInDump(sql, tables);\n${load}` }]),
    [],
  );
  assert.deepEqual(findBypasses([{ path: 'packages/kernel/src/spine-restore.ts', text: 'export function dumpRowsInsert(' }]), []);
});

test('tests and built output are not shipped writers', () => {
  const text = 'INSERT INTO _substrat_attachments (id) VALUES (?)';
  for (const path of ['packages/a/test/x.test.ts', 'packages/a/src/x.test.ts', 'packages/a/dist/x.js', 'tools/x.mjs']) {
    assert.deepEqual(findBypasses([{ path, text }]), [], path);
  }
});
