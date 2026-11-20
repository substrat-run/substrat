import { useEffect, useRef, useState } from 'react';
import { Button } from '@substrat-run/ui/wa';
import { Page } from '../components/layout';
import { card, MonoTag } from '../components/ui';
import { teamApi } from '../lib/api';

type PullPreview = Awaited<ReturnType<ReturnType<typeof teamApi>['githubPreviewRequest']>>;

/** How often the page asks whether CI has built the preview, and for how long it keeps asking. */
const POLL_MS = 5_000;
const POLL_FOR_MS = 30 * 60_000;

/**
 * Build preview — where the "No preview yet" comment on a pull request links to, in a repo
 * that previews on request.
 *
 * Opening it changes nothing: it reads the PR and its preview. The button POSTs, and the
 * server labels the PR `preview` through the GitHub App after checking the person may deploy
 * this vertical. The label is what the repo's workflow waits for, so from there it is the
 * ordinary CI → preview → PR comment loop; this page polls the same read until the preview
 * has a URL and then sends the person to it.
 */
export function PreviewRequest({ teamId, repo, pr }: { teamId: string; repo: string; pr: number }) {
  // One instance per PR: App keys this page by (team, repo, pr), so nothing here outlives the
  // request it was opened for.
  const [view, setView] = useState<PullPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsPermissions, setNeedsPermissions] = useState(false);
  // Polling since: set when the button labelled the PR here, or when the page opened on a PR
  // that already asked and has no preview yet (a refresh mid-build).
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  // Only a request made on THIS page sends the person to the preview when it lands; one that
  // was already under way just updates what the page says.
  const [navigateOnReady, setNavigateOnReady] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const live = useRef(true);

  const read = async (): Promise<PullPreview | null> => {
    try {
      const v = await teamApi(teamId).githubPreviewRequest({ repo, pr });
      if (live.current) {
        setView(v);
        setError(null);
      }
      return v;
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'could not read this pull request');
      return null;
    }
  };

  useEffect(() => {
    live.current = true;
    void read().then((v) => {
      if (live.current && v?.requested && !v.previewUrl && v.state === 'open') setWaitingSince(Date.now());
    });
    return () => {
      live.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Building: poll until the preview has a URL — bounded, since a PR whose change the repo's
  // workflow judges out of the vertical's scope never builds one. A read still in flight when
  // this effect ends (the page left, or a new request restarted the poll) is ignored, so it can
  // neither update the page nor navigate away from wherever the person went.
  useEffect(() => {
    if (waitingSince === null) return;
    let cancelled = false;
    const t = setInterval(() => {
      void read().then((v) => {
        if (cancelled) return;
        if (v?.previewUrl) {
          clearInterval(t);
          if (navigateOnReady) window.location.assign(v.previewUrl);
        } else if (Date.now() - waitingSince > POLL_FOR_MS) {
          clearInterval(t);
          setGaveUp(true);
        }
      });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [waitingSince, navigateOnReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await teamApi(teamId).requestGithubPreview({ repo, pr });
      if (!result.ok) setNeedsPermissions(true);
      else {
        setGaveUp(false);
        setNavigateOnReady(true);
        setWaitingSince(Date.now());
        void read();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not request the preview');
    } finally {
      setBusy(false);
    }
  };

  const mono = { fontFamily: 'var(--font-mono)' } as const;
  return (
    <Page maxWidth={720}>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Build preview</div>
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {view ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <a href={view.htmlUrl} target="_blank" rel="noreferrer" style={{ fontSize: 15, fontWeight: 500 }}>
                {view.title} <span style={{ color: 'var(--text-tertiary)' }}>#{view.pr}</span>
              </a>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={mono}>{view.repo}</span> deploys <MonoTag>{view.slug}</MonoTag>
              </div>
            </div>
            <Status
              view={view}
              waiting={waitingSince !== null}
              gaveUp={gaveUp}
              needsPermissions={needsPermissions}
              busy={busy}
              onBuild={() => void build()}
            />
          </>
        ) : error ? null : (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading pull request…</div>
        )}
        {error && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</div>}
      </div>
    </Page>
  );
}

function Status({
  view,
  waiting,
  gaveUp,
  needsPermissions,
  busy,
  onBuild,
}: {
  view: PullPreview;
  waiting: boolean;
  gaveUp: boolean;
  needsPermissions: boolean;
  busy: boolean;
  onBuild: () => void;
}) {
  const text = { fontSize: 12.5, color: 'var(--text-secondary)' } as const;
  const label = <span style={{ fontFamily: 'var(--font-mono)' }}>preview</span>;
  if (view.state === 'closed') {
    return <div style={text}>This pull request is closed. Its preview, if it had one, was reaped when it closed.</div>;
  }
  if (needsPermissions) {
    return (
      <div style={{ ...text, color: 'var(--status-danger-fg)' }}>
        The GitHub App may not label pull requests in this repository (an installation approved before it asked to). Add the{' '}
        {label} label on GitHub instead, or re-approve the App&apos;s permissions under Integrations.
      </div>
    );
  }
  if ((waiting || view.requested) && !view.previewUrl) {
    return (
      <div style={text}>
        {gaveUp ? (
          <>
            Still no preview after 30 minutes. Check the pull request&apos;s checks on GitHub: a change outside what this vertical
            uploads is skipped, and a failed gate stops the build.
          </>
        ) : (
          <>Building… The repository&apos;s CI is building this preview. This page opens it as soon as it has a URL.</>
        )}
      </div>
    );
  }
  if (view.previewUrl) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={text}>
          {view.requested ? (
            <>This pull request has a preview, and every push to it updates the preview.</>
          ) : (
            <>
              This pull request has a preview, but its {label} label was removed, so pushes no longer update it. Build preview
              labels it again.
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Button onClick={() => window.location.assign(view.previewUrl!)}>Open preview</Button>
          {!view.requested && view.canRequest && (
            <Button variant="ghost" disabled={busy} onClick={onBuild}>
              {busy ? 'Requesting…' : 'Build preview'}
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={text}>
        No preview yet. Build preview labels this pull request {label}, and the repository&apos;s CI builds it — a copy of the
        app running this pull request&apos;s code against a fork of production. Every later push updates it, and it is reaped when
        the pull request closes.
      </div>
      <div>
        <Button disabled={busy || !view.canRequest} onClick={onBuild}>
          {busy ? 'Requesting…' : 'Build preview'}
        </Button>
      </div>
      {!view.canRequest && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Building a preview needs a role in this team that can deploy apps.</div>
      )}
    </div>
  );
}
