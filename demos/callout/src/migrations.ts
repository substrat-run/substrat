// ============================================================================
// The Callout migration journal — append-only, ordered. A shipped version is
// never edited; new schema is a new entry (see the three-layer rule in
// CLAUDE.md). Kept out of module.ts so the operations read cleanly.
// ============================================================================

export const calloutMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE callout_customers (
        id          TEXT PRIMARY KEY,
        number      TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        org_ref     TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE callout_facilities (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES callout_customers(id),
        name        TEXT NOT NULL,
        address     TEXT,
        access_note TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE callout_price_list (
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
  // 0002-protocols shipped at milestone A when protocols were VERTICAL code
  // (engine-protocol.md §2). The journal is append-only: this version stays
  // verbatim forever, even though the tables it creates are legacy since 0003.
  {
    version: '0002-protocols',
    sql: `
    CREATE TABLE callout_protocol_templates (
      id           TEXT PRIMARY KEY,
      key          TEXT NOT NULL,
      version      INTEGER NOT NULL,
      title        TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      UNIQUE (key, version)
    );
    CREATE TABLE callout_protocol_instances (
      id               TEXT PRIMARY KEY,
      template_key     TEXT NOT NULL,
      template_version INTEGER NOT NULL,
      entity_type      TEXT NOT NULL,
      entity_id        TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('open','signed','voided')),
      created_by       TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      voided_by        TEXT,
      voided_reason    TEXT,
      voided_at        TEXT
    );
    CREATE TABLE callout_protocol_responses (
      id           TEXT PRIMARY KEY,
      instance_id  TEXT NOT NULL REFERENCES callout_protocol_instances(id),
      item_key     TEXT NOT NULL,
      value_json   TEXT NOT NULL,
      note         TEXT,
      responded_by TEXT NOT NULL,
      responded_at TEXT NOT NULL
    );
    CREATE TABLE callout_protocol_signatures (
      id           TEXT PRIMARY KEY,
      instance_id  TEXT NOT NULL REFERENCES callout_protocol_instances(id),
      signed_by    TEXT NOT NULL,
      method       TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      evidence_ref TEXT,
      signed_at    TEXT NOT NULL
    );
  `,
  },
  // 0003 — MILESTONE B, the extraction's migration consequence (human
  // checkpoint material): protocol data moves from the vertical's milestone-A
  // tables into the engine's tables, then the legacy tables are dropped.
  // Signed documents keep their ids, hashes and timestamps — the content_hash
  // recipe is unchanged, so every existing signature stays verifiable.
  // ORDERING CONTRACT: @substrat-run/engine-protocol must be registered on
  // the host BEFORE this module so its 0001-init (which creates protocol_*)
  // is journaled first; a wrong order fails closed at migration time.
  // On fresh scopes 0002 + 0003 replay as create-copy-nothing-drop — the
  // honest cost of an append-only journal.
  // boundary-lint-allow R5 — extraction handoff (decision 27): the one-time move
  // of milestone-A data into the engine's tables; the only sanctioned write to
  // another module's schema.
  {
    version: '0003-protocols-to-engine',
    sql: `
    INSERT INTO protocol_templates (id, key, version, title, content_json, created_at)
      SELECT id, key, version, title, content_json, created_at
      FROM callout_protocol_templates;
    INSERT INTO protocol_instances
      (id, template_key, template_version, entity_type, entity_id, status,
       created_by, created_at, voided_by, voided_reason, voided_at)
      SELECT id, template_key, template_version, entity_type, entity_id, status,
             created_by, created_at, voided_by, voided_reason, voided_at
      FROM callout_protocol_instances;
    INSERT INTO protocol_responses
      (id, instance_id, item_key, value_json, note, responded_by, responded_at)
      SELECT id, instance_id, item_key, value_json, note, responded_by, responded_at
      FROM callout_protocol_responses;
    INSERT INTO protocol_signatures
      (id, instance_id, signed_by, kind, method, content_hash, evidence_ref, signed_at)
      SELECT id, instance_id, signed_by, 'primary', method, content_hash, evidence_ref, signed_at
      FROM callout_protocol_signatures;
    DROP TABLE callout_protocol_signatures;
    DROP TABLE callout_protocol_responses;
    DROP TABLE callout_protocol_instances;
    DROP TABLE callout_protocol_templates;
  `,
  },
  // boundary-lint-end R5
];
