import { useEffect, useState } from 'react';
import { Page } from '../components/layout';
import { card, PageTitle } from '../components/ui';
import { isApiError, teamApi } from '../lib/api';
import { isExactUsageFigure, type UsageScalar } from '../lib/usage-precision';

type Grants = Awaited<ReturnType<ReturnType<typeof teamApi>['listEntitlements']>>;
type Result = { teamId: string; grants: Grants; error: 'forbidden' | 'unavailable' | null };
type Usage = Awaited<ReturnType<ReturnType<typeof teamApi>['readMeteredUsage']>>;
type UsageResult = { teamId: string; usage: Usage | null; error: 'forbidden' | 'unavailable' | null };
const number = (value: number) => new Intl.NumberFormat('en-US').format(value);
const date = (value: string | null) => value ? value.slice(0, 10) : 'not available';
const exclusions: Record<string, string> = { attachments: 'attachment files', 'tenant-stores': 'per-tenant databases', lake: 'event history in the lake' };
const storageStates = new Set(['unavailable', 'empty', 'not-sampled', 'complete', 'partial', 'stale', 'failing', 'truncated']);
const requestStates = new Set(['unavailable', 'empty', 'complete', 'partial', 'truncated']);
const modelStates = new Set(['unavailable', 'empty', 'complete', 'truncated']);
const scalarLabel = (value: UsageScalar): string => value === undefined ? 'absent' : value === null ? 'null' : value === '' ? 'empty' : typeof value === 'string' && value.trim() === '' ? 'blank' : String(value);
const knownCoverage = (state: UsageScalar, known: Set<string>) => typeof state === 'string' && known.has(state);
const coverage = (state: UsageScalar, known: Set<string>) => knownCoverage(state, known) ? state : `unknown (${scalarLabel(state)})`;
const reasonLabel = (reason: UsageScalar) => reason === null || reason === undefined ? '' : ` · other truncation reason (${reason === '' || typeof reason === 'string' && reason.trim() === '' ? 'limited' : scalarLabel(reason)})`;
const oddTruncationLabel = (truncated: UsageScalar) => truncated === true || truncated === false ? '' : ` Truncation status: unknown (${scalarLabel(truncated)}).`;
const oddEstimateLabel = (estimated: UsageScalar) => estimated === true || estimated === false ? '' : ` Reported estimate status: unknown (${scalarLabel(estimated)}).`;

function UsageCards({ usage }: { usage: Usage }) {
  const storage = usage.storage;
  const requests = usage.requests;
  const models = usage.models;
  const storageLowerBound = !isExactUsageFigure({ truncated: storage.lowerBound, reason: storage.truncatedReason, coverage: storage.state, estimated: storage.estimated, complete: storage.basis === 'scope-databases' && storage.sampled === storage.total && storage.failing === 0 });
  const requestsLowerBound = !isExactUsageFigure({ truncated: requests.lowerBound, reason: requests.truncatedReason, coverage: requests.state, estimated: requests.estimated, complete: requests.coveredDays === requests.totalDays });
  const modelsLowerBound = !isExactUsageFigure({ truncated: models.lowerBound, reason: models.truncatedReason, coverage: models.state, estimated: models.estimated });
  const section = { ...card, padding: 20, marginTop: 12 };
  return (
    <>
      <div style={section}>
        <h3>Stored bytes</h3>
        <p>{storage.bytes === null ? storage.state === 'empty' ? 'No scope database storage recorded.' : 'not available' : `${storageLowerBound ? 'At least ' : ''}${number(storage.bytes)} bytes`}</p>
        <p>Coverage: {storage.state === 'unavailable' ? 'not available' : `${storage.sampled} of ${storageLowerBound ? 'at least ' : ''}${storage.total} scopes sampled · ${coverage(storage.state, storageStates)}`}{storage.failing > 0 ? ` · ${storage.failing} latest reads failed` : ''}{storage.truncatedReason === 'scope-cap' ? ' Scope scan capped at 500; this is a lower bound.' : reasonLabel(storage.truncatedReason)}{oddTruncationLabel(storage.lowerBound)}{storage.basis !== 'scope-databases' ? ` Basis unknown (${scalarLabel(storage.basis)}).` : ''}</p>
        <p>Estimate: {storage.estimated === false && !storageLowerBound ? 'no; scope database samples only' : 'unknown or estimated; treat this figure as an estimate'}.{oddEstimateLabel(storage.estimated)} Freshness: oldest sample {date(storage.oldestReadAt)}.</p>
        <p>{storage.state === 'unavailable' ? 'Storage exclusions are not available.' : `Excludes ${storage.excluded.map((item) => typeof item === 'string' ? exclusions[item] ?? `other (${scalarLabel(item)})` : `other (${scalarLabel(item)})`).join(', ') || 'none'}.`} Storage day rows are kept {usage.retention.storageMonths} months.</p>
      </div>
      <div style={section}>
        <h3>Router requests</h3>
        <p>{requests.requests === null ? requests.state === 'empty' ? 'No requests recorded in covered days.' : 'not available' : `${requestsLowerBound ? 'At least ' : ''}${number(requests.requests)} ${requests.estimated === false && !requestsLowerBound ? 'request counts' : 'estimated request counts'} from stored rows`}</p>
        <p>Coverage: {requests.coveredDays} of {requests.totalDays} closed UTC days ({requests.sinceDay} to {requests.untilDay}) · {coverage(requests.state, requestStates)}{reasonLabel(requests.truncatedReason)}{oddTruncationLabel(requests.lowerBound)}.</p>
        <p>Estimate: {requests.estimated === true && knownCoverage(requests.state, requestStates) ? 'yes, estimated from sampled router datapoints' : requests.estimated === false && !requestsLowerBound ? 'no; stored request counts as reported' : 'unknown; treat this figure as an estimate'}{requestsLowerBound ? '; this lower bound is over stored estimates, not exact traffic' : ''}.{oddEstimateLabel(requests.estimated)} Freshness: last rollup {date(requests.lastReadAt)}.</p>
        {requests.byVertical.length > 0 && <ul>{requests.byVertical.map((row) => <li key={row.vertical ?? 'unresolved'}>{row.vertical ?? 'Unresolved app'}: {requestsLowerBound ? 'at least ' : ''}{number(row.requests)} {requests.estimated === false && !requestsLowerBound ? 'requests' : 'estimated requests'}</li>)}</ul>}
        {requests.breakdownTruncated && <p>App breakdown truncated to 50 entries.</p>}
        <p>{usage.retention.requestMonths === null ? 'Request rollup retained as persisted; no pruning horizon is configured.' : `Request rollup kept ${usage.retention.requestMonths} months.`}</p>
      </div>
      <div style={section}>
        <h3>Model usage</h3>
        <p>{models.calls === null ? models.state === 'empty' ? 'No model usage recorded in this window.' : 'not available' : `${modelsLowerBound ? 'At least ' : ''}${number(models.calls)} recorded calls · ${models.inputTokens === null ? 'not available' : `${modelsLowerBound ? 'at least ' : ''}${number(models.inputTokens)}`} input and ${models.outputTokens === null ? 'not available' : `${modelsLowerBound ? 'at least ' : ''}${number(models.outputTokens)}`} output tokens`}</p>
        <p>Coverage: recorded model-usage lines from {date(models.since)} to {date(models.until)} · {coverage(models.state, modelStates)}{modelsLowerBound ? `; lower bound from available lines, oldest included ${date(models.oldestRecordedAt)}` : ''}{models.truncatedReason === 'time-budget' ? '; stopped at the read time budget' : models.truncatedReason === 'page-cap' ? '; page cap reached' : reasonLabel(models.truncatedReason)}{oddTruncationLabel(models.lowerBound)}. Calls without a recorded line are not represented.</p>
        <p>Estimate: {models.estimated === false && !modelsLowerBound ? 'no; tokens are as reported by providers' : 'unknown or estimated; treat this figure as an estimate'}.{oddEstimateLabel(models.estimated)} Freshness: last recorded line {date(models.newestRecordedAt)}.</p>
        {models.byVerticalModel.length > 0 && <ul>{models.byVerticalModel.map((row) => <li key={`${row.vertical}:${row.model}`}>{row.vertical} · {row.model}: {modelsLowerBound ? 'at least ' : ''}{number(row.calls)} calls, {row.inputTokens === null ? 'not available' : `${modelsLowerBound ? 'at least ' : ''}${number(row.inputTokens)}`} input and {row.outputTokens === null ? 'not available' : `${modelsLowerBound ? 'at least ' : ''}${number(row.outputTokens)}`} output tokens as reported</li>)}</ul>}
        {models.breakdownTruncated && <p>App and model breakdown truncated to 50 entries.</p>}
        <p>Model usage records are kept {usage.retention.modelDays} days.</p>
      </div>
    </>
  );
}

/** The team's directory grants and persisted usage; no prices or payments. */
export function Billing({ teamId, canRead }: { teamId: string; canRead: boolean }) {
  const [result, setResult] = useState<Result | null>(null);
  const [usageResult, setUsageResult] = useState<UsageResult | null>(null);

  useEffect(() => {
    if (!canRead) return;
    let current = true;
    setResult(null);
    setUsageResult(null);
    void teamApi(teamId).listEntitlements().then(
      (grants) => { if (current) setResult({ teamId, grants, error: null }); },
      (error: unknown) => {
        if (current) setResult({ teamId, grants: [], error: isApiError(error) && error.status === 403 ? 'forbidden' : 'unavailable' });
      },
    );
    void teamApi(teamId).readMeteredUsage().then(
      (usage) => { if (current) setUsageResult({ teamId, usage, error: null }); },
      (error: unknown) => {
        if (current) setUsageResult({ teamId, usage: null, error: isApiError(error) && error.status === 403 ? 'forbidden' : 'unavailable' });
      },
    );
    return () => { current = false; };
  }, [teamId, canRead]);

  const shown = result?.teamId === teamId ? result : null;
  const shownUsage = usageResult?.teamId === teamId ? usageResult : null;
  const refused = !canRead || shown?.error === 'forbidden' || shownUsage?.error === 'forbidden';
  return (
    <Page maxWidth={960}>
      <PageTitle title="Entitlements and usage" subtitle="Current grants and persisted usage recorded for this team." />
      {refused ? (
        <div role="status" style={{ ...card, padding: 20 }}>Ask a team owner or admin to view entitlements.</div>
      ) : <>
      {!shown ? (
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
      <h2 style={{ marginTop: 28 }}>Metered usage</h2>
      {!shownUsage ? (
        <div role="status" style={{ ...card, padding: 20 }}>Loading usage…</div>
      ) : shownUsage.error === 'unavailable' || !shownUsage.usage ? (
        <div role="status" style={{ ...card, padding: 20 }}>Usage is unavailable. Try again later.</div>
      ) : (
        <UsageCards usage={shownUsage.usage} />
      )}
      </>}
    </Page>
  );
}
