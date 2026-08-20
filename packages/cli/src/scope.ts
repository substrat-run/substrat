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
import { readJson } from './http.js';
import { orderTablesByForeignKeys } from './dump-order.js';

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
    // Insert parents before children — this writer defers no FK check, so an
    // FK-unordered dump would trip a constraint on the first child row.
    for (const t of orderTablesByForeignKeys(dump.tables)) {
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
  const dump = await readJson<PulledDump>(res, url);

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
    // FK-order before we POST — the server inserts in the order it receives, and an
    // older control plane defers no FK check, so parents must arrive before children.
    return { tables: orderTablesByForeignKeys(parsed.tables) };
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
    return { tables: orderTablesByForeignKeys(tables) };
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
    // The CP shapes an unloadable-dump failure as `{ error, detail }` (#321); surface the detail
    // too, or the builder sees only a generic message and can't act on it (#332).
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
    const base = body?.error ?? `restore refused: ${res.status} ${res.statusText}`;
    throw new Error(body?.detail ? `${base} — ${body.detail}` : base);
  }
  console.log(`✓ restored ${tables.length} tables (${rows} rows) into scope ${opts.scopeId}`);
  console.log('  the scope now serves the backup — its previous data was replaced.');
}

/**
 * `substrat scope adopt-serving <scopeId>` — the builder-triggerable backfill (#286/#321):
 * move a LEGACY scope's data off its per-version dispatch script onto its vertical's stable
 * serving script, so a promote stops re-stranding it. Idempotent: an already-adopted scope
 * reports so and does nothing. Server-side is the gate (staff/owner, audited).
 */
export async function adoptScopeServing(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  tenantId: string;
  scopeId: string;
}): Promise<void> {
  const res = await fetch(
    `${opts.controlPlaneUrl}/tenants/${encodeURIComponent(opts.tenantId)}` +
      `/scopes/${encodeURIComponent(opts.scopeId)}/adopt-serving`,
    { method: 'POST', headers: { ...opts.header, 'content-type': 'application/json' } },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `adopt-serving refused: ${res.status} ${res.statusText}`);
  }
  const body = await readJson<{ servingRef?: string; alreadyAdopted?: boolean; tables?: number }>(res, res.url);
  if (body.alreadyAdopted) {
    console.log(`✓ scope ${opts.scopeId} already serves from ${body.servingRef} — nothing to do.`);
  } else {
    console.log(`✓ adopted scope ${opts.scopeId} onto ${body.servingRef} (${body.tables ?? 0} tables moved).`);
  }
}

/**
 * `substrat scope provision <scopeId>` — recover a scope stuck at "roles projected, zero tuples"
 * (#332): the enforcement flip switched on against an empty tuple table, so every login denies and
 * the owner is locked out with no lever. This re-runs the vertical's idempotent provision through
 * the control plane, which re-sources the owner from the vertical's own owner-of-record and restores
 * the grant. Authenticated with the builder's existing CP token — the platform secret never leaves
 * the control plane. Idempotent: safe to re-run on an already-healthy scope.
 */
export async function provisionScope(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  tenantId: string;
  scopeId: string;
}): Promise<void> {
  const res = await fetch(
    `${opts.controlPlaneUrl}/tenants/${encodeURIComponent(opts.tenantId)}` +
      `/scopes/${encodeURIComponent(opts.scopeId)}/provision`,
    { method: 'POST', headers: { ...opts.header, 'content-type': 'application/json' } },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `provision refused: ${res.status} ${res.statusText}`);
  }
  const body = await readJson<{ owner?: string }>(res, res.url);
  console.log(`✓ reconciled scope ${opts.scopeId} — owner ${body.owner ?? '(unknown)'} re-granted; logins restored.`);
}

/**
 * `substrat scope status <scopeId>` — the DIRECTORY's truth about one scope (#424): its
 * status, the version it is bound to, the script serving it, and the role-projection
 * health check. This is the 10-second read that diagnosing a stuck install previously
 * required hand-rolled curl against the CP with the CLI's stored bearer.
 */
export async function scopeStatus(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  tenantId: string;
  scopeId: string;
}): Promise<void> {
  const base = `${opts.controlPlaneUrl}/tenants/${encodeURIComponent(opts.tenantId)}/scopes/${encodeURIComponent(opts.scopeId)}`;
  const res = await fetch(base, { headers: opts.header });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `scope status refused: ${res.status} ${res.statusText}`);
  }
  const record = await readJson<{
    slug: string;
    name: string;
    status: string;
    vertical: string | null;
    verticalVersionId: string | null;
    servingRef?: string | null;
    schemaVersion: string;
    createdAt: string;
  }>(res, base);
  // Health is best-effort: it reaches into the vertical's own deployment, which can be
  // unreachable while the scope record itself still answers — show what we have.
  const health = await fetch(`${base}/health`, { headers: opts.header })
    .then((r) =>
      r.ok
        ? readJson<{
            roleCount: number | null;
            roleProjectionEmpty: boolean;
            missingStores?: { binding: string; kind: string }[];
          }>(r, `${base}/health`)
        : null,
    )
    .catch(() => null);
  console.log(`scope     ${opts.scopeId}`);
  console.log(`name      ${record.name} (${record.slug})`);
  console.log(`vertical  ${record.vertical ?? '—'}`);
  console.log(`status    ${record.status}`);
  console.log(`version   ${record.verticalVersionId ?? '— (static binding)'}`);
  console.log(`serving   ${record.servingRef ?? '— (per-version dispatch)'}`);
  console.log(`schema    ${record.schemaVersion} migration(s) applied`);
  console.log(`created   ${record.createdAt}`);
  if (health) {
    console.log(`roles     ${health.roleCount ?? 'off-DO'}${health.roleProjectionEmpty ? '  ⚠ EMPTY on an active scope — run `substrat scope provision`' : ''}`);
  }
  // #825: a store this vertical DECLARES that the tenant was never minted. Silent until
  // the code touches it — the tenant passed the minting gate before the need was declared
  // — so it is named here, with the lever that fixes it.
  const missing = health?.missingStores ?? [];
  if (missing.length) {
    console.log(
      `\n⚠ ${missing.length} declared store(s) were never minted for this tenant: ` +
        `${missing.map((m) => `${m.binding} (${m.kind})`).join(', ')}\n` +
        '  The vertical will throw at first use. Run `substrat scope provision` to mint and bind them.',
    );
  }
  if (record.status === 'provisioning') {
    console.log(
      `\n⚠ 'provisioning' means the install never activated. If the app is actually serving,\n` +
        `  resume the install from the dashboard's Apps view (it converges in place, #424).`,
    );
  }
}

/**
 * `substrat scope bind <scopeId> --version <id>` — pin ONE scope to a specific version of the
 * SAME vertical (issue #509 ask (c)). This is the platform's most general rollout primitive
 * reached directly: a canary ("tenant A gets 0.3.0 first") or a pinned tenant is just this call
 * per scope, where a channel promote is a fleet-wide rebind. The route it hits already carries
 * the fork-before-promote gate — `--snapshot` archives the pre-migration data first when the
 * bind crosses a migration-digest boundary (a code-only rebind snapshots nothing), so a bad
 * version leaves a rollback point. A pending version is refused unless the scope is a preview.
 */
export async function bindScopeVersion(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  tenantId: string;
  scopeId: string;
  versionId: string;
  snapshot?: boolean;
}): Promise<void> {
  const res = await fetch(
    `${opts.controlPlaneUrl}/tenants/${encodeURIComponent(opts.tenantId)}` +
      `/scopes/${encodeURIComponent(opts.scopeId)}/version`,
    {
      method: 'POST',
      headers: { ...opts.header, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: opts.versionId, snapshot: opts.snapshot || undefined }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `bind refused: ${res.status} ${res.statusText}`);
  }
  const record = await readJson<{ verticalVersionId: string | null; vertical: string | null; servingRef?: string | null }>(
    res,
    res.url,
  );
  console.log(`✓ scope ${opts.scopeId} now runs version ${record.verticalVersionId} (${record.vertical ?? '—'}).`);
  if (opts.snapshot) {
    console.log('  a pre-migration snapshot was taken if this bind crossed a migration boundary — the rollback point.');
  }
}

/**
 * `substrat scope rebind <scopeId> --to <slug>` — move ONE scope onto a DIFFERENT vertical
 * lineage's serving script (#389): the update-rebind behind retiring a platform-owned lineage
 * in favour of a tenant-owned one. Staff-only server-side. Refused when the two lineages'
 * migration digests differ, unless `--ack-migrations` says both diffs were read.
 */
export async function rebindScopeVertical(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  tenantId: string;
  scopeId: string;
  vertical: string;
  ackMigrations: boolean;
  abandonData?: boolean;
}): Promise<void> {
  const res = await fetch(
    `${opts.controlPlaneUrl}/tenants/${encodeURIComponent(opts.tenantId)}` +
      `/scopes/${encodeURIComponent(opts.scopeId)}/rebind-vertical`,
    {
      method: 'POST',
      headers: { ...opts.header, 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: opts.vertical,
        ackMigrations: opts.ackMigrations || undefined,
        abandonData: opts.abandonData || undefined,
      }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `rebind refused: ${res.status} ${res.statusText}`);
  }
  const body = await readJson<{
    servingRef?: string;
    versionId?: string;
    alreadyBound?: boolean;
    tables?: number;
    dataAbandoned?: boolean;
  }>(res, res.url);
  if (body.alreadyBound) {
    console.log(`✓ scope ${opts.scopeId} already bound to ${opts.vertical} (${body.servingRef}) — nothing to do.`);
  } else if (body.dataAbandoned) {
    console.log(`✓ rebound scope ${opts.scopeId} onto ${opts.vertical} (${body.servingRef}) — directory only, no data carried.`);
    console.log('  the source script’s copy is left intact — it is the backout.');
    console.log('  the scope serves nothing until re-provisioned: POST /verticals/<slug>/instances (idempotent).');
  } else {
    console.log(`✓ rebound scope ${opts.scopeId} onto ${opts.vertical} (${body.servingRef}, ${body.tables ?? 0} tables moved).`);
    console.log('  the source script’s copy is left intact — it is the backout.');
  }
}

/**
 * `substrat scope adopt-serving --vertical <slug>` — backfill EVERY still-legacy scope of a
 * vertical in one call. The whole-install migration a promote-per-scope would be tedious for.
 */
export async function adoptVerticalServing(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
}): Promise<void> {
  const res = await fetch(
    `${opts.controlPlaneUrl}/verticals/${encodeURIComponent(opts.slug)}/adopt-serving`,
    { method: 'POST', headers: { ...opts.header, 'content-type': 'application/json' } },
  );
  const body = (await res.json().catch(() => null)) as
    | { adopted?: string[]; alreadyAdopted?: string[]; error?: string }
    | null;
  if (!res.ok) {
    // A per-scope failure reports what it managed before stopping — a re-run resumes.
    const done = (body?.adopted?.length ?? 0) + (body?.alreadyAdopted?.length ?? 0);
    throw new Error(`${body?.error ?? `adopt-serving refused: ${res.status}`}${done ? ` (adopted ${done} before stopping)` : ''}`);
  }
  const adopted = body?.adopted ?? [];
  const already = body?.alreadyAdopted ?? [];
  console.log(`✓ ${opts.slug}: adopted ${adopted.length} scope(s), ${already.length} already on the serving script.`);
  for (const s of adopted) console.log(`  + ${s}`);
}
