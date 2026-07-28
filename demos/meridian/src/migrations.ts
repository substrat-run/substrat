// ============================================================================
// The Meridian migration journal — append-only, ordered. A shipped version is
// never edited; new schema is a new entry (see the three-layer rule in
// CLAUDE.md). Kept out of module.ts so the operations read cleanly.
// ============================================================================

export const meridianMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE hr_employees (
        id            TEXT PRIMARY KEY,
        number        TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        email         TEXT,
        national_id   TEXT,            -- PII: crypto-shred target (spec §8)
        principal_ref TEXT,            -- the login principal, if this person has one
        started_at    TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE TABLE hr_leave_types (
        key         TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        kind        TEXT NOT NULL,     -- vacation | sick | vab | parental | ...
        annual_days TEXT,             -- statutory entitlement, decimal string
        created_at  TEXT NOT NULL
      );
      -- The absence ledger is APPEND-ONLY: an accrual, a booking, a correction,
      -- or a carryover is a new row, never an edit. Balance is a fold of delta.
      CREATE TABLE hr_absence_ledger (
        id             TEXT PRIMARY KEY,
        employee_id    TEXT NOT NULL REFERENCES hr_employees(id),
        leave_type_key TEXT NOT NULL REFERENCES hr_leave_types(key),
        entry_kind     TEXT NOT NULL CHECK (entry_kind IN ('accrual','booking','correction','carryover')),
        delta          TEXT NOT NULL, -- signed decimal days; balance = SUM(delta)
        effective_date TEXT NOT NULL,
        request_id     TEXT,          -- the approved request that produced a booking
        note           TEXT,
        created_by     TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE hr_leave_requests (
        id             TEXT PRIMARY KEY,
        employee_id    TEXT NOT NULL REFERENCES hr_employees(id),
        leave_type_key TEXT NOT NULL REFERENCES hr_leave_types(key),
        start_date     TEXT NOT NULL,
        end_date       TEXT NOT NULL,
        days           TEXT NOT NULL, -- decimal
        status         TEXT NOT NULL CHECK (status IN ('requested','approved','rejected','cancelled')),
        decided_by     TEXT,
        decided_at     TEXT,
        note           TEXT,
        created_by     TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE hr_projects (
        id         TEXT PRIMARY KEY,
        code       TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- Time entries are APPEND-ONLY too — the second ledger of the same shape.
      CREATE TABLE hr_time_entries (
        id          TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES hr_employees(id),
        project_id  TEXT REFERENCES hr_projects(id),
        work_date   TEXT NOT NULL,
        hours       TEXT NOT NULL,   -- decimal
        note        TEXT,
        created_by  TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE hr_expenses (
        id          TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES hr_employees(id),
        project_id  TEXT REFERENCES hr_projects(id),
        description TEXT NOT NULL,
        amount      TEXT NOT NULL,   -- decimal
        currency    TEXT NOT NULL,
        category    TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('submitted','approved','rejected','exported')),
        decided_by  TEXT,
        decided_at  TEXT,
        created_by  TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE hr_holidays (
        id           TEXT PRIMARY KEY,
        holiday_date TEXT NOT NULL,
        name         TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
    `,
  },
  // 0002 — the anställningsavtal's TERMS. This vertical owns the content of the
  // employment contract; the protocol engine only ever sees its hash.
  //
  // Append-only, like the absence ledger: renegotiated terms are a NEW row and
  // latest-per-employee wins. A signed contract pinned the hash of the row that
  // was current when it was issued, so an edit-in-place would silently move what
  // somebody signed — the same reason protocol templates version rather than
  // update.
  {
    version: '0002-employment-terms',
    sql: `
      CREATE TABLE hr_employment_terms (
        id             TEXT PRIMARY KEY,
        employee_id    TEXT NOT NULL,
        role_title     TEXT NOT NULL,
        monthly_salary TEXT NOT NULL,   -- decimal string, never a float (K-14)
        currency       TEXT NOT NULL,
        scope_pct      TEXT NOT NULL,   -- sysselsättningsgrad: '100', '80'
        start_date     TEXT NOT NULL,
        notice_months  TEXT NOT NULL,
        created_by     TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX hr_employment_terms_by_employee
        ON hr_employment_terms (employee_id);
    `,
  },
];
