import { useEffect, useState } from 'react';
import { Page } from '../components/layout';
import { card, PageTitle } from '../components/ui';
import { isApiError, teamApi } from '../lib/api';

type Grants = Awaited<ReturnType<ReturnType<typeof teamApi>['listEntitlements']>>;
type Result = { teamId: string; grants: Grants; error: 'forbidden' | 'unavailable' | null };

/** The team's real directory grants. Usage and billing have no read on this page yet. */
export function Billing({ teamId, canRead }: { teamId: string; canRead: boolean }) {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!canRead) return;
    let current = true;
    setResult(null);
    void teamApi(teamId).listEntitlements().then(
      (grants) => { if (current) setResult({ teamId, grants, error: null }); },
      (error: unknown) => {
        if (current) setResult({ teamId, grants: [], error: isApiError(error) && error.status === 403 ? 'forbidden' : 'unavailable' });
      },
    );
    return () => { current = false; };
  }, [teamId, canRead]);

  const shown = result?.teamId === teamId ? result : null;
  return (
    <Page maxWidth={960}>
      <PageTitle title="Entitlements" subtitle="Current grants recorded for this team." />
      {!canRead || shown?.error === 'forbidden' ? (
        <div role="status" style={{ ...card, padding: 20 }}>Ask a team owner or admin to view entitlements.</div>
      ) : !shown ? (
        <div role="status" style={{ ...card, padding: 20 }}>Loading entitlements…</div>
      ) : shown.error === 'unavailable' ? (
        <div role="status" style={{ ...card, padding: 20 }}>Entitlements are unavailable. Try again later.</div>
      ) : shown.grants.length === 0 ? (
        <div role="status" style={{ ...card, padding: 20 }}>No entitlements have been reported for this team.</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          {shown.grants.map((grant, i) => (
            <div key={grant.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 16px', borderBottom: i === shown.grants.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)' }}>{grant.key}</span>
              <span style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                {grant.quota !== undefined && <span>Quota: {grant.quota}</span>}
                {grant.expiresAt !== undefined && <span>Expires: <time dateTime={grant.expiresAt}>{grant.expiresAt.slice(0, 10)}</time></span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
