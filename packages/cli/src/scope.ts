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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
