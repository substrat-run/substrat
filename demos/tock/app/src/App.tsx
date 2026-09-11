/**
 * Tock's one screen, in five panes.
 *
 * The app filters nothing. Every list it renders is what the API answered, so a viewer seeing
 * fewer things than an analyst is the permission model on screen rather than a `if (role ===`
 * anywhere in here. A 403 is rendered as a 403 — the wall is the point, and hiding the button
 * would turn a refusal a person could learn from into a feature that appears not to exist.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  all,
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
import { kindCandidates, observedKinds, previewFile, readHead, type Preview } from './preview.js';

type Pane = 'ingest' | 'kinds' | 'schema' | 'runs' | 'findings' | 'report';
type FieldRole = 'dimension' | 'measure' | 'ignored';
type FieldType = 'text' | 'int' | 'decimal' | 'timestamp' | 'bool';
interface FieldDraft { type: FieldType; role: FieldRole; labelField?: string }

const MAX_DIMENSIONS = 2;

/**
 * A token that invalidates in-flight loads when what they were loading FOR has changed.
 *
 * Two panes load asynchronously keyed on a selection a person can change mid-flight — the
 * source, and which kind a schema describes. Without this, a slow response for the previous
 * selection lands after a fast one for the current and silently overwrites it, which is worse
 * than a slow screen because the result looks like an answer.
 */
function useFreshness(): [() => number, (n: number) => boolean] {
  const ref = useRef(0);
  return [
    () => {
      ref.current += 1;
      return ref.current;
    },
    (n: number) => n === ref.current,
  ];
}

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
    void all(api.listSources())
      .then((entries) => {
        setSources(entries);
        setSourceKey((k) => k || (entries[0]?.key ?? ''));
      })
      .catch(() => setSources([]));
  }, [session, tick]);

  useEffect(() => {
    if (!session || !sourceKey) return;
    void all(api.listRuns({ sourceKey }))
      .then(setRuns)
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
        {(['ingest', 'kinds', 'schema', 'runs', 'findings', 'report'] as Pane[]).map((p) => (
          <button key={p} className={p === pane ? 'on' : ''} onClick={() => setPane(p)}>
            {p === 'ingest' ? 'Drop a file' : p[0]!.toUpperCase() + p.slice(1)}
          </button>
        ))}
      </nav>

      <main>
        {pane === 'ingest' && <Ingest sourceKey={sourceKey} sources={sources} onDone={refresh} />}
        {pane === 'kinds' && <Kinds sourceKey={sourceKey} onDone={refresh} />}
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
  /** An uploaded run whose profiling has not succeeded yet. */
  const [pending, setPending] = useState<string | null>(null);
  /** The structural mapping — which column is the instant, and which the subject. */
  const [timeField, setTimeField] = useState('');
  const [subjectField, setSubjectField] = useState('');
  const { error, busy, run } = useAction();
  const [newKey, setNewKey] = useState('');

  const take = async (f: File) => {
    setFile(f);
    setResult(null);
    setPending(null);
    // A byte slice, never `f.text()`: the preview needs a shape, and reading a month of logs
    // into the tab to show six rows of it would freeze the very screen it is meant to speed up.
    const head = await readHead(f);
    const p = previewFile(head.text, head.truncated);
    setPreview(p);
    // A proposal the person confirms. Nothing is sent until they do, because which column
    // means "when" is a judgement about the export rather than something in the bytes.
    setTimeField(p.suggestedTime ?? '');
    setSubjectField('');
  };

  /**
   * Upload creates a run; profiling is a second call that can fail on its own.
   *
   * Losing the run id in between is what strands it: the Runs pane offers nothing for a
   * `received` run, and pressing the button again would upload the same file and open a
   * SECOND run over it. So the id is kept, and a failed profile retries the profile rather
   * than re-uploading.
   */
  const profileRun = async (runId: string) => {
    const done = await profile(runId);
    setResult(
      `Run ${runId.slice(-8)} · ${done.records} record${done.records === 1 ? '' : 's'} read by the server` +
        (done.malformed > 0
          ? ` · ${done.malformed} unreadable line${done.malformed === 1 ? '' : 's'} reported and left out of the run`
          : ''),
    );
    setPending(null);
    onDone();
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
        {/* Visually hidden rather than `hidden`: the attribute takes the input out of the tab
            order, which leaves a keyboard-only user with no way to open the file chooser at all. */}
        <input
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); }}
        />
        {file ? <strong>{file.name}</strong> : <span>Drop a CSV here, or click to choose one</span>}
      </label>

      {preview?.problem && <p className="error">{preview.problem}</p>}

      {preview && !preview.problem && (
        <>
          <div className="row">
            <label className="check">
              instant column
              <select value={timeField} onChange={(e) => setTimeField(e.target.value)}>
                <option value="">— pick one —</option>
                {preview.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </label>
            <label className="check">
              subject column
              <select value={subjectField} onChange={(e) => setSubjectField(e.target.value)}>
                <option value="">none — every row counts once</option>
                {preview.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </label>
            <span className="muted">
              read as {preview.format === 'jsonl' ? 'JSON lines' : `CSV, ${preview.delimiter === '\t' ? 'tab' : preview.delimiter}-separated`}
            </span>
          </div>
          {!subjectField && (
            <p className="note">
              With no subject column there is nothing to de-duplicate on, so every row counts once.
              That is a legitimate answer for a file of facts; it is the wrong one for request logs,
              where the same listener appearing twice should count once.
            </p>
          )}
          {kindCandidates(preview).length > 0 && (
            <p className="note">
              Columns that look like <strong>kinds</strong> rather than data:{' '}
              {kindCandidates(preview)
                .map((c) => (
                  <span key={c.name} className="chip-static">
                    <code>{c.name}</code> ({c.values!.length})
                  </span>
                ))}
              . Declare them under <strong>Kinds</strong> and this file's records get classified
              as they are read; leave it and every record is one shape, which is fine for a
              stream that is.
            </p>
          )}
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

          {pending ? (
            <>
              <p className="warn">
                Run {pending.slice(-8)} was uploaded but has not been profiled. Retry the profile —
                sending the file again would open a second run over the same bytes.
              </p>
              <button disabled={busy} onClick={() => run(() => profileRun(pending))}>
                {busy ? 'Profiling…' : 'Retry profiling'}
              </button>
            </>
          ) : (
            <button
              disabled={busy || !file || !timeField}
              onClick={() => run(async () => {
                const up = await upload(sourceKey, file!.name, file!, {
                timeField,
                subjectField: subjectField || null,
              });
                setPending(up.run.id);
                await profileRun(up.run.id);
              })}
            >
              {busy ? 'Sending…' : 'Send to the server and profile'}
            </button>
          )}
        </>
      )}

      {result && <p className="ok">{result}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

// ── Kinds ───────────────────────────────────────────────────────────────────

/**
 * Declaring which fields tell record kinds apart, and the kinds themselves.
 *
 * The proposal comes from a file you drop here — the same browser-side read the ingest pane
 * does, and authoritative for nothing. What gets declared is what a person confirms, because
 * "these two values are different kinds of record" is a judgement about the stream rather
 * than a fact in it: a source whose every request id is distinct would otherwise acquire
 * eleven thousand kinds.
 */
function Kinds({ sourceKey, onDone }: { sourceKey: string; onDone: () => void }) {
  const [declared, setDeclared] = useState<{ discriminators: string[]; variants: { key: string }[] }>({
    discriminators: [],
    variants: [],
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const { error, busy, run } = useAction();
  const [nextLoad, isCurrent] = useFreshness();

  useEffect(() => {
    if (!sourceKey) return;
    // Cleared SYNCHRONOUSLY, before the load. The dropped file and the ticked kinds belong to
    // the source that was selected when they were chosen; leaving them up means Declare can
    // submit one source's proposal to another.
    setPreview(null);
    setPicked([]);
    setChosen(new Set());
    setDeclared({ discriminators: [], variants: [] });
    const token = nextLoad();
    void api
      .listVariants({ sourceKey })
      .then((v) => {
        if (!isCurrent(token)) return;
        setDeclared(v);
        setPicked(v.discriminators);
      })
      .catch(() => undefined);
  }, [sourceKey]);

  /**
   * Which kinds are ticked is only meaningful under the discriminators they were computed
   * from. Change those and a ticked `track/scroll` may name a combination the new list cannot
   * produce — Declare would light up and submit nothing.
   */
  const repick = (next: string[]) => {
    setPicked(next);
    setChosen(new Set());
  };

  const take = async (f: File) => {
    const head = await readHead(f);
    const p = previewFile(head.text, head.truncated);
    setPreview(p);
    setChosen(new Set());
  };

  const candidates = preview ? kindCandidates(preview) : [];
  const seen = preview ? observedKinds(preview, picked) : [];

  return (
    <section>
      <h2>Kinds</h2>
      <p className="note">
        A file rarely holds one shape. Declare the fields whose values tell kinds apart — in
        order, outermost first — and each record is classified as it is read. A value nobody
        declared is <strong>kept and reported</strong>, never dropped.
      </p>

      {declared.discriminators.length > 0 && (
        <p className="note">
          Declared now: <code>{declared.discriminators.join(' → ')}</code> ·{' '}
          {declared.variants.length} kind{declared.variants.length === 1 ? '' : 's'} (
          {declared.variants.map((v) => v.key).join(', ')})
        </p>
      )}

      {/* The handlers are what make the words true: the input is visually 1x1, so without
          them a drop onto this label does nothing and only clicking works. */}
      <label
        className="drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) void take(f);
        }}
      >
        <input
          type="file"
          accept=".csv,text/csv,.jsonl,application/json"
          className="sr-only"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); }}
        />
        <span>Drop a file to see what kinds it contains</span>
      </label>

      {preview && !preview.problem && (
        <>
          <h3>Which fields tell kinds apart?</h3>
          <div className="row">
            {candidates.map((c) => {
              const at = picked.indexOf(c.name);
              return (
                <button
                  key={c.name}
                  className={at >= 0 ? 'chip on' : 'chip'}
                  onClick={() => repick(at >= 0 ? picked.filter((n) => n !== c.name) : [...picked, c.name])}
                >
                  {at >= 0 ? `${at + 1}. ` : ''}
                  {c.name} ({c.values!.length})
                </button>
              );
            })}
            {candidates.length === 0 && <span className="muted">Nothing in the sample looks like a kind.</span>}
          </div>

          {picked.length > 0 && (
            <>
              <h3>The kinds this file contains</h3>
              <p className="note">
                Counts are from the sample, not the file. A combination seen twice in{' '}
                {preview.sampled} rows is probably not a kind — which is why this proposes and
                you decide.
              </p>
              <table>
                <thead><tr><th>Declare</th><th>Kind</th><th>In sample</th></tr></thead>
                <tbody>
                  {seen.map((k) => {
                    const key = k.selector.join('/');
                    return (
                      <tr key={key}>
                        <td>
                          <input
                            type="checkbox"
                            checked={chosen.has(key)}
                            onChange={(e) => {
                              const next = new Set(chosen);
                              if (e.target.checked) next.add(key); else next.delete(key);
                              setChosen(next);
                            }}
                          />
                        </td>
                        <td><code>{key}</code></td>
                        <td>{k.n}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button
                disabled={busy || chosen.size === 0}
                onClick={() => run(async () => {
                  await api.declareVariants({
                    sourceKey,
                    discriminators: picked,
                    variants: seen.filter((k) => chosen.has(k.selector.join('/'))).map((k) => ({ selector: k.selector })),
                  });
                  const v = await api.listVariants({ sourceKey });
                  setDeclared(v);
                  onDone();
                })}
              >
                {busy ? 'Declaring…' : `Declare ${chosen.size} kind${chosen.size === 1 ? '' : 's'}`}
              </button>
            </>
          )}
        </>
      )}
      {preview?.problem && <p className="error">{preview.problem}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

// ── Schema ──────────────────────────────────────────────────────────────────

function SchemaPane({ sourceKey, onDone }: { sourceKey: string; onDone: () => void }) {
  const [fields, setFields] = useState<Record<string, FieldDraft>>({});
  const [version, setVersion] = useState<number | null>(null);
  /** Which kind this shape describes. Empty is the envelope every record carries. */
  const [variantKey, setVariantKey] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);
  const [nextLoad, isCurrent] = useFreshness();
  const [suggest, setSuggest] = useState<string[]>([]);
  const { error, busy, run } = useAction();

  useEffect(() => {
    if (!sourceKey) return;
    setVariantKey('');
    void api.listVariants({ sourceKey }).then((v) => setKinds(v.variants.map((x) => x.key))).catch(() => setKinds([]));
  }, [sourceKey]);

  useEffect(() => {
    if (!sourceKey) return;
    // Cleared on BOTH branches. Leaving the previous source's draft in place when the new one
    // has no schemas is not a cosmetic bug: the editor then shows fields that belong to another
    // source and will happily save them as its v1.
    /**
     * Cleared before the load, not inside it.
     *
     * The draft belongs to the kind it was loaded for. Leaving the previous one editable
     * while this settles means a quick switch followed by Save writes one kind's fields under
     * another's name — and a slow response for the kind you just left would overwrite the one
     * you are looking at.
     */
    setVersion(null);
    setFields({});
    const token = nextLoad();
    void all(api.listSchemas({ sourceKey, variantKey })).then((entries) => {
      if (!isCurrent(token)) return;
      const mine = entries.filter((e) => e.variant_key === variantKey);
      const latest = mine[mine.length - 1];
      setVersion(latest ? latest.version : null);
      setFields(latest ? (JSON.parse(latest.fields_json) as Record<string, FieldDraft>) : {});
    }).catch(() => { if (isCurrent(token)) { setVersion(null); setFields({}); } });
    // Fields that have arrived — so modelling starts from what the data actually contains.
    void api.fieldHistory({ sourceKey }).then((h) => {
      setSuggest([...new Set(h.entries.map((e) => e.field))]);
    }).catch(() => setSuggest([]));
  }, [sourceKey, variantKey]);

  const dimensions = Object.values(fields).filter((f) => f.role === 'dimension').length;
  const names = Object.keys(fields);

  return (
    <section>
      <h2>Schema {version === null ? '(none yet)' : `v${version}`}</h2>
      {kinds.length > 0 && (
        <div className="row">
          <label className="check">
            describing
            <select value={variantKey} onChange={(e) => setVariantKey(e.target.value)}>
              <option value="">the envelope — every record</option>
              {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <span className="muted">
            {variantKey
              ? 'Declare only what this kind ADDS. A record carries the envelope as well.'
              : 'The fields every record carries, whatever its kind. Declared once.'}
          </span>
        </div>
      )}
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
                {/* Removing a field also clears any labelField pointing at it. The server refuses a
                    schema whose label names a field it does not contain, so leaving the dangling
                    reference makes the schema unsavable — with the error arriving at Save, about a
                    field the person removed several clicks ago. */}
                <button
                  className="link"
                  onClick={() => {
                    const { [name]: _drop, ...rest } = fields;
                    setFields(
                      Object.fromEntries(
                        Object.entries(rest).map(([n, f]) => [n, f.labelField === name ? { ...f, labelField: undefined } : f]),
                      ),
                    );
                  }}
                >
                  remove
                </button>
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
        onClick={() => run(async () => { await api.saveSchema({ sourceKey, variantKey, fields }); onDone(); setVersion((v) => (v ?? 0) + 1); })}
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
    void all(api.listSchemas({ sourceKey })).then((e) => setVersion(e[e.length - 1]?.version ?? 1)).catch(() => undefined);
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
  unmatched_records: 'Kind not declared',
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
  const [outputKey, setOutputKey] = useState('');
  /** The full records, not just their keys: the grouping choices come from their fields. */
  const [outputs, setOutputs] = useState<{ key: string; fields_json: string }[]>([]);
  const [dimSet, setDimSet] = useState('total');
  const [unknown, setUnknown] = useState(false);
  const [rows, setRows] = useState<{ periodStart: string; dim1: string; dim2: string; label1: string | null; label2: string | null; events: number; measure: string | null; runId: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [choices, setChoices] = useState<string[]>(['total']);
  /** The input envelope's fields, for when no output is selected. */
  const [envelope, setEnvelope] = useState('{}');

  useEffect(() => {
    if (!sourceKey) return;
    // Back to `total` whenever the source changes. A grouping carried over from another source
    // is a request the server has no rows for, rendered as an empty report that looks like an
    // answer — and the select would show no matching option while doing it.
    setDimSet('total');
    setOutputKey('');
    void all(api.listOutputSchemas({ sourceKey }))
      .then((entries) => {
        // The latest version of each key; earlier ones describe shapes nothing is counted under.
        const latest = new Map<string, { key: string; fields_json: string }>();
        for (const o of entries) latest.set(o.key, o);
        setOutputs([...latest.values()]);
      })
      .catch(() => setOutputs([]));
    void all(api.listSchemas({ sourceKey }))
      .then((entries) => setEnvelope(entries[entries.length - 1]?.fields_json ?? '{}'))
      .catch(() => undefined);
  }, [sourceKey]);

  /**
   * The groupings come from whatever is being COUNTED — the selected output, or the envelope.
   *
   * They used to come from the input schema always, so an output renaming `country` to
   * `market` still offered `country`: the request then named a `dim_set` nothing had ever
   * materialised and the report came back empty, which reads as an answer rather than as a
   * mistake.
   */
  useEffect(() => {
    const source = outputKey ? outputs.find((o) => o.key === outputKey)?.fields_json : envelope;
    const fields = JSON.parse(source ?? '{}') as Record<string, FieldDraft>;
    const dims = Object.entries(fields).filter(([, f]) => f.role === 'dimension').map(([n]) => n);
    // Counting materialises the PAIR as well as each single dimension, in the order the shape
    // declares them. Offering only the singles left rows nothing could ask for.
    setChoices(['total', ...dims, ...(dims.length === 2 ? [dims.join('+')] : [])]);
    setDimSet('total');
  }, [outputKey, outputs, envelope]);

  useEffect(() => {
    if (!sourceKey) return;
    setNote(null);
    void api
      .report({
        sourceKey,
        grain,
        dimSet,
        outputKey,
        from: '2000-01-01T00:00:00.000Z',
        to: '2100-01-01T00:00:00.000Z',
        includeUnknown: unknown,
      })
      .then((r) => setRows(r.rows))
      .catch((e) => { setRows([]); setNote(e instanceof ApiError && e.status === 403 ? 'Refused — your role does not hold report:read.' : (e as Error).message); });
  }, [sourceKey, outputKey, grain, dimSet, unknown]);

  /** Which slots this grouping uses — `total` uses none, a pair uses both. */
  const dims = dimSet === 'total' ? [] : dimSet.split('+');

  return (
    <section>
      <h2>Report</h2>
      <div className="row">
        {outputs.length > 0 && (
          <select value={outputKey} onChange={(e) => setOutputKey(e.target.value)}>
            <option value="">the envelope</option>
            {outputs.map((o) => <option key={o.key}>{o.key}</option>)}
          </select>
        )}
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
          <tr>
            <th>Period</th>
            {dims.map((d) => <th key={d}>{d}</th>)}
            <th>Events</th><th>Measure</th><th>From run</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.periodStart.slice(0, 10)}</td>
              {dims.length >= 1 && (
                <td>{r.dim1 === '' ? <span className="warn">unknown</span> : (r.label1 ?? r.dim1)}</td>
              )}
              {dims.length >= 2 && (
                <td>{r.dim2 === '' ? <span className="warn">unknown</span> : (r.label2 ?? r.dim2)}</td>
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
