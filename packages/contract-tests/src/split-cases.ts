/**
 * The statement-boundary cases `splitSqlStatements` is held to (#2068, Codex #2084 r4): SQLite's
 * own boundary shapes (complete.test) plus the three reproductions the review found. The kernel
 * runs each differentially on node:sqlite — whole blob against statement by statement — and the
 * Durable-Object adapter runs each statement by statement in workerd.
 */
export const SPLIT_CASES: readonly { name: string; sql: string; statements: number }[] = [
  { name: 'plain statements', sql: 'CREATE TABLE a(x); INSERT INTO a VALUES(1);', statements: 2 },
  { name: 'no terminating semicolon', sql: 'CREATE TABLE a(x); INSERT INTO a VALUES(1)', statements: 2 },
  { name: 'a semicolon in a string', sql: "CREATE TABLE a(x); INSERT INTO a VALUES('a;b');", statements: 2 },
  { name: "a doubled quote in a string", sql: "CREATE TABLE a(x); INSERT INTO a VALUES('it''s; fine');", statements: 2 },
  // Reproduction 2: a `;` inside a quoted identifier.
  { name: 'a semicolon in a "quoted" identifier', sql: 'CREATE TABLE "x;y"(a); INSERT INTO "x;y" VALUES(1);', statements: 2 },
  { name: 'a semicolon in [bracketed] and `backquoted` identifiers', sql: 'CREATE TABLE [a;b](x); CREATE TABLE `c;d`(y);', statements: 2 },
  // Reproduction 3: a comment between two keywords must not glue them.
  { name: 'a comment between keywords', sql: 'CREATE/*c*/TABLE t2(a); INSERT/**/INTO t2 VALUES(1);', statements: 2 },
  { name: 'semicolons in comments', sql: 'CREATE TABLE u(a); /* ; */ INSERT INTO u VALUES(1); -- ;\nINSERT INTO u VALUES(2)', statements: 3 },
  { name: 'a trailing comment only', sql: 'CREATE TABLE a(x); -- the end; really', statements: 1 },
  { name: 'only whitespace and comments', sql: ' -- nothing ;\n /* ; */ ', statements: 0 },
  { name: 'empty statements', sql: ';;CREATE TABLE a(x);;;', statements: 1 },
  {
    name: 'a trigger body',
    sql: 'CREATE TABLE t(a, b); CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET b = 1; UPDATE t SET b = b + 1; END; INSERT INTO t(a) VALUES(1);',
    statements: 3,
  },
  // Reproduction 1: `CASE … END;` inside a trigger body is not the trigger's END.
  {
    name: 'CASE … END inside a trigger body',
    sql:
      'CREATE TABLE t(a, b); CREATE TRIGGER tr AFTER INSERT ON t BEGIN ' +
      'UPDATE t SET b = CASE WHEN new.a > 0 THEN 1 ELSE 0 END; UPDATE t SET b = b + 10; END; ' +
      'INSERT INTO t(a) VALUES(5);',
    statements: 3,
  },
  {
    name: 'a TEMP trigger, and END as a quoted name',
    sql: 'CREATE TABLE e("end" TEXT); CREATE TEMP TRIGGER te AFTER INSERT ON e BEGIN UPDATE e SET "end" = \'x;\'; END; INSERT INTO e VALUES(\'y\');',
    statements: 3,
  },
  {
    name: 'END as a quoted name inside a trigger body',
    sql: 'CREATE TABLE e2("end" TEXT); CREATE TRIGGER te2 AFTER INSERT ON e2 BEGIN UPDATE e2 SET "end" = \'x;\'; END; INSERT INTO e2 VALUES(\'y\');',
    statements: 3,
  },
  {
    name: 'a trigger whose body raises with a semicolon in the message',
    sql: "CREATE TABLE t(a); CREATE TRIGGER g BEFORE DELETE ON t BEGIN SELECT RAISE(ABORT, 'no; end'); END; INSERT INTO t VALUES(1);",
    statements: 3,
  },
  { name: 'a word that only contains TRIGGER', sql: 'CREATE TABLE triggers(a); INSERT INTO triggers VALUES(1);', statements: 2 },
  { name: 'a non-ASCII identifier', sql: 'CREATE TABLE tråd(ö); INSERT INTO tråd VALUES(1);', statements: 2 },
  {
    name: 'an fts5 table and the derived-index trigger shape',
    sql:
      "CREATE TABLE d(body); CREATE VIRTUAL TABLE dx USING fts5(body, content='d', content_rowid='rowid');" +
      'CREATE TRIGGER d_ai AFTER INSERT ON d BEGIN INSERT INTO dx(rowid, body) VALUES (new.rowid, new.body); END;' +
      "INSERT INTO d VALUES('hello; world');",
    statements: 4,
  },
];
