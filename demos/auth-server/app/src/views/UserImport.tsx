import { useState } from 'react';
import { importUsers, type ImportOutcome, type ImportResult } from '../api';
import { IMPORT_BATCH, batchesOf, parseImportFile, type ImportEntry } from '../user-import-file';

/**
 * "Import users" on the directory — a dropped CSV or JSON file, previewed, then written.
 *
 * Always two steps, and the first is not optional: dropping a file runs the WHOLE import as a
 * dry run and shows what it would do — how many created, merged, unchanged, and every conflict
 * by name — before the Import button exists. A conflict is the one outcome an operator has to
 * decide about (two ids, one address), and it is cheaper to read before anything moved.
 *
 * The file never leaves the browser except as the import body, batch by batch; it is not
 * stored, and the hashes in it are not shown.
 */
export function ImportUsers({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ name: string; users: ImportEntry[]; ignored: string[] } | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const reset = () => { setFile(null); setPreview(null); setDone(null); setErr(null); };

  const run = async (users: ImportEntry[], dryRun: boolean): Promise<ImportResult> => {
    const batches = batchesOf(users);
    const merged: ImportResult = { dryRun, results: [], counts: { created: 0, merged: 0, unchanged: 0, conflict: 0 } };
    for (const [i, batch] of batches.entries()) {
      setBusy(`${dryRun ? 'Checking' : 'Importing'} ${i * IMPORT_BATCH + 1}–${i * IMPORT_BATCH + batch.length} of ${users.length}…`);
      const result = await importUsers(batch, dryRun);
      merged.results.push(...result.results);
      for (const [k, v] of Object.entries(result.counts)) merged.counts[k as ImportOutcome['outcome']] += v;
    }
    return merged;
  };

  const load = async (picked: File | undefined) => {
    if (!picked) return;
    reset();
    try {
      const parsed = parseImportFile(picked.name, await picked.text());
      if (parsed.users.length === 0) throw new Error(`${picked.name} has no users in it`);
      setFile({ name: picked.name, users: parsed.users, ignored: parsed.ignoredColumns });
      setPreview(await run(parsed.users, true));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!file) return;
    setErr(null);
    try {
      setDone(await run(file.users, false));
      onImported();
    } catch (e) {
      setErr(`${e instanceof Error ? e.message : String(e)} — batches before this one were imported; dropping the file again is safe`);
    } finally {
      setBusy(null);
    }
  };

  if (!open) return <button className="btn" onClick={() => setOpen(true)}>Import users</button>;

  const shown = done ?? preview;
  return (
    <div className="new-user import-users">
      <label
        className={`drop${dragging ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void load(e.dataTransfer.files[0]); }}
      >
        <input type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={(e) => { void load(e.target.files?.[0]); e.target.value = ''; }} />
        <strong>{file ? file.name : 'Drop a CSV or JSON file'}</strong>
        <span className="muted">or click to choose · columns: id, email, name, email_verified, password_hash, github, google</span>
      </label>
      {file && file.ignored.length > 0 && <p className="notice">Ignored columns: {file.ignored.join(', ')}</p>}
      {busy && <p className="muted">{busy}</p>}
      {err && <p className="error">{err}</p>}
      {shown && (
        <>
          <p className={done ? 'notice' : 'muted'}>
            {done ? 'Imported: ' : `Dry run of ${file?.users.length} — nothing written yet: `}
            {shown.counts.created} new · {shown.counts.merged} merged · {shown.counts.unchanged} unchanged · {shown.counts.conflict} conflicts
          </p>
          <Problems results={shown.results} />
        </>
      )}
      <div className="row">
        {preview && !done && (
          <button className="btn primary" disabled={Boolean(busy) || preview.counts.created + preview.counts.merged === 0} onClick={apply}>
            Import {preview.counts.created + preview.counts.merged}
          </button>
        )}
        <button className="btn" disabled={Boolean(busy)} onClick={() => { reset(); setOpen(false); }}>Close</button>
      </div>
    </div>
  );
}

/** Conflicts and skipped upstream identities — what the run left for a person to decide. */
function Problems({ results }: { results: ImportOutcome[] }) {
  const lines = results.flatMap((r) => {
    if (r.outcome === 'conflict') {
      return [r.reason === 'email-taken'
        ? `${r.id}: the address belongs to ${r.existingId} here — not imported`
        : `${r.id}: exists here as ${r.existingEmail} — not imported`];
    }
    return r.skippedAccounts.map((s) => `${r.id}: ${s.providerId} ${s.accountId} is already linked to ${s.linkedTo} — left off`);
  });
  if (lines.length === 0) return null;
  return (
    <ul className="import-problems">
      {lines.slice(0, 100).map((l) => <li key={l}>{l}</li>)}
      {lines.length > 100 && <li className="muted">…and {lines.length - 100} more</li>}
    </ul>
  );
}
