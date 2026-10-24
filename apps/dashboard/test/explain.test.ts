import { describe, expect, it } from 'vitest';
import { opsFailureFingerprint, type FindingEntry, type LifecycleFlowResult, type OpsFailureEntry, type SweepRunEntry } from '@substrat-run/contracts';
import {
  cleanText,
  factsDigest,
  failuresOf,
  findingFacts,
  findingPrompt,
  findingProvenance,
  noteIsCurrent,
  processFacts,
  processProvenance,
  redact,
  sweepsOf,
} from '../src/explain.js';

/**
 * The rules behind AI-written text in the dashboard (#1749), without a worker or a model:
 * what the redaction removes, that the facts sent are an allowlist and nothing more, and that
 * the provenance line is counted here rather than by the model.
 *
 * Every credential-shaped fixture is assembled from pieces, so `lint:secret-literals` reads no
 * shape in this file; the redaction sees the whole value at run time.
 */

const TENANT = '01JZ0000000000000000TENANT';
const SCOPE = '01JZ00000000000000000SCOPE';
const PRINCIPAL = '01JZ000000000000000PERSON1';

describe('redact', () => {
  const cases: Array<[string, string, string]> = [
    ['an email address', 'no account for jane.doe@example.com', 'no account for [email]'],
    ['a bearer token', 'upstream said 401 to Bearer ' + 'abc123DEF456ghi789', 'upstream said 401 to Bearer [secret]'],
    ['an Authorization header', 'sent authorization: ' + 'Basic dXNlcjpwYXNz', 'sent authorization: [secret]'],
    ['credentials in a URL', 'connect to postgres://admin:' + 'hunter2@db.example.net/app failed', 'connect to postgres://[credentials]@db.example.net/app failed'],
    ['a key=value secret', 'retry with api_key=' + 'q9w8e7r6t5', 'retry with api_key=[secret]'],
    ['a JSON secret', '{"client_secret": "' + 'zzzzyyyyxxxx' + '"}', '{"client_secret": "[secret]"}'],
    ['a provider token prefix', 'key ' + 'sk-' + 'ant-' + 'api03abcdefghijklmnop' + ' rejected', 'key [secret] rejected'],
    ['a GitHub token', 'push denied for ' + 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2', 'push denied for [secret]'],
    ['a JWT', 'token ' + 'eyJ' + 'hbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjMifQ.' + 'abcdefSIGNATURE' + ' expired', 'token [token] expired'],
    ['a phone number', 'SMS to +46 70 123 45 67 bounced', 'SMS to [phone] bounced'],
    ['a long mixed opaque run', 'hash ' + 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI' + ' mismatched', 'hash [opaque] mismatched'],
  ];
  it.each(cases)('removes %s', (_what, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('removes a PEM block whole', () => {
    const pem = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASC\n-----END ' + 'PRIVATE KEY-----';
    expect(redact(`could not parse ${pem} as PKCS#8`)).toBe('could not parse [key] as PKCS#8');
  });

  it('keeps what a reader needs to find the occurrence: ids, timestamps, statuses, paths, versions', () => {
    const text = 'POST /internal/lifecycle-flow answered 502 at 2026-10-23T09:14:02.120Z for 01JZ8F3K2M4N6P8Q0R2S4T6V8W (v1.4.12, port 8443)';
    expect(redact(text)).toBe(text);
  });

  it('bounds the length after redacting, and says it cut', () => {
    const out = redact('x'.repeat(1000));
    expect(out).toHaveLength(240);
    expect(out.endsWith('…')).toBe(true);
  });
});

const finding = (over: Partial<FindingEntry> = {}): FindingEntry =>
  ({
    id: '01JZFINDING000000000000001',
    tenantId: TENANT,
    kind: 'recurring',
    subject: 'deploy.upload',
    status: 'open',
    regressed: false,
    severity: 'warning',
    title: 'deploy.upload keeps failing',
    operation: 'deploy.upload',
    codes: ['upstream_unavailable'],
    vertical: 'acme/desk',
    scopeId: SCOPE,
    count: 3,
    firstSeen: '2026-10-20T08:00:00.000Z',
    lastSeen: '2026-10-23T08:00:00.000Z',
    lastVersion: '01JZVERSION000000000000001',
    resolvedVersion: null,
    resolvedAt: null,
    resolution: null,
    acknowledgedAt: null,
    ruleId: null,
    evidence: { source: 'ops-failures', fingerprint: 'fp' },
    likelyCause: { kind: 'deploy', version: '1.4.12', reason: 'first seen 4 minutes after 1.4.12 went live' },
    ...over,
  }) as FindingEntry;

const failure = (over: Partial<OpsFailureEntry> = {}): OpsFailureEntry =>
  ({
    id: '01JZFAIL0000000000000000001',
    actor: PRINCIPAL,
    operation: 'deploy.upload',
    stage: 'upload',
    tenantId: TENANT,
    scopeId: SCOPE,
    vertical: 'acme/desk',
    version: '01JZVERSION000000000000001',
    status: 503,
    origin: 'provider',
    code: 'upstream_unavailable',
    message: 'upstream refused for ops@acme.example',
    reference: null,
    fingerprint: 'fp',
    at: '2026-10-23T08:00:00.000Z',
    ...over,
  }) as OpsFailureEntry;

describe('the facts a model may read about a finding', () => {
  it('names its own fields and no others: no tenant, scope, principal or row ids reach the prompt', () => {
    const facts = findingFacts(finding(), [failure(), failure({ id: '01JZFAIL0000000000000000002', origin: 'platform', status: 500 })], []);
    expect(Object.keys(facts).sort()).toEqual(['failures', 'finding', 'sweeps']);
    expect(Object.keys(facts.finding).sort()).toEqual(
      ['codes', 'firstSeen', 'kind', 'lastSeen', 'lastVersion', 'likelyCause', 'occurrences', 'operation', 'regressed', 'severity', 'title'].sort(),
    );
    expect(Object.keys(facts.failures!).sort()).toEqual(['complete', 'inWindow', 'origins', 'samples', 'stages', 'statuses', 'versions']);
    const sent = findingPrompt(facts).prompt;
    for (const id of [TENANT, SCOPE, PRINCIPAL, '01JZFINDING000000000000001', '01JZFAIL0000000000000000001']) expect(sent).not.toContain(id);
    expect(sent).not.toContain('ops@acme.example');
    expect(facts.failures).toMatchObject({ inWindow: 2, origins: { provider: 1, platform: 1 }, statuses: { '503': 1, '500': 1 }, versions: 1 });
    expect(facts.failures!.samples).toEqual(['upstream refused for [email]']);
  });

  it('leaves the triage status out, so acting on a finding does not stale its explanation', async () => {
    const rows = [failure()];
    const open = await factsDigest(findingFacts(finding({ status: 'open' }), rows, []));
    expect(await factsDigest(findingFacts(finding({ status: 'acked', acknowledgedAt: '2026-10-23T09:00:00.000Z' as FindingEntry['acknowledgedAt'] }), rows, []))).toBe(open);
  });

  it('says when the failure read stopped at its cap', () => {
    const f = finding();
    const facts = findingFacts(f, [failure()], [], false);
    expect(facts.failures!.complete).toBe(false);
    expect(findingProvenance(f, facts, { writtenAt: 'w', model: 'm', until: 'u' }).summary).toBe('the newest 1 failure record, 1 version, 1 deploy');
  });

  it('keeps three distinct samples at most, distinct after redaction', () => {
    const rows = ['a@x.example', 'b@x.example', 'boom 1', 'boom 2', 'boom 3'].map((m, i) =>
      failure({ id: `01JZFAIL00000000000000000${i}`, message: `failed for ${m}` }),
    );
    // The two addresses redact to one sample, so the third is the first `boom`.
    expect(findingFacts(finding(), rows, []).failures!.samples).toEqual(['failed for [email]', 'failed for boom 1', 'failed for boom 2']);
  });

  it('reads only the rows that ARE the finding: its fingerprint, computed for a row that predates the column', () => {
    const old = failure({ id: '01JZFAIL0000000000000000OLD', fingerprint: null });
    const other = failure({ id: '01JZFAIL000000000000000OTHR', operation: 'deploy.other', fingerprint: 'other' });
    const fp = opsFailureFingerprint(old);
    const rows = failuresOf(finding({ evidence: { source: 'ops-failures', fingerprint: fp } }), [failure({ fingerprint: fp }), old, other]);
    expect(rows.map((r) => r.id)).toEqual(['01JZFAIL0000000000000000001', '01JZFAIL0000000000000000OLD']);
  });

  it('reads sweep runs for a sweep finding, and no failures', () => {
    const f = finding({ evidence: { source: 'sweep-runs', kind: 'schedule', unit: 'desk/nightly' } });
    const run = (over: Partial<SweepRunEntry>) =>
      ({
        id: '01JZRUN00000000000000000001',
        kind: 'schedule',
        unit: 'desk/nightly',
        outcome: 'failed',
        tenantId: TENANT,
        scopeId: SCOPE,
        vertical: 'acme/desk',
        version: null,
        operation: 'desk/nightly',
        eventType: null,
        observedAt: null,
        connectionId: null,
        error: 'timed out calling https://user:' + 'pw@api.example.net',
        elapsedMs: 30000,
        at: '2026-10-23T03:00:00.000Z',
        ...over,
      }) as SweepRunEntry;
    const sweeps = sweepsOf(f, [run({}), run({ id: '01JZRUN00000000000000000002', unit: 'desk/other' })]);
    const facts = findingFacts(f, [], sweeps);
    expect(facts.failures).toBeNull();
    expect(facts.sweeps).toEqual({ kind: 'schedule', runs: 1, outcomes: { failed: 1 }, lastObservedAt: null, lastError: 'timed out calling https://[credentials]@api.example.net' });
  });
});

describe('provenance is counted, not written', () => {
  it('leads with the records read and lists each source with where to check it', () => {
    const f = finding();
    const facts = findingFacts(f, [failure(), failure({ id: '01JZFAIL0000000000000000002', version: '01JZVERSION000000000000002' })], []);
    const p = findingProvenance(f, facts, { writtenAt: '2026-10-23T09:00:00.000Z', model: 'cloudflare/@cf/x', until: '2026-10-23T09:00:00.000Z' });
    expect(p.summary).toBe('2 failure records, 2 versions, 1 deploy');
    expect(p.sources).toEqual([
      { kind: 'finding', count: null, href: '/observability?view=findings' },
      { kind: 'ops-failures', count: 2, href: `/observability?app=${SCOPE}&view=failures` },
      { kind: 'deploy', count: null, href: '/verticals/acme%2Fdesk' },
    ]);
    expect(p.since).toBe(f.firstSeen);
  });
});

const flow = (over: Partial<LifecycleFlowResult> = {}): LifecycleFlowResult => ({
  entityType: 'order',
  since: '2026-10-16T00:00:00.000Z',
  until: '2026-10-23T00:00:00.000Z',
  edges: [{ from: 'open', to: 'shipped', operation: 'desk/advance', count: 4, actors: { principal: 4 }, declared: true, seenLate: false }],
  states: [
    { state: 'open', declared: true, terminal: false, current: 2, entered: 6, dwell: { samples: 4, medianMs: 3_600_000, p90Ms: 7_200_000 }, stuck: [{ entityId: 'ORDER-SECRET-ID', since: '2026-10-17T00:00:00.000Z', lastOperation: null, lastAt: '2026-10-17T00:00:00.000Z' }] },
  ],
  funnel: { started: 6, reached: { open: 6, shipped: 4 } },
  totals: { started: 6, finished: 0, inFlight: 2, medianLifecycleMs: null },
  observation: { entities: 6, events: 10, inferred: 0, unexplained: 0, seenLate: 0, complete: true },
  ...over,
});

describe('the facts a model may read about a process map', () => {
  it('carries counts and declared names, never the ids of the records in a state', () => {
    const facts = processFacts('order', '7d', flow(), null);
    expect(JSON.stringify(facts)).not.toContain('ORDER-SECRET-ID');
    expect(facts.current.states[0]).toEqual({ state: 'open', terminal: false, current: 2, entered: 6, medianDwellMs: 3_600_000, stuckListed: 1 });
    expect(facts.previous).toBeNull();
    // The previous window's list is capped at one: never sent, so nothing compares the two.
    expect(processFacts('order', '7d', flow(), flow()).previous!.states[0]).not.toHaveProperty('stuckListed');
    expect(processProvenance(SCOPE, flow(), { writtenAt: 'w', model: 'm' })).toMatchObject({
      summary: '10 events, 6 orders',
      sources: [{ kind: 'lifecycle-flow', count: 10, href: `/observability?app=${SCOPE}&view=map` }],
    });
  });
});

describe('noteIsCurrent', () => {
  it('holds a note for a slice of its period, since its window rolls with the clock', () => {
    const at = Date.parse('2026-10-23T12:00:00.000Z');
    expect(noteIsCurrent('7d', '2026-10-23T12:00:00.000Z', at + 5 * 3_600_000)).toBe(true);
    expect(noteIsCurrent('7d', '2026-10-23T12:00:00.000Z', at + 7 * 3_600_000)).toBe(false);
    expect(noteIsCurrent('24h', '2026-10-23T12:00:00.000Z', at + 2 * 3_600_000)).toBe(false);
  });
});

describe('cleanText', () => {
  it('keeps snake_case codes and operations whole, and still drops underscore emphasis', () => {
    expect(cleanText('The upstream_unavailable code from deploy_upload keeps _recurring_ here.')).toBe(
      'The upstream_unavailable code from deploy_upload keeps recurring here.',
    );
  });

  it('drops markdown, links and code, so the stored copy is the copy a person reads', () => {
    expect(cleanText('## Summary\n- **Deploys** keep failing.\n- See [the log](https://evil.example/x).\n```rm -rf```')).toBe(
      'Deploys keep failing. See the log.',
    );
  });
});

describe('factsDigest', () => {
  it('is the same for the same facts in any key order, and different when a count moves', async () => {
    const a = await factsDigest({ x: 1, y: { b: 2, a: [1, 2] } });
    expect(await factsDigest({ y: { a: [1, 2], b: 2 }, x: 1 })).toBe(a);
    expect(await factsDigest({ x: 2, y: { b: 2, a: [1, 2] } })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
