/**
 * `substrat scope pull <scopeId>` — bring a scope's data to the local inner loop
 * (preview-and-snapshots.md §8; the substrat analog of `vercel env pull`).
 *
 * The pull crosses the platform's trust boundary ON PURPOSE, so the server side is
 * the gate: staff-gated, audited, jurisdiction-checked, and MASKED by default —
 * `--full` is the explicit break-glass for full fidelity. This end only receives
 * what the gate released and writes it to a file.
 *
 * The file is a REAL SQLite database named `<tenantId>__<scopeId>.sqlite` — exactly
 * the shape `@substrat-run/adapter-sqlite` stores scopes in, so a local harness can
 * run the identical vertical against it. Written with `node:sqlite` (node 22.13+);
 * on an older node the dump lands as JSON next to where the db would have been.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchWhoami } from './whoami.js';

interface DumpTable {
  name: string;
  ddl: string;
  columns: string[];
  rows: unknown[][];
}

interface PulledDump {
  tenantId: string;
  scopeId: string;
  capturedAt: string;
  masked: boolean;
  tables: DumpTable[];
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** Resolve `--tenant` (id or slug) / the stored default slug to a tenant ID. */
export async function resolveTenantId(
  controlPlaneUrl: string,
  header: Record<string, string>,
  tenant: string | undefined,
): Promise<string> {
  if (!tenant) {
    throw new Error('no tenant — pass --tenant <id-or-slug> or set a default with `substrat login`');
  }
  if (ULID.test(tenant)) return tenant.toUpperCase();
  const { tenants } = await fetchWhoami(controlPlaneUrl, header);
  const match = tenants.find((t) => t.slug === tenant || t.id === tenant);
  if (!match) {
    throw new Error(
      `workspace '${tenant}' is not one of yours — pass --tenant with a tenant id, or check \`substrat whoami\``,
    );
  }
  return match.id;
}

/** SQLite bind values are null/string/number/bigint; anything else stringifies. */
const bindable = (v: unknown): null | string | number | bigint =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint'
    ? (v as null | string | number | bigint)
    : JSON.stringify(v);

/** Write the dump as a real SQLite file. False when node:sqlite is unavailable. */
async function writeSqlite(path: string, dump: PulledDump): Promise<boolean> {
  let DatabaseSync: (typeof import('node:sqlite'))['DatabaseSync'];
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return false; // node < 22.13 — the caller falls back to JSON
  }
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    for (const t of dump.tables) {
      db.exec(t.ddl);
      if (t.rows.length === 0) continue;
      const cols = t.columns.map((c) => `"${c}"`).join(', ');
      const marks = t.columns.map(() => '?').join(', ');
      const stmt = db.prepare(`INSERT INTO "${t.name}" (${cols}) VALUES (${marks})`);
      for (const row of t.rows) stmt.run(...row.map(bindable));
    }
  } finally {
    db.close();
  }
  return true;
}

export async function pullScope(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  tenantId: string;
  scopeId: string;
  full: boolean;
  outDir: string;
}): Promise<void> {
  const url =
    `${opts.controlPlaneUrl}/tenants/${encodeURIComponent(opts.tenantId)}` +
    `/scopes/${encodeURIComponent(opts.scopeId)}/export${opts.full ? '?full=true' : ''}`;
  const res = await fetch(url, { headers: opts.header });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `pull refused: ${res.status} ${res.statusText}`);
  }
  const dump = (await res.json()) as PulledDump;

  mkdirSync(opts.outDir, { recursive: true });
  const base = join(opts.outDir, `${dump.tenantId}__${dump.scopeId}`);
  const rows = dump.tables.reduce((n, t) => n + t.rows.length, 0);

  const wroteSqlite = await writeSqlite(`${base}.sqlite`, dump);
  const file = wroteSqlite ? `${base}.sqlite` : `${base}.dump.json`;
  if (!wroteSqlite) {
    writeFileSync(file, JSON.stringify(dump, null, 2));
  }

  console.log(`✓ pulled ${dump.tables.length} tables (${rows} rows), captured ${dump.capturedAt}`);
  console.log(`  → ${file}`);
  if (!wroteSqlite) {
    console.log('  (JSON fallback — node 22.13+ writes a ready-to-run .sqlite instead)');
  }
  if (dump.masked) {
    console.log('  masked: PII columns are redacted — pass --full for a break-glass full pull');
  } else {
    console.log('  ⚠ FULL-FIDELITY pull: this file contains real customer data.');
    console.log('    Treat it as production data — do not share it, delete it when done.');
  }
}

/** Read a dump from disk: a real `.sqlite` file (node:sqlite), or a `.dump.json`. */
async function readDump(file: string): Promise<{ tables: DumpTable[] }> {
  if (!file.endsWith('.sqlite')) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { tables?: DumpTable[] };
    if (!Array.isArray(parsed.tables)) throw new Error(`${file} is not a scope dump (no tables)`);
    return { tables: parsed.tables };
  }
  let DatabaseSync: (typeof import('node:sqlite'))['DatabaseSync'];
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error('reading a .sqlite backup needs node 22.13+ (node:sqlite) — or pass a .dump.json');
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables: DumpTable[] = [];
    const rows = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string; sql: string }[];
    for (const t of rows) {
      const cols = (db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[]).map((c) => c.name);
      const data = db.prepare(`SELECT * FROM "${t.name}"`).all() as Record<string, unknown>[];
      tables.push({ name: t.name, ddl: t.sql, columns: cols, rows: data.map((r) => cols.map((c) => r[c])) });
    }
    return { tables };
  } finally {
    db.close();
  }
}

/**
 * `substrat scope restore <scopeId> --file <backup>` — the write half of `pull`
 * (preview-and-snapshots.md §8): load a backup into an EXISTING hosted scope,
 * REPLACING its data wholesale. The backup can be a `.sqlite` file (a `scope pull`
 * output, or a local `@substrat-run/adapter-sqlite` scope file — same shape) or a
 * `.dump.json`. The server side is the gate: staff-gated and audited; the restore
 * lands in the deployment the router actually serves the scope from.
 */
export async function restoreScope(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  tenantId: string;
  scopeId: string;
  file: string;
}): Promise<void> {
  const { tables } = await readDump(opts.file);
  const rows = tables.reduce((n, t) => n + t.rows.length, 0);
  const res = await fetch(
    `${opts.controlPlaneUrl}/tenants/${encodeURIComponent(opts.tenantId)}` +
      `/scopes/${encodeURIComponent(opts.scopeId)}/restore`,
    {
      method: 'POST',
      headers: { ...opts.header, 'content-type': 'application/json' },
      // tenantId/scopeId in the body are PROVENANCE (where the backup came from);
      // the URL says where it lands — same rule as the host primitive.
      body: JSON.stringify({
        tenantId: opts.tenantId,
        scopeId: opts.scopeId,
        capturedAt: new Date().toISOString(),
        tables,
      }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `restore refused: ${res.status} ${res.statusText}`);
  }
  console.log(`✓ restored ${tables.length} tables (${rows} rows) into scope ${opts.scopeId}`);
  console.log('  the scope now serves the backup — its previous data was replaced.');
}
