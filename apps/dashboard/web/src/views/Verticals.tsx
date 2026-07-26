import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import { api, connectGithub, type Deployment, type DeploymentVersion, type GitReposResult, type WorkflowPreview } from '../lib/api';
import { Ic } from '../lib/icons';
import { Page, GridTable, Row } from '../components/layout';
import { card, CopyButton, Pill, PageTitle, MonoTag, type PillKind } from '../components/ui';

/**
 * Verticals (builder-plane.md Phase 4; formerly "Deployments") — the supply side of the
 * marketplace split. An APP is an installed instance with its own data; a VERTICAL is the
 * software it runs: pushed versions, admission state, channels, and (later) marketplace
 * publishing. This page owns everything vertical-level: the pushed list, dev/staging
 * promotion (`prod` stays a staff decision, model B), and the ways a vertical comes into
 * existence — the GitHub import + one-click CI scaffold (moved here from Create-app: a
 * repo import produces a pushed VERSION, not a running app) and the CLI push.
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

const CHANNEL_PILL: Record<string, PillKind> = { prod: 'success', staging: 'info', dev: 'neutral' };

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
  onPromote: (channel: 'dev' | 'staging') => void;
}) {
  const here = channelsFor(d, v.id);
  const admitted = v.admission === 'admitted';
  return (
    <Row columns="1.2fr 1fr 1.4fr 1.6fr" last={last}>
      <span style={{ fontWeight: 500 }}>{v.version}</span>
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
        {/* A builder self-serves non-prod. Only an ADMITTED version can be promoted. */}
        {(['dev', 'staging'] as const).map((ch) =>
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

function VerticalCard({
  d,
  busy,
  onPromote,
}: {
  d: Deployment;
  busy: boolean;
  onPromote: (versionId: string, channel: 'dev' | 'staging') => void;
}) {
  const prod = d.channels.find((c) => c.channel === 'prod');
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{d.name}</h3>
        <MonoTag>{d.displaySlug}</MonoTag>
        {/* Marketplace visibility (marketplace-publish.md §2): private on push; the
            staff-reviewed publish action flips it. The request button is a later phase. */}
        <Pill kind={d.listed ? 'success' : 'neutral'}>{d.listed ? 'Published' : 'Private'}</Pill>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-tertiary)' }}>
          {prod ? (
            <>
              prod at <MonoTag>{d.versions.find((v) => v.id === prod.versionId)?.version ?? prod.versionId}</MonoTag>
            </>
          ) : (
            'not in production'
          )}
        </span>
      </div>
      {d.versions.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-tertiary)', fontSize: 13 }}>
          No versions yet — <code>substrat push</code> one.
        </div>
      ) : (
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
      )}
    </div>
  );
}

export function Verticals({
  deployments,
  onPromote,
  busy,
  loadGitRepos,
}: {
  deployments: Deployment[];
  onPromote: (slug: string, versionId: string, channel: 'dev' | 'staging') => void;
  busy: boolean;
  loadGitRepos: () => Promise<GitReposResult>;
}) {
  // The repo picked for CI setup — swaps the add-a-vertical section for the scaffold panel.
  const [repo, setRepo] = useState<{ fullName: string; branch: string } | null>(null);
  const [git, setGit] = useState<GitReposResult | null>(null);
  const [gitError, setGitError] = useState(false);
  useEffect(() => {
    let live = true;
    loadGitRepos()
      .then((r) => live && setGit(r))
      .catch(() => live && setGitError(true));
    return () => {
      live = false;
    };
  }, [loadGitRepos]);

  // Sort newest-active first by the most recent version id.
  const sorted = useMemo(
    () => [...deployments].sort((a, b) => (a.versions[0]?.id ?? '') < (b.versions[0]?.id ?? '') ? 1 : -1),
    [deployments],
  );

  return (
    <Page>
      <PageTitle
        title="Verticals"
        subtitle="The software your team builds — every app is an install of a vertical. Promote dev and staging yourself; production and marketplace listing are reviewed by the Substrat team."
      />
      {sorted.length === 0 ? (
        <div style={{ padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
          Nothing pushed yet — import a repository or push from your terminal below.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 28 }}>
          {sorted.map((d) => (
            <VerticalCard key={d.slug} d={d} busy={busy} onPromote={(vid, ch) => onPromote(d.slug, vid, ch)} />
          ))}
        </div>
      )}

      <div style={{ marginTop: sorted.length === 0 ? 0 : 16, display: 'grid', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Add a vertical</h3>
        {repo ? (
          <RepoDeploy repo={repo} onBack={() => setRepo(null)} onDone={() => setRepo(null)} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 16, alignItems: 'start' }}>
            <GitImportCard git={git} error={gitError} onPick={setRepo} />
            <CliPushPanel />
          </div>
        )}
      </div>
    </Page>
  );
}

/** The CLI alternative to the repo import — the same push seam, from a terminal. */
function CliPushPanel() {
  const cmd = 'npx @substrat-run/cli push . --slug my-app --version 0.1.0';
  return (
    <div style={{ background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)' }}>Or push from your terminal</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 6, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>
        <span style={{ color: 'var(--text-tertiary)' }}>$</span>
        <span style={{ flex: 1 }}>{cmd}</span>
        <CopyButton text={cmd} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Run <span style={{ fontFamily: 'var(--font-mono)' }}>login</span> first. A push lands a pending version — promote it to a channel to go live.</div>
    </div>
  );
}

/** Connect GitHub, then list + import repos. Picking one opens the CI scaffold panel. */
function GitImportCard({ git, error, onPick }: { git: GitReposResult | null; error: boolean; onPick: (repo: { fullName: string; branch: string }) => void }) {
  const [filter, setFilter] = useState('');
  const repos = git?.repos ?? [];
  const shown = filter.trim() ? repos.filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase())) : repos;

  return (
    <div style={{ ...card, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Import a Git repository</span>
          {git?.connected && git.account && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 8px', border: '1px solid var(--border-default)', borderRadius: 6, background: 'var(--surface-card)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {git.account}
            </span>
          )}
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
            <Button variant="secondary" size="sm" onClick={() => onPick({ fullName: r.fullName, branch: r.defaultBranch })}>Import</Button>
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
function RepoDeploy({ repo, onBack, onDone }: { repo: { fullName: string; branch: string }; onBack: () => void; onDone: () => void }) {
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
      .gitBranches(repo.fullName)
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
  }, [repo.fullName, repo.branch]);

  const setup = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.setupCi(repo.fullName, branch);
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
              Every push to <span style={{ fontFamily: 'var(--font-mono)' }}>{branch}</span> now builds and pushes a version of{' '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>{done.vertical}</span>. Versions land <em>pending</em> above.
              Prod promotion + admission stay a Substrat-team decision.
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
            secret. Each push then builds and pushes a version; the first lands <em>pending</em> — promote it to a channel above.
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
