/**
 * GENERATED from journal.json — do not edit.
 *
 * The journal is the record; this is the shape the kernel registers. Append a
 * migration by changing spec/model.ts and re-running:
 *
 *     pnpm --filter @substrat-run/demo-todo emit:migrations
 */
import type { SqlMigration } from '@substrat-run/kernel';

export const todoMigrations: SqlMigration[] = [
  {
    // add-todo_owners-and-3-more
    version: '0001',
    sql: `
      CREATE TABLE todo_owners (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (email)
      );

      CREATE TABLE todo_lists (
        id TEXT PRIMARY KEY NOT NULL,
        owner_id TEXT NOT NULL REFERENCES todo_owners(id),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE todo_shares (
        id TEXT PRIMARY KEY NOT NULL,
        list_id TEXT NOT NULL REFERENCES todo_lists(id),
        principal TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (list_id, principal)
      );

      CREATE TABLE todo_items (
        id TEXT PRIMARY KEY NOT NULL,
        list_id TEXT NOT NULL REFERENCES todo_lists(id),
        text TEXT NOT NULL,
        done INTEGER NOT NULL,
        added_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
];
