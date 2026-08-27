/**
 * Artboards 09–12 — desk settings, admin only.
 *
 * 960px with a 180px nav, per the handoff. The two screens with real weight are
 * Identity verification (10), where a secret is shown exactly once, and Usage (12),
 * where a per-token price gets a type treatment rather than a rounding.
 */
import { useEffect, useState } from 'react';
import type { Capabilities, View } from '../App.js';
import { api, type KbSource } from '../api.js';
import { Dot, Empty, UnitPrice } from '../ui.js';

type Tab = 'desk' | 'identity' | 'knowledge' | 'usage';

const TABS: { id: Tab; label: string }[] = [
  { id: 'desk', label: 'Desk' },
  { id: 'identity', label: 'Identity verification' },
  { id: 'knowledge', label: 'Knowledge base' },
  { id: 'usage', label: 'Usage & cost' },
];

export function Settings({
  tab,
  caps,
  go,
}: {
  tab: Tab;
  caps: Capabilities | null;
  go: (v: View) => void;
}) {
  if (!caps?.configure)
    return (
      <div className="frame" style={{ width: 720 }}>
        <Empty title="Settings are the desk admin's" note="Your account does not hold `desk:configure`." />
      </div>
    );

  return (
    <div
      className="frame"
      style={{ width: 960, maxWidth: '100%', display: 'grid', gridTemplateColumns: '180px 1fr', background: 'var(--surface)' }}
    >
      <nav style={{ borderRight: '1px solid var(--hairline)', padding: 12, background: 'var(--app-bg)' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => go({ name: 'settings', tab: t.id })}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 0,
              cursor: 'pointer',
              borderRadius: 6,
              padding: '7px 10px',
              marginBottom: 2,
              font: `${t.id === tab ? 600 : 500} 12px 'Geist', sans-serif`,
              color: t.id === tab ? 'var(--text)' : 'var(--secondary)',
              background: t.id === tab ? 'var(--nav-active)' : 'transparent',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <section style={{ padding: 22, minHeight: 460 }}>
        {tab === 'desk' ? <Desk /> : null}
        {tab === 'identity' ? <Identity /> : null}
        {tab === 'knowledge' ? <Knowledge /> : null}
        {tab === 'usage' ? <Usage money={caps.money} /> : null}
      </section>
    </div>
  );
}

function Head({ title, note }: { title: string; note?: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="t-page">{title}</div>
      {note ? (
        <div className="t-meta" style={{ marginTop: 4 }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 16 }}>
      <div className="micro" style={{ marginBottom: 6 }}>
        {label}
      </div>
      {children}
      {hint ? (
        <div className="t-small" style={{ marginTop: 5 }}>
          {hint}
        </div>
      ) : null}
    </label>
  );
}

/* ── 09 Desk ────────────────────────────────────────────────────────────── */

function Desk() {
  const [desk, setDesk] = useState<{
    from_address: string;
    greeting: string;
    allowed_origins: string;
    business_hours: string | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /**
   * Two failures, two states — deliberately not one.
   *
   * A load failure means there is no form to show; a save failure means the form is
   * right there with the user's edits in it. Sharing one `failed` between them threw
   * those edits away by unmounting the form to show the error about them.
   */
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    void api.getDesk().then(setDesk).catch((e: Error) => setLoadFailed(e.message));
  }, []);
  // A rejected request is not a slow one. Saying "Loading…" forever is the screen
  // lying about which of the two happened.
  if (loadFailed) return <Empty title="Could not load the desk" note={loadFailed} />;
  if (!desk) return <div className="t-meta">Loading…</div>;

  const origins: string[] = JSON.parse(desk.allowed_origins || '[]');

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setFailed(null);
    try {
      await api.configureDesk({
        fromAddress: desk.from_address,
        greeting: desk.greeting,
        allowedOrigins: origins,
        businessHours: desk.business_hours,
      });
      setSaved(true);
    } catch (e) {
      // Reported, not swallowed — and `finally` releases the button either way, so a
      // failure does not leave "Saving…" wedged on screen.
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Head title="Desk" note="How this desk introduces itself, and where its widget may be embedded." />
      <Field
        label="From address"
        hint={
          <span style={{ color: 'var(--green)' }}>
            ● DNS verified · SPF, DKIM, MX
          </span>
        }
      >
        <input
          className="input mono"
          value={desk.from_address}
          onChange={(e) => setDesk({ ...desk, from_address: e.target.value })}
        />
      </Field>
      <Field label="Greeting" hint="The first thing a visitor sees in the widget.">
        <textarea
          className="textarea"
          rows={2}
          value={desk.greeting}
          onChange={(e) => setDesk({ ...desk, greeting: e.target.value })}
        />
      </Field>
      <Field label="Business hours">
        <input
          className="input"
          placeholder="Mon–Fri · 09:00–18:00 · Europe/Stockholm"
          value={desk.business_hours ?? ''}
          onChange={(e) => setDesk({ ...desk, business_hours: e.target.value || null })}
        />
      </Field>
      <Field
        label="Widget origins"
        hint="A site not on this list is refused before a conversation exists."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {origins.map((o) => (
            <div
              key={o}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                border: '1px solid var(--hairline)',
                borderRadius: 6,
                padding: '7px 10px',
                background: 'var(--app-bg)',
              }}
            >
              <span className="mono" style={{ fontSize: 12, flex: 1 }}>
                {o}
              </span>
              <button className="btn btn-ghost" disabled>
                Remove
              </button>
            </div>
          ))}
        </div>
      </Field>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved ? <span className="t-small" style={{ color: 'var(--green)' }}>Saved.</span> : null}
        {failed ? (
          <span className="t-small" style={{ color: 'var(--danger-2)' }}>
            {failed}
          </span>
        ) : null}
      </div>
    </>
  );
}

/* ── 10 Identity verification ───────────────────────────────────────────── */

function Identity() {
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  return (
    <>
      <Head
        title="Identity verification"
        note="How a customer's own site vouches for who a visitor is, without a support login."
      />

      <div className="card" style={{ padding: 14, marginBottom: 18 }}>
        <div className="micro" style={{ marginBottom: 7 }}>
          Current secret
        </div>
        <div className="mono" style={{ fontSize: 12, color: 'var(--secondary)' }}>
          t0_sec_•••••••••••••••••••••••••• — not retrievable
        </div>
        <div className="t-small" style={{ marginTop: 10, lineHeight: 1.6 }}>
          Your server computes{' '}
          <span className="mono" style={{ background: '#f1f1f0', padding: '1px 5px', borderRadius: 3 }}>
            user_hash = HMAC-SHA256(secret, user_id)
          </span>{' '}
          and passes it to the widget. The browser never holds the secret, which is what
          makes the claim trustworthy.
        </div>
      </div>

      {!secret ? (
        <button className="btn btn-danger" onClick={() => setRotating(true)} disabled={rotating}>
          Rotate…
        </button>
      ) : null}

      {rotating && !secret ? (
        <div
          style={{
            border: '1px solid var(--danger-border)',
            background: 'var(--danger-bg)',
            borderRadius: 8,
            padding: 14,
            marginTop: 14,
          }}
        >
          <div className="t-strong" style={{ color: 'var(--danger-2)', marginBottom: 6 }}>
            Rotating invalidates every signature your site is producing
          </div>
          <div className="t-small" style={{ marginBottom: 12, lineHeight: 1.6 }}>
            Verified visitors fall back to anonymous until your server picks up the new
            secret. The new value is shown once and never again.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-danger"
              onClick={() =>
                void api.rotateVerificationSecret().then((r) => setSecret(r.secret))
              }
            >
              Rotate the secret
            </button>
            <button className="btn btn-ghost" onClick={() => setRotating(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* The rotation moment. Shown once, and the close button waits for the copy. */}
      {secret ? (
        <div
          style={{
            border: '1px solid #d9a0a0',
            borderRadius: 8,
            overflow: 'hidden',
            marginTop: 14,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              background: 'var(--danger-bg)',
              borderBottom: '1px solid var(--danger-border-2)',
            }}
          >
            <div className="t-strong" style={{ color: 'var(--danger-2)' }}>
              Secret rotated — copy it now
            </div>
            <span
              className="mono"
              style={{
                marginLeft: 'auto',
                font: "600 10px 'Geist Mono', monospace",
                letterSpacing: '.07em',
                color: 'var(--danger)',
                border: '1px solid var(--danger-border)',
                borderRadius: 4,
                padding: '2px 7px',
              }}
            >
              SHOWN ONCE
            </span>
          </div>
          <div style={{ padding: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
            <code
              className="mono"
              style={{
                flex: 1,
                fontSize: 12,
                background: 'var(--app-bg)',
                border: '1px solid var(--hairline)',
                borderRadius: 6,
                padding: '9px 11px',
                wordBreak: 'break-all',
              }}
            >
              {secret}
            </code>
            <button
              className="btn"
              style={{ background: '#17181a', borderColor: '#17181a', color: '#fff' }}
              onClick={() => {
                void navigator.clipboard?.writeText(secret);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div
            style={{
              margin: '0 14px 14px',
              padding: '10px 12px',
              background: 'var(--danger-bg-2)',
              border: '1px solid var(--danger-border-2)',
              borderRadius: 6,
              font: "400 12px/1.6 'Geist', sans-serif",
              color: 'var(--danger-3)',
            }}
          >
            Signatures made with the old secret are already invalid. Verified visitors
            fall back to anonymous until your server is updated.
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '10px 14px',
              borderTop: '1px solid var(--hairline)',
              background: 'var(--app-bg)',
            }}
          >
            <span className="t-small mono">
              old secret invalidated {new Date().toISOString().slice(11, 19)} UTC
            </span>
            <button
              className="btn"
              style={{ marginLeft: 'auto' }}
              disabled={!copied}
              onClick={() => {
                setSecret(null);
                setRotating(false);
                setCopied(false);
              }}
            >
              I've stored it — close
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ── 11 Knowledge base ──────────────────────────────────────────────────── */

const GRID = '190px 1.6fr 56px 118px 96px 56px';

function Knowledge() {
  const [sources, setSources] = useState<KbSource[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Two failures, two states. The list not loading is a page-level problem that the
  // loading fallback must not hide; an ingest being refused is news about ONE source,
  // and the successful re-read that follows it must not wipe that news.
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [ingestFailed, setIngestFailed] = useState<string | null>(null);

  const load = () =>
    void api
      .listKbSources()
      .then((p) => {
        setSources(p.entries);
        setLoadFailed(null);
      })
      .catch((e: Error) => setLoadFailed(e.message));
  useEffect(load, []);

  const failures = [loadFailed, ingestFailed].filter((f): f is string => f !== null);
  const failureCards = failures.map((f) => (
    <div key={f} className="card" style={{ padding: '10px 14px', marginBottom: 12, color: 'var(--danger)' }}>
      <span className="t-small">{f}</span>
    </div>
  ));

  // The error before the fallback, or a list that never loads reads as one that
  // is still loading.
  if (!sources) {
    return loadFailed ? (
      <>
        <Head title="Knowledge base" note="What the assistant reads before it answers." />
        {failureCards}
      </>
    ) : (
      <div className="t-meta">Loading…</div>
    );
  }

  return (
    <>
      <Head title="Knowledge base" note="What the assistant reads before it answers." />
      {failureCards}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div
          className="micro-6"
          style={{ display: 'grid', gridTemplateColumns: GRID, gap: '0 12px', padding: '9px 14px', color: 'var(--muted)' }}
        >
          <div>Source</div>
          <div>URL</div>
          <div>Kind</div>
          <div>Last ingested</div>
          <div>Status</div>
          <div />
        </div>
        {sources.map((s) => (
          <div
            key={s.id}
            style={{
              display: 'grid',
              gridTemplateColumns: GRID,
              gap: '0 12px',
              alignItems: 'center',
              padding: '11px 14px',
              borderTop: '1px solid var(--row-line)',
              background: s.status === 'failed' ? 'var(--danger-bg-2)' : 'var(--surface)',
            }}
          >
            <div style={{ font: "500 12px 'Geist', sans-serif" }}>{s.label}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--secondary-2)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.url}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
              {s.kind === 'llms-txt' ? 'feed' : s.kind === 'sitemap' ? 'crawl' : 'file'}
            </div>
            <div className="t-small">
              {s.last_ingested_at ? new Date(s.last_ingested_at).toLocaleDateString() : '—'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Dot
                color={s.status === 'failed' ? '#b3261e' : s.status === 'ingesting' ? '#c05310' : '#9a9da2'}
                spin={s.status === 'ingesting'}
              />
              <span className="t-small mono">{s.status}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <button
                className="btn btn-ghost"
                disabled={s.status === 'ingesting' || busy === s.id}
                onClick={() => {
                  setBusy(s.id);
                  setIngestFailed(null);
                  void api
                    .ingestKbSource({ sourceId: s.id })
                    // Both ways, because a refused ingest is exactly when the row is
                    // most worth re-reading: the failure is recorded on the source
                    // itself, and `.then(load)` alone would never go and fetch it,
                    // leaving the row spinning at "ingesting" forever.
                    .catch((e: Error) => setIngestFailed(e.message))
                    .then(load)
                    // `finally`, or a failed re-read leaves "Re-read" disabled for
                    // the rest of the session — on the row most likely to need it.
                    .finally(() => setBusy(null));
                }}
              >
                Re-read
              </button>
            </div>
            {s.status === 'failed' || s.last_error ? (
              <div
                style={{
                  gridColumn: '1 / -1',
                  marginTop: 9,
                  padding: '9px 11px',
                  background: 'var(--danger-bg)',
                  border: '1px solid var(--danger-border-2)',
                  borderRadius: 6,
                  font: "400 12px/1.6 'Geist', sans-serif",
                  color: 'var(--danger-3)',
                }}
              >
                {s.last_error ?? 'The last read of this source failed.'} The assistant still
                answers from the last good copy — say so rather than going quiet.
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="t-small" style={{ marginTop: 12 }}>
        Every answer cites the articles it drew from.
      </div>
    </>
  );
}

/* ── 12 Usage & cost ────────────────────────────────────────────────────── */

function Usage({ money }: { money: boolean }) {
  const [usage, setUsage] = useState<{
    total: string;
    currency: string;
    lines: { meterKey: string; qty: string; unitPrice: string; amount: string; entryCount: number }[];
  } | null>(null);
  const [closing, setClosing] = useState(false);
  const month = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  useEffect(() => {
    if (money) void api.usageSummary({}).then(setUsage as never);
  }, [money]);

  if (!money)
    return <Empty title="Usage is the desk admin's" note="Your account does not hold `usage:read`." />;
  if (!usage) return <div className="t-meta">Loading…</div>;

  return (
    <>
      <Head title="Usage & cost" note={`${month} · what the assistant has spent`} />
      <div className="card" style={{ overflow: 'hidden', marginBottom: 18 }}>
        <div
          className="micro-6"
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 110px 150px 100px',
            gap: '0 12px',
            padding: '9px 14px',
            color: 'var(--muted)',
          }}
        >
          <div>Meter</div>
          <div style={{ textAlign: 'right' }}>Quantity</div>
          <div style={{ textAlign: 'right' }}>Unit price</div>
          <div style={{ textAlign: 'right' }}>Amount</div>
        </div>
        {usage.lines.map((l) => (
          <div
            key={l.meterKey}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 110px 150px 100px',
              gap: '0 12px',
              alignItems: 'center',
              padding: '11px 14px',
              borderTop: '1px solid var(--row-line)',
            }}
          >
            <div className="mono" style={{ fontSize: 12 }}>
              {l.meterKey}
            </div>
            <div className="mono" style={{ fontSize: 12, textAlign: 'right' }}>
              {Number(l.qty).toLocaleString()}
            </div>
            <div style={{ textAlign: 'right' }}>
              <UnitPrice amount={l.unitPrice} />
            </div>
            <div className="mono" style={{ fontSize: 12, textAlign: 'right' }}>
              ${Number(l.amount).toFixed(4)}
            </div>
          </div>
        ))}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            padding: '13px 14px',
            borderTop: '1px solid var(--hairline)',
            background: 'var(--app-bg)',
          }}
        >
          <span className="micro">Total</span>
          <span style={{ font: "600 17px 'Geist Mono', monospace", letterSpacing: '-.01em' }}>
            ${Number(usage.total).toFixed(2)}
          </span>
        </div>
      </div>

      <div
        style={{
          border: '1px solid var(--hairline)',
          borderRadius: 8,
          padding: 14,
          background: 'var(--surface)',
        }}
      >
        <div className="t-strong" style={{ marginBottom: 5 }}>
          Close {month.split(' ')[0]}
        </div>
        <div className="t-small" style={{ marginBottom: 12, lineHeight: 1.6 }}>
          Closing freezes the window into immutable lines and moves the horizon forward.
          Nothing can be recorded behind it afterwards, and a closed month cannot be
          reopened.
        </div>
        <button
          className="btn"
          style={{
            background: 'var(--danger-bg)',
            borderColor: 'var(--danger-border)',
            color: 'var(--danger-2)',
          }}
          disabled={closing}
          onClick={() => {
            setClosing(true);
            const now = new Date();
            const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
            void api
              .closeUsagePeriod({ from, to: now.toISOString() })
              .then(() => api.usageSummary({}))
              .then(setUsage as never)
              .finally(() => setClosing(false));
          }}
        >
          {closing ? 'Closing…' : `Close ${month.split(' ')[0]}…`}
        </button>
      </div>
    </>
  );
}
