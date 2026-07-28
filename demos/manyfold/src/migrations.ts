// ============================================================================
// The Manyfold migration journal — append-only, ordered. A shipped version is
// never edited; new schema is a new entry (see the three-layer rule in
// CLAUDE.md). Kept out of module.ts so the editorial operations read cleanly.
// ============================================================================

export const manyfoldMigrations = [
  {
    version: '0001-init',
    sql: `
      -- The lifecycle spine: one row per logical entry, its status, and which
      -- revision is the working draft vs the frozen published one.
      CREATE TABLE manyfold_entry (
        id            TEXT PRIMARY KEY,
        type_key      TEXT NOT NULL,
        status        TEXT NOT NULL,
        slug          TEXT,
        draft_rev     INTEGER NOT NULL,
        published_rev INTEGER,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX manyfold_entry_slug ON manyfold_entry(type_key, slug) WHERE slug IS NOT NULL;
      CREATE INDEX manyfold_entry_type_status ON manyfold_entry(type_key, status);

      -- Append-only revisions. An edit is a NEW row; freezing sets the hash and
      -- flips frozen=1, after which the row is immutable.
      CREATE TABLE manyfold_revision (
        id         TEXT PRIMARY KEY,
        entry_id   TEXT NOT NULL REFERENCES manyfold_entry(id),
        rev_no     INTEGER NOT NULL,
        body_json  TEXT NOT NULL,
        hash       TEXT,
        frozen     INTEGER NOT NULL DEFAULT 0,
        author     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (entry_id, rev_no)
      );

      -- Append-only transition audit.
      CREATE TABLE manyfold_status_log (
        id          TEXT PRIMARY KEY,
        entry_id    TEXT NOT NULL,
        from_status TEXT,
        to_status   TEXT NOT NULL,
        actor       TEXT NOT NULL,
        note        TEXT,
        at          TEXT NOT NULL
      );

      -- The public read model the delivery surface serves: only published, frozen
      -- content, resolved by (type, slug). Maintained transactionally by publish/
      -- unpublish/archive.
      CREATE TABLE manyfold_delivery (
        entry_id     TEXT PRIMARY KEY,
        type_key     TEXT NOT NULL,
        slug         TEXT,
        rev_no       INTEGER NOT NULL,
        hash         TEXT NOT NULL,
        body_json    TEXT NOT NULL,
        title        TEXT NOT NULL,
        published_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX manyfold_delivery_slug ON manyfold_delivery(type_key, slug) WHERE slug IS NOT NULL;
    `,
  },
  {
    // Content types are DATA, not code — the model builder creates and edits them at
    // runtime. Seeded with the four defaults on first use (ensureTypes). The typed-table
    // migration each type compiles to (compileTypeToSql) stays reviewable/demonstrative;
    // Milestone A persists bodies as JSON, so adding a field is free (no data move).
    version: '0002-content-types',
    sql: `
      CREATE TABLE manyfold_content_type (
        key         TEXT PRIMARY KEY,
        version     INTEGER NOT NULL,
        title       TEXT NOT NULL,
        title_field TEXT NOT NULL,
        slug_field  TEXT,
        fields_json TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `,
  },
];
