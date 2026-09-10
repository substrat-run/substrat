/**
 * Tock's one screen, in four panes.
 *
 * The app filters nothing. Every list it renders is what the API answered, so a viewer seeing
 * fewer things than an analyst is the permission model on screen rather than a `if (role ===`
 * anywhere in here. A 403 is rendered as a 403 — the wall is the point, and hiding the button
 * would turn a refusal a person could learn from into a feature that appears not to exist.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  auth,
  me,
  profile,
  upload,
  type FieldHistory,
  type Observation,
  type Run,
  type RuleState,
  type Session,
  type Source,
} from './api.js';
import { previewFile, type Preview } from './preview.js';

type Pane = 'ingest' | 'schema' | 'runs' | 'findings' | 'report';
type FieldRole = 'dimension' | 'measure' | 'ignored';
type FieldType = 'text' | 'int' | 'decimal' | 'timestamp' | 'bool';
interface FieldDraft { type: FieldType; role: FieldRole; labelField?: string }

const MAX_DIMENSIONS = 2;

/** A refusal is rendered, never swallowed: 403 is the permission model answering. */
function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.status === 403
            ? 'Refused — your role does not hold the permission this needs.'
            : `${e.status}: ${e.message}`
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }, []);
  return { error, busy, run, clear: () => setError(null) };
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [pane, setPane] = useState<Pane>('ingest');
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceKey, setSourceKey] = useState<string>('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);

  useEffect(() => {
    void me().then(setSession);
  }, []);

  useEffect(() => {
    if (!session) return;
    void api
      .listSources()
      .then((page) => {
        setSources(page.entries);
        setSourceKey((k) => k || (page.entries[0]?.key ?? ''));
      })
      .catch(() => setSources([]));
  }, [session, tick]);

  useEffect(() => {
    if (!session || !sourceKey) return;
    void api
      .listRuns({ sourceKey })
      .then((page) => setRuns(page.entries))
      .catch(() => setRuns([]));
  }, [session, sourceKey, tick]);

  if (session === undefined) return <main className="shell">Loading…</main>;
  if (session === null)
    return (
      <main className="shell centred">
        <h1>Tock</h1>
        <p className="muted">Delivered files, declared shapes, and counts that name the run that produced them.</p>
        <button onClick={() => auth.login(location.pathname)}>Sign in</button>
      </main>
    );

  return (
    <div className="shell">
      <header>
        <h1>Tock</h1>
        <div className="who">
          <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} disabled={sources.length === 0}>
            {sources.length === 0 && <option value="">no sources yet</option>}
            {sources.map((s) => (
              <option key={s.key} value={s.key}>{s.title}</option>
            ))}
          </select>
          <span className="muted">{session.display}</span>
          <button className="link" onClick={auth.switchUser}>switch</button>
          <button className="link" onClick={auth.logout}>sign out</button>
        </div>
      </header>

      <nav>
        {(['ingest', 'schema', 'runs', 'findings', 'report'] as Pane[]).map((p) => (
          <button key={p} className={p === pane ? 'on' : ''} onClick={() => setPane(p)}>
            {p === 'ingest' ? 'Drop a file' : p[0]!.toUpperCase() + p.slice(1)}
          </button>
        ))}
      </nav>

      <main>
        {pane === 'ingest' && <Ingest sourceKey={sourceKey} sources={sources} onDone={refresh} />}
        {pane === 'schema' && <SchemaPane sourceKey={sourceKey} onDone={refresh} />}
        {pane === 'runs' && <Runs sourceKey={sourceKey} runs={runs} onDone={refresh} />}
        {pane === 'findings' && <Findings sourceKey={sourceKey} />}
        {pane === 'report' && <Report sourceKey={sourceKey} />}
      </main>
    </div>
  );
}

// ── Drop a file ─────────────────────────────────────────────────────────────

function Ingest({ sourceKey, sources, onDone }: { sourceKey: string; sources: Source[]; onDone: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const { error, busy, run } = useAction();
  const [newKey, setNewKey] = useState('');

  const take = async (f: File) => {
    setFile(f);
    setResult(null);
    setPreview(previewFile(await f.text()));
  };

  if (sources.length === 0)
    return (
      <section>
        <h2>No sources yet</h2>
        <p className="muted">A source is a named stream of files. Declaring one needs <code>schema:manage</code>.</p>
        <div className="row">
          <input placeholder="fjord-cdn" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
          <button
            disabled={busy || !newKey}
            onClick={() => run(async () => {
              await api.declareSource({ key: newKey, title: newKey, expectedCadence: 'daily' });
              onDone();
            })}
          >
            Declare source
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
    );

  return (
    <section>
      <h2>Drop a file</h2>
      <label
        className="drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) void take(f);
        }}
      >
        <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); }} />
        {file ? <strong>{file.name}</strong> : <span>Drop a CSV here, or click to choose one</span>}
      </label>

      {preview?.problem && <p className="error">{preview.problem}</p>}

      {preview && !preview.problem && (
        <>
          <p className="note">
            This is what <strong>your browser</strong> sees in the first {preview.sampled} row
            {preview.sampled === 1 ? '' : 's'}
            {preview.truncated && ' (the file is longer)'}. None of it is authoritative — when you send the
            file, the server stores the bytes and reads them again, and every number comes from that read.
          </p>
          <table>
            <thead>
              <tr><th>Field</th><th>Looks like</th><th>Empty in sample</th></tr>
            </thead>
            <tbody>
              {preview.columns.map((c) => (
                <tr key={c.name}>
                  <td><code>{c.name}</code></td>
                  <td>{c.inferred}</td>
                  <td>{c.empty === 0 ? '—' : <span className="warn">{c.empty} of {preview.sampled}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <button
            disabled={busy || !file}
            onClick={() => run(async () => {
              const up = await upload(sourceKey, file!.name, file!);
              const done = await profile(up.run.id);
              setResult(
                `Run ${done.run.id.slice(-8)} · ${done.records} record${done.records === 1 ? '' : 's'} read by the server` +
                  (done.malformed > 0 ? ` · ${done.malformed} malformed line${done.malformed === 1 ? '' : 's'} counted, not dropped` : ''),
              );
              onDone();
            })}
          >
            {busy ? 'Sending…' : 'Send to the server and profile'}
          </button>
        </>
      )}

      {result && <p className="ok">{result}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

// ── Schema ──────────────────────────────────────────────────────────────────

function SchemaPane({ sourceKey, onDone }: { sourceKey: string; onDone: () => void }) {
  const [fields, setFields] = useState<Record<string, FieldDraft>>({});
  const [version, setVersion] = useState<number | null>(null);
  const [suggest, setSuggest] = useState<string[]>([]);
  const { error, busy, run } = useAction();

  useEffect(() => {
    if (!sourceKey) return;
    void api.listSchemas({ sourceKey }).then((page) => {
      const latest = page.entries[page.entries.length - 1];
      if (latest) {
        setVersion(latest.version);
        setFields(JSON.parse(latest.fields_json) as Record<string, FieldDraft>);
      }
    }).catch(() => undefined);
    // Fields that have arrived — so modelling starts from what the data actually contains.
    void api.fieldHistory({ sourceKey }).then((h) => {
      setSuggest([...new Set(h.entries.map((e) => e.field))]);
    }).catch(() => setSuggest([]));
  }, [sourceKey]);

  const dimensions = Object.values(fields).filter((f) => f.role === 'dimension').length;
  const names = Object.keys(fields);

  return (
    <section>
      <h2>Schema {version === null ? '(none yet)' : `v${version}`}</h2>
      <p className="note">
        Saving never edits a version; it writes the next one. A run counted under v{version ?? 1} stays
        explainable after v{(version ?? 0) + 1} exists.
      </p>

      {suggest.filter((s) => !names.includes(s)).length > 0 && (
        <p className="note">
          Arrived but not declared:{' '}
          {suggest.filter((s) => !names.includes(s)).map((s) => (
            <button key={s} className="chip" onClick={() => setFields({ ...fields, [s]: { type: 'text', role: 'ignored' } })}>
              + {s}
            </button>
          ))}
        </p>
      )}

      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Role</th><th>Label from</th><th /></tr></thead>
        <tbody>
          {names.map((name) => (
            <tr key={name}>
              <td><code>{name}</code></td>
              <td>
                <select value={fields[name]!.type} onChange={(e) => setFields({ ...fields, [name]: { ...fields[name]!, type: e.target.value as FieldType } })}>
                  {(['text', 'int', 'decimal', 'timestamp', 'bool'] as FieldType[]).map((t) => <option key={t}>{t}</option>)}
                </select>
              </td>
              <td>
                <select value={fields[name]!.role} onChange={(e) => setFields({ ...fields, [name]: { ...fields[name]!, role: e.target.value as FieldRole } })}>
                  {(['dimension', 'measure', 'ignored'] as FieldRole[]).map((r) => <option key={r}>{r}</option>)}
                </select>
              </td>
              <td>
                {fields[name]!.role === 'dimension' ? (
                  <select
                    value={fields[name]!.labelField ?? ''}
                    onChange={(e) => setFields({ ...fields, [name]: { ...fields[name]!, labelField: e.target.value || undefined } })}
                  >
                    <option value="">—</option>
                    {names.filter((n) => n !== name).map((n) => <option key={n}>{n}</option>)}
                  </select>
                ) : <span className="muted">—</span>}
              </td>
              <td>
                <button className="link" onClick={() => { const { [name]: _drop, ...rest } = fields; setFields(rest); }}>remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {dimensions > MAX_DIMENSIONS && (
        <p className="error">
          {dimensions} grouping dimensions. The rollup holds {MAX_DIMENSIONS} slots, so the server will
          refuse this — a third could be stored and never grouped by.
        </p>
      )}

      <button
        disabled={busy || names.length === 0}
        onClick={() => run(async () => { await api.saveSchema({ sourceKey, fields }); onDone(); setVersion((v) => (v ?? 0) + 1); })}
      >
        {busy ? 'Saving…' : `Save v${(version ?? 0) + 1}`}
      </button>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

// ── Runs ────────────────────────────────────────────────────────────────────

function Runs({ sourceKey, runs, onDone }: { sourceKey: string; runs: Run[]; onDone: () => void }) {
  const { error, busy, run: act } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleState[]>([]);
  const [version, setVersion] = useState(1);

  useEffect(() => {
    if (!sourceKey) return;
    void api.listSchemas({ sourceKey }).then((p) => setVersion(p.entries[p.entries.length - 1]?.version ?? 1)).catch(() => undefined);
  }, [sourceKey]);

  useEffect(() => {
    if (!open) return setRules([]);
    void api.runRules({ runId: open }).then((r) => setRules(r.entries)).catch(() => setRules([]));
  }, [open]);

  return (
    <section>
      <h2>Runs</h2>
      <p className="note">
        Which run is current for a period is <strong>derived</strong> — the latest counted one covering it.
        Nothing is written to the run it displaces, so an earlier run still shows what it reported.
      </p>
      <table>
        <thead><tr><th>Run</th><th>File</th><th>Period</th><th>Status</th><th>Rows</th><th /></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className={open === r.id ? 'open' : ''}>
              <td><button className="link" onClick={() => setOpen(open === r.id ? null : r.id)}><code>{r.id.slice(-8)}</code></button></td>
              <td>{r.filename}</td>
              <td className="muted">{r.period_from.slice(0, 10)}</td>
              <td><span className={`pill ${r.status}`}>{r.status}</span></td>
              <td>{r.row_count ?? '—'}</td>
              <td>
                {r.status === 'profiled' && (
                  <button disabled={busy} onClick={() => act(async () => { await api.mapRun({ runId: r.id, schemaVersion: version }); onDone(); })}>
                    Map to v{version}
                  </button>
                )}
                {r.status === 'mapped' && (
                  <button disabled={busy} onClick={() => act(async () => { await api.countRun({ runId: r.id }); onDone(); })}>Count</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <div className="detail">
          <h3>What run {open.slice(-8)} was counted under</h3>
          {rules.length === 0 ? (
            <p className="muted">No rules captured — this run has not been counted yet.</p>
          ) : (
            <table>
              <thead><tr><th>Kind</th><th>Identifier</th><th>Content hash</th></tr></thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}><td>{r.rule_kind}</td><td><code>{r.identifier}</code></td><td className="muted"><code>{r.content_hash}</code></td></tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="note">
            The hash is the part that holds: a list called <code>2026-03</code> can be edited upstream
            without its name changing.
          </p>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

// ── Findings ────────────────────────────────────────────────────────────────

const FINDING_LABEL: Record<string, string> = {
  undeclared_field: 'Arrived, not declared',
  declared_never_arrived: 'Declared, never arrived',
  type_mismatch: 'Type disagrees',
  cardinality_spike: 'Field explosion',
};

function Findings({ sourceKey }: { sourceKey: string }) {
  const [findings, setFindings] = useState<{ kind: string; field: string; detail: string; firstSeen: string | null }[]>([]);
  const [history, setHistory] = useState<FieldHistory[]>([]);
  const [observed, setObserved] = useState<Observation[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!sourceKey) return;
    void api.deviations({ sourceKey }).then((d) => setFindings(d.findings)).catch((e) => setNote((e as Error).message));
    void api.fieldHistory({ sourceKey }).then((h) => setHistory(h.entries)).catch(() => setHistory([]));
    setObserved([]);
  }, [sourceKey]);

  return (
    <section>
      <h2>Findings</h2>
      <p className="note">
        A schema records what was <em>decided</em>; an observation records what actually <em>arrived</em>.
        Both are facts here, so a disagreement is one too — and “this field arrived and nobody declared it”
        is a thing no sampling tool can tell you.
      </p>
      {note && <p className="error">{note}</p>}
      {findings.length === 0 && !note && <p className="muted">Nothing disagrees.</p>}
      {findings.map((f) => (
        <div key={`${f.kind}:${f.field}`} className="finding">
          <span className={`pill ${f.kind}`}>{FINDING_LABEL[f.kind] ?? f.kind}</span>
          <code>{f.field}</code>
          <span className="muted">{f.detail}</span>
        </div>
      ))}

      <h3>When each field first arrived</h3>
      <p className="note">
        Kept longer than the runs it came from — which is what makes “was this field there before we
        started using it?” answerable rather than guessed at. Adding a field never back-fills history
        with a placeholder.
      </p>
      <table>
        <thead><tr><th>Field</th><th>Day</th><th>Rows with a value</th></tr></thead>
        <tbody>
          {history.map((h) => (
            <tr key={`${h.field}:${h.day}`}><td><code>{h.field}</code></td><td>{h.day}</td><td>{h.n}</td></tr>
          ))}
        </tbody>
      </table>
      {observed.length > 0 && <p className="muted">{observed.length}</p>}
    </section>
  );
}

// ── Report ──────────────────────────────────────────────────────────────────

function Report({ sourceKey }: { sourceKey: string }) {
  const [grain, setGrain] = useState<'hour' | 'day' | 'month'>('day');
  const [dimSet, setDimSet] = useState('total');
  const [unknown, setUnknown] = useState(false);
  const [rows, setRows] = useState<{ periodStart: string; dim1: string; label1: string | null; events: number; measure: string | null; runId: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [choices, setChoices] = useState<string[]>(['total']);

  useEffect(() => {
    if (!sourceKey) return;
    void api.listSchemas({ sourceKey }).then((p) => {
      const latest = p.entries[p.entries.length - 1];
      const fields = latest ? (JSON.parse(latest.fields_json) as Record<string, FieldDraft>) : {};
      setChoices(['total', ...Object.entries(fields).filter(([, f]) => f.role === 'dimension').map(([n]) => n)]);
    }).catch(() => undefined);
  }, [sourceKey]);

  useEffect(() => {
    if (!sourceKey) return;
    setNote(null);
    void api
      .report({
        sourceKey,
        grain,
        dimSet,
        from: '2000-01-01T00:00:00.000Z',
        to: '2100-01-01T00:00:00.000Z',
        includeUnknown: unknown,
      })
      .then((r) => setRows(r.rows))
      .catch((e) => { setRows([]); setNote(e instanceof ApiError && e.status === 403 ? 'Refused — your role does not hold report:read.' : (e as Error).message); });
  }, [sourceKey, grain, dimSet, unknown]);

  return (
    <section>
      <h2>Report</h2>
      <div className="row">
        <select value={grain} onChange={(e) => setGrain(e.target.value as 'hour' | 'day' | 'month')}>
          <option value="day">day</option>
          <option value="month">month</option>
        </select>
        <select value={dimSet} onChange={(e) => setDimSet(e.target.value)}>
          {choices.map((c) => <option key={c}>{c}</option>)}
        </select>
        <label className="check">
          <input type="checkbox" checked={unknown} onChange={(e) => setUnknown(e.target.checked)} /> show the unknown bucket
        </label>
      </div>
      <p className="note">
        A value the source row did not have is its own bucket, hidden until you ask for it — never folded
        into a fabricated one. A missing measure stays empty and the sum skips it, because a measure
        defaulted to zero is invisible in a total and silently wrong.
      </p>
      {note && <p className="error">{note}</p>}
      <table>
        <thead>
          <tr><th>Period</th>{dimSet !== 'total' && <th>{dimSet}</th>}<th>Events</th><th>Measure</th><th>From run</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.periodStart.slice(0, 10)}</td>
              {dimSet !== 'total' && (
                <td>{r.dim1 === '' ? <span className="warn">unknown</span> : (r.label1 ?? r.dim1)}</td>
              )}
              <td>{r.events}</td>
              <td>{r.measure ?? <span className="muted">—</span>}</td>
              <td className="muted"><code>{r.runId.slice(-8)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && !note && <p className="muted">Nothing counted yet.</p>}
      <p className="note">
        Every row names the run that produced it. That is how a number is traced back to a file and the
        rules in force when it was counted — and how a corrected figure stays distinguishable from the one
        it replaced.
      </p>
    </section>
  );
}
