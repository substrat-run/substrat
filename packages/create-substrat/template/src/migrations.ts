import type { SqlMigration } from '@substrat-run/kernel';

// ============================================================================
// The vertical's OWN tables, prefixed `shop_` so they can never collide with an
// engine's. Ids are TEXT (ULIDs), timestamps ISO-8601 TEXT, money/decimals TEXT
// — never a float, never a native DATE. Migrations are append-only and ordered:
// once a version has shipped, you add a new one, you never edit it.
// ============================================================================

export const bikeShopMigrations: SqlMigration[] = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE shop_customers (
        id          TEXT PRIMARY KEY,
        number      TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        phone       TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE shop_bikes (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES shop_customers(id),
        label       TEXT NOT NULL,
        frame_no    TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE shop_price_list (
        article      TEXT PRIMARY KEY,
        description  TEXT NOT NULL,
        unit         TEXT NOT NULL,
        price_amount TEXT NOT NULL,
        currency     TEXT NOT NULL DEFAULT 'SEK',
        min_qty      TEXT,
        internal     INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];
