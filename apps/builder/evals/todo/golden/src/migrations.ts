import type { SqlMigration } from '@substrat-run/kernel';

export const listsMigrations: SqlMigration[] = [
  {
    version: '0001',
    sql: `
      CREATE TABLE lists_people (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (email)
      );

      CREATE TABLE lists_lists (
        id TEXT PRIMARY KEY NOT NULL,
        owner_id TEXT NOT NULL REFERENCES lists_people(id),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE lists_items (
        id TEXT PRIMARY KEY NOT NULL,
        list_id TEXT NOT NULL REFERENCES lists_lists(id),
        text TEXT NOT NULL,
        done INTEGER NOT NULL,
        done_by TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE lists_shares (
        id TEXT PRIMARY KEY NOT NULL,
        list_id TEXT NOT NULL REFERENCES lists_lists(id),
        principal TEXT NOT NULL,
        email TEXT NOT NULL,
        shared_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (list_id, principal)
      );

      CREATE TABLE lists_invites (
        id TEXT PRIMARY KEY NOT NULL,
        list_id TEXT NOT NULL REFERENCES lists_lists(id),
        email TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (list_id, email)
      );
    `,
  },
];
