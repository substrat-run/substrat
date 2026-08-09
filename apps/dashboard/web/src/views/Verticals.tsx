import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import {
  api,
  connectGithub,
  ApiError,
  type ChannelHistoryEntry,
  type DeployFailureRow,
  type Deployment,
  type DeploymentVersion,
  type GitReposResult,
  type VerticalPreview,
  type WorkflowPreview,
} from '../lib/api';
import { Ic } from '../lib/icons';
import { DEV_MOCK, MOCK_FAILURES, MOCK_PREVIEWS } from '../lib/mock';
import { Page, GridTable, Row } from '../components/layout';
import { card, CopyButton, OriginTag, Pill, PageTitle, MonoTag, type PillKind } from '../components/ui';

/**
 * Verticals (builder-plane.md Phase 4; formerly "Deployments") — the supply side of the
 * marketplace split. An APP is an installed instance with its own data; a VERTICAL is the
 * software it runs: pushed versions, admission state, channels, and (later) marketplace
 * publishing. This page owns everything vertical-level: the pushed list, channel
 * promotion — every channel of a PRIVATE vertical including prod (rollback = promote an
 * older version; prod of a LISTED vertical stays a staff decision), the prod go-live
 * history, and the ways a vertical comes into existence — the GitHub import + one-click
 * CI scaffold (moved here from Create-app: a repo import produces a pushed VERSION, not
 * a running app) and the CLI push.
 */

const ADMISSION_PILL: Record<string, PillKind> = {
  admitted: 'success',
  pending: 'warning',
  rejected: 'danger',
};

/** Which channels point at a given version id. */
function channelsFor(d: Deployment, versionId: string): string[] {
  return d.channels.filter((c) => c.versionId === versionId).map((c) => c.channel);
}

const CHANNEL_PILL: Record<string, PillKind> = { prod: 'success' };

function VersionRow({
  d,
  v,
  last,
  busy,
  onPromote,
}: {
  d: Deployment;
  v: DeploymentVersion;
  last: boolean;
  busy: boolean;
  onPromote: (channel: 'prod') => void;
}) {
  const here = channelsFor(d, v.id);
  const admitted = v.admission === 'admitted';
  // Only offer a channel the platform actually SERVES. `prod` is the sole serving pointer
  // (dev/staging are write-only — no reader consults them, issue #509 §2), so we never render
  // a button that does nothing. A PRIVATE vertical's prod is self-serve — which is also how
  // rollback works (promote the older version); a LISTED vertical's prod is a staff decision,
  // so it has no self-serve promote at all (use a preview to exercise a version, ask (d)).
  const channels = d.listed ? ([] as const) : (['prod'] as const);
  return (
    <Row columns="1.2fr 1fr 1.4fr 1.6fr" last={last}>
      <span style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
        {v.version}
        {/* #286: promoting this version migrates every instance's data in place —
            the badge is the at-a-glance half of the acknowledgement gate. */}
        {v.schemaChange && <Pill kind="warning">schema change</Pill>}
        {/* Where the push came from — the repo's deploy workflow vs someone's terminal. */}
        <OriginTag origin={v.origin} />
      </span>
      <span>
        <Pill kind={ADMISSION_PILL[v.admission] ?? 'neutral'}>{v.admission}</Pill>
      </span>
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {here.length === 0 ? (
          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        ) : (
          here.map((ch) => (
            <Pill key={ch} kind={CHANNEL_PILL[ch] ?? 'neutral'}>
              {ch}
            </Pill>
          ))
        )}
      </span>
      <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {/* Only an ADMITTED version can be promoted. */}
        {channels.map((ch) =>
          here.includes(ch) ? null : (
            <Button
              key={ch}
              variant="ghost"
              size="sm"
              disabled={!admitted || busy}
              onClick={() => onPromote(ch)}
            >
              → {ch}
            </Button>
          ),
        )}
      </span>
    </Row>
  );
}

/**
 * The prod go-live timeline — every promotion ever made, newest first, with who and
 * exactly when. Rolling back is promoting the older version again (a new history entry,
 * never a rewrite); the recorded instant is also what a point-in-time data restore
 * would rewind to, which is why it is kept here and not reconstructed later.
 */
function ProdHistory({
  d,
  busy,
  onPromote,
}: {
  d: Deployment;
  busy: boolean;
  onPromote: (versionId: string, channel: 'prod') => void;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ChannelHistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const prod = d.channels.find((c) => c.channel === 'prod');

  useEffect(() => {
    if (!open || DEV_MOCK) return;
    let live = true;
    setFailed(false);
    api
      .channelHistory(d.slug, 'prod')
      .then((h) => live && setEntries(h))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // Re-fetch when the pointer moves (a promote just happened).
  }, [open, d.slug, prod?.versionId]);

  if (!prod) return null; // never went live — nothing to roll back to
  const label = (id: string) => d.versions.find((v) => v.id === id)?.version ?? id;

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 'fit-content' }}
      >
        {open ? 'Hide go-live history' : 'Go-live history'}
      </a>
      {open &&
        (failed ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>History is unavailable right now.</div>
        ) : entries === null ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading…</div>
        ) : entries.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No promotions recorded yet.</div>
        ) : (
          <GridTable columns="1fr 1fr 1.4fr 1fr" header={['Went live', 'Replaced', 'When', '~']}>
            {entries.map((h, i) => (
              <Row key={h.id} columns="1fr 1fr 1.4fr 1fr" last={i === entries.length - 1}>
                <MonoTag>{label(h.versionId)}</MonoTag>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>
                  {h.fromVersionId ? label(h.fromVersionId) : '—'}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {new Date(h.at).toLocaleString()}
                </span>
                <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  {/* Current prod gets no button; anything older can come back. */}
                  {h.versionId === prod.versionId || d.listed ? null : (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => onPromote(h.versionId, 'prod')}>
                      Roll back
                    </Button>
                  )}
                </span>
              </Row>
            ))}
          </GridTable>
        ))}
    </div>
  );
}

/** How many version rows a card shows before the "all versions" link expands it. */
const VERSIONS_PREVIEW = 3;

function VerticalCard({
  d,
  busy,
  onPromote,
  onRemove,
  onOpen,
}: {
  d: Deployment;
  busy: boolean;
  onPromote: (versionId: string, channel: 'prod') => void;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const prod = d.channels.find((c) => c.channel === 'prod');
  // The card is a summary: newest few versions, with the full list (and the go-live
  // history) living on the vertical's detail page — the title and the count both open it.
  const shown = d.versions.slice(0, VERSIONS_PREVIEW);
  const hidden = d.versions.length - shown.length;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onOpen();
          }}
          style={{ textDecoration: 'none' }}
        >
          <h3 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>{d.name}</h3>
        </a>
        <MonoTag>{d.displaySlug}</MonoTag>
        {/* Marketplace visibility (marketplace-publish.md §2): private on push; the
            staff-reviewed publish action flips it. The request button is a later phase. */}
        <Pill kind={d.listed ? 'success' : 'neutral'}>{d.listed ? 'Published' : 'Private'}</Pill>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {prod ? (
              <>
                prod at <MonoTag>{d.versions.find((v) => v.id === prod.versionId)?.version ?? prod.versionId}</MonoTag>
              </>
            ) : (
              'not in production'
            )}
          </span>
          {/* Removing a PUBLISHED vertical is a staff decision (same split as prod
              promotion), so the button only renders while it's private. */}
          {!d.listed && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onRemove}
              style={{ color: 'var(--status-danger-fg)' }}
            >
              Remove
            </Button>
          )}
        </span>
      </div>
      {d.versions.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-tertiary)', fontSize: 13 }}>
          No versions yet — <code>substrat push</code> one.
        </div>
      ) : (
        <>
          <GridTable columns="1.2fr 1fr 1.4fr 1.6fr" header={['Version', 'Admission', 'Channels', '~Promote']}>
            {shown.map((v, i) => (
              <VersionRow
                key={v.id}
                d={d}
                v={v}
                last={i === shown.length - 1}
                busy={busy}
                onPromote={(ch) => onPromote(v.id, ch)}
              />
            ))}
          </GridTable>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpen();
            }}
            style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 'fit-content' }}
          >
            {hidden > 0 ? `View all ${d.versions.length} versions →` : 'View details →'}
          </a>
        </>
      )}
    </div>
  );
}

/**
 * A single vertical, full-page (builder-plane.md Phase 4) — the detail the summary card
 * links to. Every pushed version (not just the newest few), the same self-serve channel
 * promotion, and the prod go-live history / rollback that used to be an inline expand.
 */
/**
 * Previews & environments (#509) — the builder-facing half of `substrat preview`. A
 * non-production environment is not a second channel; it is a scope with data bound to a
 * version, at its own URL. Create one of an admitted version (fork prod, or a clean-room
 * `empty` scope); pin it and give it a custom domain to make a long-lived test environment
 * (crm-test.…). Available for a vertical you own whether private or listed (#513).
 */
function PreviewsPanel({ d, busy }: { d: Deployment; busy: boolean }) {
  const [previews, setPreviews] = useState<VerticalPreview[] | null>(DEV_MOCK ? MOCK_PREVIEWS : null);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const admitted = useMemo(() => d.versions.filter((v) => v.admission === 'admitted'), [d.versions]);

  // Create form.
  const [tag, setTag] = useState('');
  const [versionId, setVersionId] = useState('');
  const [pin, setPin] = useState(false);
  const [empty, setEmpty] = useState(false);
  // Per-preview inline "attach domain" input, keyed by tag.
  const [domainFor, setDomainFor] = useState<string | null>(null);
  const [domain, setDomain] = useState('');

  const reload = () => {
    if (DEV_MOCK) return;
    void api
      .listPreviews(d.slug)
      .then((p) => {
        setPreviews(p);
        setErr(null);
      })
      // 501 = no shared control plane (embedded/self-host) — the surface simply isn't available.
      .catch((e) => setErr(e instanceof ApiError && e.status === 501 ? null : e instanceof Error ? e.message : 'failed to load'));
  };
  useEffect(reload, [d.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (!tag || !versionId) return;
    setWorking(true);
    setErr(null);
    try {
      await api.createPreview(d.slug, { tag, versionId, ...(pin ? { ttlHours: null } : {}), ...(empty ? { empty: true } : {}) });
      setTag('');
      setVersionId('');
      setPin(false);
      setEmpty(false);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not create preview');
    } finally {
      setWorking(false);
    }
  };

  const remove = async (t: string) => {
    setWorking(true);
    try {
      await api.deletePreview(d.slug, t);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not delete preview');
    } finally {
      setWorking(false);
    }
  };

  const attachDomain = async (t: string) => {
    if (!domain) return;
    setWorking(true);
    setErr(null);
    try {
      await api.addPreviewDomain(d.slug, t, { domain });
      setDomain('');
      setDomainFor(null);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not attach domain');
    } finally {
      setWorking(false);
    }
  };

  // No shared plane, or the vertical has no admitted version to preview — nothing to show.
  if (previews === null && err === null) return null;
  const disabled = busy || working;

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Previews &amp; environments</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          A non-production environment is a scope with data bound to a version, at its own URL. Pin one and add a
          custom domain to make a long-lived test environment.
        </p>
      </div>

      {previews && previews.length > 0 && (
        <GridTable columns="0.9fr 0.8fr 1.8fr 1fr 0.8fr" header={['Tag', 'Version', 'URL', 'Expiry', '~Actions']}>
          {previews.map((p, i) => {
            const ver = d.versions.find((v) => v.id === p.versionId)?.version ?? '—';
            return (
              <Row key={p.scopeId} columns="0.9fr 0.8fr 1.8fr 1fr 0.8fr" last={i === previews.length - 1}>
                <span style={{ fontWeight: 500 }}>{p.tag ?? '—'}</span>
                <span><MonoTag>{ver}</MonoTag></span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  {p.url ? (
                    <>
                      <a href={p.url} target="_blank" rel="noreferrer" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.hostname}
                      </a>
                      <CopyButton text={p.url} size={12} />
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  )}
                </span>
                <span>
                  {p.expiresAt === null ? (
                    <Pill kind="info">pinned</Pill>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      {new Date(p.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                </span>
                <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setDomainFor(domainFor === p.tag ? null : p.tag)}>
                    Domain
                  </Button>
                  <Button variant="ghost" size="sm" disabled={disabled} onClick={() => remove(p.tag!)} style={{ color: 'var(--status-danger-fg)' }}>
                    Delete
                  </Button>
                </span>
              </Row>
            );
          })}
        </GridTable>
      )}

      {domainFor && (
        <div style={{ ...card, padding: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Custom domain for <strong>{domainFor}</strong>:
          </span>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="crm-test.ahero.se" style={{ minWidth: 220 }} />
          <Button size="sm" disabled={disabled || !domain} onClick={() => attachDomain(domainFor)}>
            Add domain
          </Button>
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
            Lands pending — publish the DNS records it returns, then it goes live.
          </span>
        </div>
      )}

      <div style={{ ...card, padding: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="tag (e.g. test, pr-42)" style={{ minWidth: 150 }} />
        <Select
          size="sm"
          value={versionId}
          onChange={(e) => setVersionId(e.target.value)}
          style={{ minWidth: 160 }}
          options={[{ value: '', label: 'version…' }, ...admitted.map((v) => ({ value: v.id, label: v.version }))]}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
          <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> pin (test env)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
          <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} /> clean room
        </label>
        <Button size="sm" disabled={disabled || !tag || !versionId} onClick={create}>
          New preview
        </Button>
        {admitted.length === 0 && (
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No admitted version to preview yet.</span>
        )}
      </div>

      {err && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{err}</p>}
    </div>
  );
}

/**
 * The vertical's recorded deploy/preview/provision failures (#559) — why a red CI run
 * was red, from the platform's durable record, without asking staff. A `reference` is
 * Cloudflare's redacted-fault handle: it means the failure was the platform's (not the
 * pushed code), and the handle is what a support ticket needs. Empty = nothing recent —
 * the panel renders nothing rather than an empty table.
 */
function FailuresPanel({ d }: { d: Deployment }) {
  const [rows, setRows] = useState<DeployFailureRow[] | null>(DEV_MOCK ? MOCK_FAILURES : null);

  useEffect(() => {
    if (DEV_MOCK) return;
    let live = true;
    api
      .listFailures(d.slug)
      .then((r) => live && setRows(r))
      // Tolerated to nothing: a worker or plane predating the route costs the panel, not the page.
      .catch(() => live && setRows(null));
    return () => {
      live = false;
    };
  }, [d.slug]);

  if (!rows || rows.length === 0) return null;

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Recent failures</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          What the platform could not do, newest first. A <code>reference</code> is a Cloudflare
          support handle — the failure was platform-side, not your code.
        </p>
      </div>
      <GridTable columns="1.1fr 1.3fr 0.5fr 2fr 1.2fr" header={['When', 'Operation', 'Status', 'Detail', 'Reference']}>
        {rows.map((f, i) => (
          <Row key={f.id} columns="1.1fr 1.3fr 0.5fr 2fr 1.2fr" last={i === rows.length - 1}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{new Date(f.at).toLocaleString()}</span>
            <span>
              <MonoTag>{f.operation}</MonoTag>
              {f.stage && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}> · {f.stage}</span>}
            </span>
            <span>
              <Pill kind={f.status !== null && f.status >= 500 ? 'danger' : 'warning'}>{f.status ?? '—'}</Pill>
            </span>
            <span
              title={f.message}
              style={{ fontSize: 12.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {f.message}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {f.reference ? (
                <>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.reference}
                  </span>
                  <CopyButton text={f.reference} size={12} />
                </>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>—</span>
              )}
            </span>
          </Row>
        ))}
      </GridTable>
    </div>
  );
}

export function VerticalDetail({
  d,
  busy,
  onPromote,
  onRemove,
  onBack,
}: {
  d: Deployment;
  busy: boolean;
  onPromote: (versionId: string, channel: 'prod') => void;
  onRemove: () => void;
  onBack: () => void;
}) {
  const prod = d.channels.find((c) => c.channel === 'prod');
  return (
    <Page>
      <div style={{ display: 'grid', gap: 20 }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onBack();
            }}
            style={{ fontSize: 12.5, color: 'var(--text-tertiary)', width: 'fit-content' }}
          >
            ← All verticals
          </a>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>{d.name}</h2>
            <MonoTag>{d.displaySlug}</MonoTag>
            {/* Marketplace visibility (marketplace-publish.md §2): private on push; the
                staff-reviewed publish action flips it. */}
            <Pill kind={d.listed ? 'success' : 'neutral'}>{d.listed ? 'Published' : 'Private'}</Pill>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {prod ? (
                  <>
                    prod at <MonoTag>{d.versions.find((v) => v.id === prod.versionId)?.version ?? prod.versionId}</MonoTag>
                  </>
                ) : (
                  'not in production'
                )}
              </span>
              {/* Removing a PUBLISHED vertical is a staff decision (same split as prod
                  promotion), so the button only renders while it's private. */}
              {!d.listed && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={onRemove}
                  style={{ color: 'var(--status-danger-fg)' }}
                >
                  Remove
                </Button>
              )}
            </span>
          </div>
        </div>
        {d.versions.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--text-tertiary)', fontSize: 13 }}>
            No versions yet — <code>substrat push</code> one.
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Versions</h3>
              <GridTable columns="1.2fr 1fr 1.4fr 1.6fr" header={['Version', 'Admission', 'Channels', '~Promote']}>
                {d.versions.map((v, i) => (
                  <VersionRow
                    key={v.id}
                    d={d}
                    v={v}
                    last={i === d.versions.length - 1}
                    busy={busy}
                    onPromote={(ch) => onPromote(v.id, ch)}
                  />
                ))}
              </GridTable>
            </div>
            <ProdHistory d={d} busy={busy} onPromote={onPromote} />
            <PreviewsPanel d={d} busy={busy} />
            <FailuresPanel d={d} />
          </>
        )}
      </div>
    </Page>
  );
}

export function Verticals({
  deployments,
  onPromote,
  onRemove,
  onOpen,
  busy,
  loadGitRepos,
}: {
  deployments: Deployment[];
  onPromote: (slug: string, versionId: string, channel: 'prod') => void;
  onRemove: (slug: string) => void;
  onOpen: (slug: string) => void;
  busy: boolean;
  loadGitRepos: (account?: string) => Promise<GitReposResult>;
}) {
  // The repo picked for CI setup — swaps the add-a-vertical section for the scaffold panel.
  const [repo, setRepo] = useState<{ fullName: string; branch: string; account?: string } | null>(null);
  const [git, setGit] = useState<GitReposResult | null>(null);
  // Which connected GitHub account (namespace) the repo list shows — undefined = default.
  const [gitAccount, setGitAccount] = useState<string | undefined>(undefined);
  const [gitError, setGitError] = useState(false);
  useEffect(() => {
    let live = true;
    setGit(null);
    setGitError(false);
    loadGitRepos(gitAccount)
      .then((r) => live && setGit(r))
      .catch(() => live && setGitError(true));
    return () => {
      live = false;
    };
  }, [loadGitRepos, gitAccount]);

  // Sort newest-active first by the most recent version id.
  const sorted = useMemo(
    () => [...deployments].sort((a, b) => (a.versions[0]?.id ?? '') < (b.versions[0]?.id ?? '') ? 1 : -1),
    [deployments],
  );

  return (
    <Page>
      <PageTitle
        title="Verticals"
        subtitle="The software your team builds — every app is an install of a vertical. A private vertical is yours end to end: promote any channel, prod included, and roll back from the go-live history. Marketplace listing — and prod of a listed vertical — is reviewed by the Substrat team."
      />
      {sorted.length === 0 ? (
        <div style={{ padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
          Nothing pushed yet — import a repository or push from your terminal below.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 28 }}>
          {sorted.map((d) => (
            <VerticalCard key={d.slug} d={d} busy={busy} onPromote={(vid, ch) => onPromote(d.slug, vid, ch)} onRemove={() => onRemove(d.slug)} onOpen={() => onOpen(d.slug)} />
          ))}
        </div>
      )}

      <div style={{ marginTop: sorted.length === 0 ? 0 : 16, display: 'grid', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Add a vertical</h3>
        {repo ? (
          <RepoDeploy repo={repo} onBack={() => setRepo(null)} onDone={() => setRepo(null)} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 16, alignItems: 'start' }}>
            <GitImportCard git={git} error={gitError} onPick={setRepo} onSelectAccount={setGitAccount} />
            <CliPushPanel />
          </div>
        )}
      </div>
    </Page>
  );
}

/**
 * The CLI alternative to the repo import — the same push seam, from a terminal.
 * The command carries no flags on purpose: run from the vertical's directory,
 * `push` derives the slug from package.json and auto-bumps the version, so the
 * shortest command is also the correct one (and it fits the narrow column).
 */
function CliPushPanel() {
  const cmd = 'npx @substrat-run/cli push';
  return (
    <div style={{ background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)' }}>Or push from your terminal</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 6, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)', minWidth: 0 }}>
        <span style={{ color: 'var(--text-tertiary)' }}>$</span>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflowX: 'auto' }}>{cmd}</span>
        <CopyButton text={cmd} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
        Run <span style={{ fontFamily: 'var(--font-mono)' }}>login</span> first, then push from your vertical's directory —
        the name comes from package.json and the version bumps itself. Add{' '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>--promote prod</span> to go live in one step.
      </div>
    </div>
  );
}

/**
 * Connect GitHub, then list + import repos. Picking one opens the CI scaffold panel.
 * Several GitHub accounts (namespaces, Vercel-style) may be connected; the picker
 * switches which account's repos are listed, and connecting another account is the
 * same App-install flow as the first.
 */
function GitImportCard({ git, error, onPick, onSelectAccount }: { git: GitReposResult | null; error: boolean; onPick: (repo: { fullName: string; branch: string; account?: string }) => void; onSelectAccount: (account: string) => void }) {
  const [filter, setFilter] = useState('');
  const repos = git?.repos ?? [];
  const shown = filter.trim() ? repos.filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase())) : repos;

  return (
    <div style={{ ...card, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Import a Git repository</span>
          {git?.connected && git.accounts.length > 1 ? (
            <Select
              options={git.accounts}
              value={git.account ?? git.accounts[0]}
              onChange={(e) => onSelectAccount(e.target.value)}
              style={{ width: 170, fontFamily: 'var(--font-mono)', fontSize: 12 }}
            />
          ) : git?.connected && git.account ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 8px', border: '1px solid var(--border-default)', borderRadius: 6, background: 'var(--surface-card)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {git.account}
            </span>
          ) : null}
        </div>
        {git?.connected && (
          <Input placeholder="Search repositories…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1 }} />
        )}
      </div>

      {error ? (
        <div style={{ padding: '20px 16px', fontSize: 12.5, color: 'var(--status-danger-fg)' }}>Couldn’t load repositories — try again.</div>
      ) : git === null ? (
        <div style={{ padding: '20px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading repositories…</div>
      ) : !git.configured ? (
        <div style={{ padding: '20px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          GitHub import isn’t set up on this deployment yet. Push from your terminal instead →
        </div>
      ) : !git.connected ? (
        <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Connect GitHub to import a repository and push a version on every push.</div>
          <Button onClick={connectGithub}>Connect GitHub</Button>
        </div>
      ) : shown.length === 0 ? (
        <div style={{ padding: '20px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {repos.length === 0 ? 'No repositories granted yet.' : 'No repositories match your search.'}
        </div>
      ) : (
        shown.map((r) => (
          <div key={r.fullName} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 52, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--brand-600)' }} />
            <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{r.fullName}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{`${r.private ? 'Private' : 'Public'} · default ${r.defaultBranch}`}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => onPick({ fullName: r.fullName, branch: r.defaultBranch, account: git?.account ?? undefined })}>Import</Button>
          </div>
        ))
      )}

      {git?.connected && (
        <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-tertiary)' }}>
          Missing a repository?{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              connectGithub();
            }}
          >
            Adjust the GitHub App’s access
          </a>
          {' · '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              // Same install flow — pick a different org/user on GitHub's chooser and
              // it lands as an additional namespace next to the ones already here.
              connectGithub();
            }}
          >
            Connect another GitHub account
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Deploy-from-GitHub (customer CI, one-click). A repo can't be provisioned directly —
 * building arbitrary repo code server-side is the model-A gap (self-serve-deploy.md) —
 * so the shipping path is CI: pick a branch and Set up deployment mints a tenant-scoped
 * push token, writes it as the repo's `SUBSTRAT_SERVICE_TOKEN` secret, and commits the
 * workflow — which triggers the first run immediately. The first version lands *pending*
 * in the list above. The copy-paste manual path remains as the fallback (older App
 * installations may lack the write permissions until re-approved).
 */
function RepoDeploy({ repo, onBack, onDone }: { repo: { fullName: string; branch: string; account?: string }; onBack: () => void; onDone: () => void }) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(repo.branch);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ workflowPath: string; workflowUpdated: boolean; vertical: string } | null>(null);
  const [needsPermissions, setNeedsPermissions] = useState(false);
  const [error, setError] = useState<string>();
  const [manual, setManual] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .gitBranches(repo.fullName, repo.account)
      .then((r) => {
        if (!live) return;
        const names = r.branches.map((b) => b.name);
        setBranches(names.length ? names : [repo.branch]);
      })
      // Branches are a nicety; the default branch always works (and dev-mock has no API).
      .catch(() => live && setBranches([repo.branch]));
    return () => {
      live = false;
    };
  }, [repo.fullName, repo.branch, repo.account]);

  const setup = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.setupCi(repo.fullName, branch, repo.account);
      if (result.ok) setDone(result);
      else setNeedsPermissions(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--brand-600)' }} />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {repo.fullName} <MonoTag>{branch}</MonoTag>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Push a version from GitHub on every push</div>
        </div>
        <div style={{ flex: 1 }} />
        <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }} style={{ fontSize: 12.5 }}>Change</a>
      </div>

      {done ? (
        <>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Ic name="check" size={14} color="var(--status-success-fg)" /> Deployment set up — the first build is running.
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span>
              {done.workflowUpdated ? 'Updated' : 'Committed'}{' '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>{done.workflowPath}</span> on{' '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>{branch}</span> and stored a deploy credential scoped to your
              workspace as the repository secret <span style={{ fontFamily: 'var(--font-mono)' }}>SUBSTRAT_SERVICE_TOKEN</span>.
            </span>
            <span>
              Every push to <span style={{ fontFamily: 'var(--font-mono)' }}>{branch}</span> now builds, pushes and promotes a
              version of <span style={{ fontFamily: 'var(--font-mono)' }}>{done.vertical}</span> to prod — merge to{' '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>{branch}</span> is the deploy. Roll back any time from the
              go-live history above.
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
            <Button onClick={onDone}>Done</Button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Substrat commits a deploy workflow to your repo and stores a workspace-scoped deploy credential as a repository
            secret. Each push to the branch then builds a version and promotes it to prod — merging is the deploy, and the
            go-live history above is the rollback.
          </div>

          <Select
            label="Branch to deploy from"
            options={branches ?? [branch]}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            style={{ width: 260 }}
          />

          {needsPermissions && (
            <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>
              The GitHub App is missing write access on this repository (an older installation). Re-approve the App's updated
              permissions on GitHub, or{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); setManual(true); }}>set it up manually</a>.{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); connectGithub(); }}>Review the App's access</a>
            </div>
          )}
          {error && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</div>}

          {manual && <ManualCiSetup repo={repo.fullName} branch={branch} />}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
            <Button onClick={setup} disabled={busy || branches === null}>{busy ? 'Setting up…' : 'Set up deployment'}</Button>
            <Button variant="ghost" onClick={onBack}>Back</Button>
            <div style={{ flex: 1 }} />
            {!manual && (
              <a href="#" onClick={(e) => { e.preventDefault(); setManual(true); }} style={{ fontSize: 12 }}>
                Set up manually instead
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The copy-paste fallback: the same workflow the one-click path would commit. */
function ManualCiSetup({ repo, branch }: { repo: string; branch: string }) {
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  useEffect(() => {
    let live = true;
    api
      .workflowPreview(repo, branch)
      .then((p) => live && setPreview(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [repo, branch]);

  if (!preview) return <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading workflow…</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
        Add this workflow at <span style={{ fontFamily: 'var(--font-mono)' }}>{preview.workflowPath}</span>, and add a repository
        secret <span style={{ fontFamily: 'var(--font-mono)' }}>SUBSTRAT_SERVICE_TOKEN</span> (a deploy credential for your
        workspace — ask us for one, or use Set up deployment above to store it automatically).
      </div>
      <div style={{ position: 'relative', background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px' }}>
        <div style={{ position: 'absolute', top: 8, right: 8 }}><CopyButton text={preview.workflow} /></div>
        <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)', whiteSpace: 'pre', overflowX: 'auto' }}>{preview.workflow}</pre>
      </div>
    </div>
  );
}
