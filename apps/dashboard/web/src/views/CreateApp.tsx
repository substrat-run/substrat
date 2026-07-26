import { useEffect, useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import { api, connectGithub, type CatalogEntry, type GitRepo, type GitReposResult, type WorkflowPreview } from '../lib/api';
import { ENV_OPTS, verticalMeta } from '../lib/demo';
import { Ic } from '../lib/icons';
import { slugify } from '../lib/format';
import { Page } from '../components/layout';
import { card, CopyButton, MonoTag } from '../components/ui';

interface Source {
  /** Display name of the picked repo/marketplace project. */
  title: string;
  engineLine: string;
  accent: string;
  origin: string;
  defaultName: string;
  /** The catalog slug the app is actually created under (marketplace sources only). */
  verticalSlug: string;
  /** Set for a GitHub source — routes to the CI-deploy panel, not the template create-path. */
  repo?: { fullName: string; branch: string };
}

/** Short marketing lines for the first-party templates the live catalog can offer.
 *  These describe real, instantiable verticals — not placeholder projects. */
const TEMPLATE_BLURBS: Record<string, string> = {
  protocol: 'Documents, protocols & e-signing',
  documents: 'Documents, protocols & e-signing',
  callout: 'Work orders, time & material, self-inspection',
  workorder: 'Work orders, time & material, self-inspection',
};

/**
 * Create App (screens 1g, 1h). Step 1 picks a source. The **marketplace** column
 * is live: it lists the real catalog (`GET /api/catalog`) — the first-party
 * templates this tenant can actually instantiate — and Deploy provisions under
 * that template's true slug. The **Git import** column is still a design preview
 * (the repos are demo) until the GitHub connection lands. Step 2 configures +
 * creates: the name and URL are real inputs, and Create calls `POST /api/apps`.
 */
export function CreateApp({
  catalog,
  loadGitRepos,
  onCancel,
  onCreate,
}: {
  catalog: CatalogEntry[];
  loadGitRepos: () => Promise<GitReposResult>;
  onCancel: () => void;
  onCreate: (input: { verticalSlug: string; name: string }) => Promise<void>;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const fallbackSlug = catalog[0]?.slug ?? 'protocol';
  // A source's desired slug is honoured only if the live catalog actually offers
  // it (entitlements gate what's instantiable); otherwise it falls back to the
  // first available vertical. So the Callout tile provisions a real Callout scope,
  // while a source with no real vertical still creates *something* rather than 400.
  const resolveSlug = (wanted: string) => (catalog.some((c) => c.slug === wanted) ? wanted : fallbackSlug);

  if (!source) {
    return (
      <ChooseSource
        catalog={catalog}
        loadGitRepos={loadGitRepos}
        onCancel={onCancel}
        onPick={(s) => setSource({ ...s, verticalSlug: resolveSlug(s.wantedSlug) })}
      />
    );
  }
  // A GitHub source can't provision through the template path (POST /api/apps instantiates
  // a catalog vertical, not arbitrary repo code — server-side build is the model-A gap). The
  // honest, shipping path is customer-CI: scaffold the deploy workflow, their push lands a version.
  if (source.repo) return <RepoDeploy repo={source.repo} onBack={() => setSource(null)} onCancel={onCancel} />;
  return <Configure source={source} onBack={() => setSource(null)} onCancel={onCancel} onCreate={onCreate} disabled={catalog.length === 0} />;
}

function Stepper({ step }: { step: 1 | 2 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: step === 1 ? 500 : 400, color: step === 1 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
        <span style={{ width: 20, height: 20, borderRadius: '50%', background: step === 1 ? 'var(--brand-600)' : 'var(--surface-active)', color: step === 1 ? '#fff' : undefined, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>
          {step === 1 ? '1' : <Ic name="check" size={12} color="var(--status-success-fg)" />}
        </span>
        Source
      </span>
      <span style={{ width: 48, height: 1, background: 'var(--border-strong)' }} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: step === 2 ? 500 : 400, color: step === 2 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
        <span style={{ width: 20, height: 20, borderRadius: '50%', background: step === 2 ? 'var(--brand-600)' : 'transparent', border: step === 2 ? 'none' : '1px solid var(--border-strong)', color: step === 2 ? '#fff' : undefined, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, boxSizing: 'border-box' }}>2</span>
        Configure
      </span>
    </div>
  );
}

function Header({ onCancel }: { onCancel: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Create an app</div>
      <div style={{ flex: 1 }} />
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

function SourceRow({ title, subtitle, accent, action, onAction, height = 52 }: { title: React.ReactNode; subtitle: string; accent: string; action: string; onAction: () => void; height?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent }} />
      <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{subtitle}</span>
      </span>
      <Button variant="secondary" size="sm" onClick={onAction}>{action}</Button>
    </div>
  );
}

type PickedSource = Omit<Source, 'verticalSlug'> & { wantedSlug: string };

function ChooseSource({
  catalog,
  loadGitRepos,
  onCancel,
  onPick,
}: {
  catalog: CatalogEntry[];
  loadGitRepos: () => Promise<GitReposResult>;
  onCancel: () => void;
  onPick: (s: PickedSource) => void;
}) {
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

  return (
    <Page maxWidth={960}>
      <Header onCancel={onCancel} />
      <Stepper step={1} />
      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 16, alignItems: 'start' }}>
        <GitImportCard git={git} error={gitError} onPick={onPick} />

        {/* Marketplace + CLI */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Start from a template</span>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>ready to deploy</span>
            </div>
            {catalog.length === 0 ? (
              <div style={{ padding: '20px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>No templates available on your plan yet.</div>
            ) : (
              catalog.map((entry) => {
                const meta = verticalMeta(entry.slug);
                return (
                  <SourceRow
                    key={entry.slug}
                    title={entry.name}
                    subtitle={TEMPLATE_BLURBS[entry.slug] ?? `${meta.label} template`}
                    accent={meta.accent}
                    action="Deploy"
                    height={56}
                    onAction={() => onPick({ title: entry.name, engineLine: `${meta.label} · deployed as your instance`, accent: meta.accent, origin: 'marketplace', defaultName: entry.name, wantedSlug: entry.slug })}
                  />
                );
              })
            )}
            <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-tertiary)' }}>Built something reusable? Publish it with <span style={{ fontFamily: 'var(--font-mono)' }}>substrat push</span>.</div>
          </div>
          <div style={{ background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)' }}>Or push from your terminal</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 6, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>
              <span style={{ color: 'var(--text-tertiary)' }}>$</span>
              <span style={{ flex: 1 }}>npx @substrat-run/cli push . --slug my-app --version 0.1.0</span>
              <CopyButton text="npx @substrat-run/cli push . --slug my-app --version 0.1.0" />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Run <span style={{ fontFamily: 'var(--font-mono)' }}>login</span> first. A push lands a pending version — promote it to a channel to go live.</div>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        Templates deploy as your own instance — your data, your domain. Which engines you can instantiate comes from your plan’s entitlements.
      </div>
    </Page>
  );
}

/** The left column: connect GitHub, then list + import repos. Live (no more demo repos). */
function GitImportCard({ git, error, onPick }: { git: GitReposResult | null; error: boolean; onPick: (s: PickedSource) => void }) {
  const [filter, setFilter] = useState('');
  const repos = git?.repos ?? [];
  const shown = filter.trim() ? repos.filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase())) : repos;
  const accent = 'var(--brand-600)';

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
          GitHub import isn’t set up on this deployment yet. Start from a template, or push from your terminal →
        </div>
      ) : !git.connected ? (
        <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Connect GitHub to import a repository and deploy it on every push.</div>
          <Button onClick={connectGithub}>Connect GitHub</Button>
        </div>
      ) : shown.length === 0 ? (
        <div style={{ padding: '20px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {repos.length === 0 ? 'No repositories granted yet.' : 'No repositories match your search.'}
        </div>
      ) : (
        shown.map((r) => (
          <SourceRow
            key={r.fullName}
            title={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{r.fullName}</span>}
            subtitle={`${r.private ? 'Private' : 'Public'} · default ${r.defaultBranch}`}
            accent={accent}
            action="Import"
            onAction={() =>
              onPick({
                title: r.fullName,
                engineLine: `${r.defaultBranch} · deploy from GitHub`,
                accent,
                origin: 'github',
                defaultName: prettyName(r.fullName),
                wantedSlug: '',
                repo: { fullName: r.fullName, branch: r.defaultBranch },
              })
            }
          />
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

function Configure({ source, onBack, onCancel, onCreate, disabled }: { source: Source; onBack: () => void; onCancel: () => void; onCreate: (i: { verticalSlug: string; name: string }) => Promise<void>; disabled: boolean }) {
  const [name, setName] = useState(source.defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const host = slugify(name);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({ verticalSlug: source.verticalSlug, name: name.trim() || source.defaultName });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Page maxWidth={720}>
      <Header onCancel={onCancel} />
      <Stepper step={2} />
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: source.accent }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              {source.title} {source.origin === 'github' && <MonoTag>main</MonoTag>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{source.engineLine}</div>
          </div>
          <div style={{ flex: 1 }} />
          <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }} style={{ fontSize: 12.5 }}>Change</a>
        </div>

        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} hint="Prefilled from the source — you can rename later." />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)' }}>URL</div>
          <div style={{ display: 'flex', alignItems: 'center', height: 32, border: '1px solid var(--border-default)', borderRadius: 6, overflow: 'hidden', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
            <span style={{ padding: '0 10px', lineHeight: '30px', color: 'var(--text-primary)', background: 'var(--surface-card)' }}>{host}</span>
            <span style={{ padding: '0 10px', lineHeight: '30px', color: 'var(--text-tertiary)', background: 'var(--surface-inset)', borderLeft: '1px solid var(--border-subtle)', flex: 1 }}>.global.substrat.run</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Live as soon as provisioning completes. Custom domains attach later.</div>
        </div>

        <Select label="Environment" options={ENV_OPTS} value="Production" style={{ width: 220 }} />

        {error && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
          <Button onClick={submit} disabled={busy || disabled}>{busy ? 'Creating…' : 'Create app'}</Button>
          <Button variant="ghost" onClick={onBack}>Back</Button>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Appears in your grid immediately — provisions in the background.</div>
        </div>
      </div>
    </Page>
  );
}

/**
 * Deploy-from-GitHub (customer CI, now one-click). A repo still can't be provisioned
 * through the template path — building arbitrary repo code server-side is the model-A
 * gap (self-serve-deploy.md) — but the CI scaffolding is no longer homework: pick a
 * branch and Set up deployment mints a tenant-scoped push token, writes it as the
 * repo's `SUBSTRAT_SERVICE_TOKEN` secret, and commits the workflow — which triggers
 * the first run immediately. The first version lands *pending*; promote from
 * Deployments. The copy-paste manual path remains as the fallback (older App
 * installations may lack the write permissions until re-approved).
 */
function RepoDeploy({ repo, onBack, onCancel }: { repo: { fullName: string; branch: string }; onBack: () => void; onCancel: () => void }) {
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
    <Page maxWidth={720}>
      <Header onCancel={onCancel} />
      <Stepper step={2} />
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--brand-600)' }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              {repo.fullName} <MonoTag>{branch}</MonoTag>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Deploy from GitHub on every push</div>
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
                <span style={{ fontFamily: 'var(--font-mono)' }}>{done.vertical}</span>. Versions land <em>pending</em> — promote
                them from Deployments. Prod promotion + admission stay a Substrat-team decision.
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
              <Button onClick={() => { window.location.hash = '#/deployments'; }}>Go to Deployments</Button>
              <Button variant="ghost" onClick={onCancel}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              Substrat commits a deploy workflow to your repo and stores a workspace-scoped deploy credential as a repository
              secret. Each push then builds and pushes a version; the first lands <em>pending</em> — promote it to a channel from
              Deployments.
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
    </Page>
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

function prettyName(repo: string): string {
  const tail = repo.split('/').pop() ?? repo;
  return tail
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
