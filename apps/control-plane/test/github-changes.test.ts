import { describe, expect, it } from 'vitest';
import type { GithubConfig } from '@substrat-run/control-plane-api';
import { readGithubChanges } from '../src/github-changes.js';

/**
 * The GitHub half of `GET /verticals/:slug/changes`, against a fake GitHub: what token it asks
 * for, and how each head's checks read. The route around it is driven in control-plane-api's
 * suite with this reader stubbed.
 */
async function fakeGithub(answer: (path: string, body: unknown) => Response | undefined) {
  const keys = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  const seen: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.github.com', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? 'GET', path, body });
    return answer(path, body) ?? new Response('not found', { status: 404 });
  }) as typeof fetch;
  const cfg: GithubConfig = { appId: '1', appSlug: 'substrat', privateKeyPem: pem, fetchImpl };
  return { cfg, seen };
}

const pull = (number: number, sha: string) => ({
  number, title: `PR ${number}`, html_url: `https://github.com/acme/garden/pull/${number}`,
  updated_at: '2026-11-15T10:00:00Z', user: { login: 'ada' }, head: { ref: `feat-${number}`, sha },
});

describe('the open pull requests of a connected repository', () => {
  it('reads with read-only tokens for that repository, and words each head’s checks', async () => {
    const { cfg, seen } = await fakeGithub((path) => {
      if (path.endsWith('/access_tokens')) return Response.json({ token: 'read-token' });
      if (path.startsWith('/repos/acme/garden/pulls?')) return Response.json([pull(3, 'c3'), pull(2, 'c2'), pull(1, 'c1')]);
      if (path.startsWith('/repos/acme/garden/commits/c3/check-runs')) {
        return Response.json({ check_runs: [
          { name: 'test', status: 'completed', conclusion: 'failure' },
          { name: 'lint', status: 'in_progress', conclusion: null },
          { name: 'docs', status: 'completed', conclusion: 'skipped' },
        ] });
      }
      if (path.startsWith('/repos/acme/garden/commits/c2/check-runs')) return Response.json({ check_runs: [{ name: 'test', status: 'queued', conclusion: null }] });
      // No check runs on c1: its commit statuses answer instead.
      if (path.startsWith('/repos/acme/garden/commits/c1/check-runs')) return Response.json({ check_runs: [] });
      if (path === '/repos/acme/garden/commits/c1/status') return Response.json({ statuses: [{ context: 'ci/legacy', state: 'success' }] });
      return undefined;
    });
    const read = await readGithubChanges(cfg, { owner: 'acme', repo: 'garden', installationId: '42' });
    expect('changes' in read && read.changes.map((c) => [c.id, c.branch, c.head, c.checks])).toEqual([
      ['#3', 'feat-3', 'c3', { state: 'failure', failing: ['test'] }],
      ['#2', 'feat-2', 'c2', { state: 'pending', failing: [] }],
      ['#1', 'feat-1', 'c1', { state: 'success', failing: [] }],
    ]);
    // One token lists the pull requests, a second reads their checks: nothing that writes.
    expect(seen.filter((s) => s.method !== 'GET')).toEqual([
      { method: 'POST', path: '/app/installations/42/access_tokens', body: { repositories: ['garden'], permissions: { metadata: 'read', pull_requests: 'read' } } },
      { method: 'POST', path: '/app/installations/42/access_tokens', body: { repositories: ['garden'], permissions: { metadata: 'read', checks: 'read', statuses: 'read' } } },
    ]);
  });

  it('a repository the installation cannot read is a sentence, not a failure', async () => {
    const { cfg } = await fakeGithub((path) => (path.endsWith('/access_tokens') ? new Response('{}', { status: 422 }) : undefined));
    expect(await readGithubChanges(cfg, { owner: 'acme', repo: 'garden', installationId: '42' })).toEqual({
      unavailable: expect.stringContaining('cannot read pull requests of acme/garden'),
    });
  });

  it('an installation that may not read checks still lists its pull requests, checks unknown, and says why', async () => {
    const { cfg, seen } = await fakeGithub((path, body) => {
      if (path.endsWith('/access_tokens')) {
        const asked = (body as { permissions: Record<string, string> }).permissions;
        return 'checks' in asked ? new Response('{}', { status: 422 }) : Response.json({ token: 'pulls-token' });
      }
      if (path.startsWith('/repos/acme/garden/pulls?')) return Response.json([pull(2, 'c2'), pull(1, 'c1')]);
      return undefined;
    });
    const read = await readGithubChanges(cfg, { owner: 'acme', repo: 'garden', installationId: '42' });
    expect('changes' in read && read.changes.map((c) => [c.id, c.checks])).toEqual([
      ['#2', { state: 'unknown', failing: [] }],
      ['#1', { state: 'unknown', failing: [] }],
    ]);
    expect('changes' in read && read.reason).toContain('cannot read checks for acme/garden');
    expect(seen.some((s) => s.path.includes('/commits/'))).toBe(false);
  });
});
