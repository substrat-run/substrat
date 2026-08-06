import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  PREVIEW_COMMENT_MARKER,
  buildPreviewTag,
  buildPreviewTagPrefix,
  parsePullRequestWebhook,
  previewCommentBody,
  previewReapedBody,
  previewTag,
  verifyGithubSignature,
} from '../src/github-webhook.js';
import { deployWorkflowYaml, githubConfig, upsertPrComment } from '../src/github.js';

/**
 * The webhook boundary's pure half: the HMAC gate (the ONLY auth on an
 * App-webhook delivery), the payload parse, and the sticky-comment contract the
 * platform shares with the generated CI workflow.
 */
describe('GitHub webhook verification', () => {
  const secret = 'wh_secret_1';
  const body = JSON.stringify({ hello: 'world' });
  const sign = (s: string, b: string) => `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;

  it('accepts GitHub-formatted signatures over the raw body', async () => {
    expect(await verifyGithubSignature(secret, body, sign(secret, body))).toBe(true);
    // Case-insensitive on the hex, as delivered.
    expect(await verifyGithubSignature(secret, body, sign(secret, body).toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
  });

  it('rejects a wrong secret, tampered body, or malformed header', async () => {
    expect(await verifyGithubSignature('other', body, sign(secret, body))).toBe(false);
    expect(await verifyGithubSignature(secret, body + ' ', sign(secret, body))).toBe(false);
    expect(await verifyGithubSignature(secret, body, null)).toBe(false);
    expect(await verifyGithubSignature(secret, body, 'sha1=abcdef')).toBe(false);
    expect(await verifyGithubSignature(secret, body, 'sha256=notlongenough')).toBe(false);
  });
});

describe('pull_request event parsing', () => {
  const payload = (action: string) =>
    JSON.stringify({
      action,
      number: 42,
      repository: { full_name: 'acme-inc/hr-portal' },
      installation: { id: 987654 },
      pull_request: { title: 'irrelevant extra fields pass through' },
    });

  it('maps opened/reopened/synchronize to a preview watch, closed to a reap', () => {
    for (const action of ['opened', 'reopened', 'synchronize']) {
      expect(parsePullRequestWebhook('pull_request', payload(action))).toEqual({
        action: 'sync',
        repo: 'acme-inc/hr-portal',
        prNumber: 42,
        installationId: '987654',
      });
    }
    expect(parsePullRequestWebhook('pull_request', payload('closed'))?.action).toBe('closed');
  });

  it('drops other actions, other events, and malformed payloads', () => {
    expect(parsePullRequestWebhook('pull_request', payload('labeled'))).toBeNull();
    expect(parsePullRequestWebhook('push', payload('opened'))).toBeNull();
    expect(parsePullRequestWebhook('pull_request', 'not json')).toBeNull();
    expect(parsePullRequestWebhook('pull_request', JSON.stringify({ action: 'opened' }))).toBeNull();
  });
});

describe('the sticky-comment contract', () => {
  const sticky = 'https://app--pr-7.global.substrat.run';
  const build = 'https://app--pr-7-991.global.substrat.run';

  it('platform comment bodies carry the marker the CI step also writes', () => {
    expect(previewCommentBody({ sticky }).startsWith(PREVIEW_COMMENT_MARKER)).toBe(true);
    expect(previewReapedBody().startsWith(PREVIEW_COMMENT_MARKER)).toBe(true);
    // The generated workflow's comment step upserts by the SAME marker — if this
    // drifts, platform and CI each post their own comment on every PR.
    expect(deployWorkflowYaml({ branch: 'main', slug: 'hr-portal', cpUrl: 'https://console.substrat.net/api' })).toContain(
      PREVIEW_COMMENT_MARKER,
    );
  });

  it('names the per-build URL alongside the sticky one, and only when there is one', () => {
    // The sticky URL moves under the reader (every push rebinds it), so a comment that
    // named only it could never de-reference "the bug on the preview" to a fixed build.
    const withBuild = previewCommentBody({ sticky, build });
    expect(withBuild).toContain(sticky);
    expect(withBuild).toContain(build);
    // Per-build previews are opt-in, so the line must vanish rather than render empty.
    for (const absent of [undefined, null, '']) {
      const body = previewCommentBody({ sticky, build: absent });
      expect(body).toContain(sticky);
      expect(body).not.toContain('This build');
    }
  });

  it('keeps every comment body apostrophe-free — the workflow renders them into a quoted printf', () => {
    // A single apostrophe in this prose closes the workflow's single-quoted printf and
    // takes the whole preview job red on what reads as a copy-edit.
    for (const body of [previewCommentBody({ sticky }), previewCommentBody({ sticky, build }), previewReapedBody()]) {
      expect(body).not.toContain("'");
    }
  });

  it('tags follow the CI convention, and the two numbering spaces never collide', () => {
    expect(previewTag(42)).toBe('pr-42');
    expect(buildPreviewTag(42, 991)).toBe('pr-42-991');
    // PR 12's sticky tag must NOT look like a per-build tag of PR 1 — otherwise closing
    // PR 1 would reap PR 12's preview.
    expect(previewTag(12).startsWith(buildPreviewTagPrefix(1))).toBe(false);
    expect(buildPreviewTag(1, 2).startsWith(buildPreviewTagPrefix(1))).toBe(true);
  });
});

describe('upsertPrComment', () => {
  interface Call {
    url: string;
    method: string;
    body: string | null;
  }

  /** A fake GitHub: installation token + issue-comment list/create/update. */
  function fakeGithub(existing: Array<{ id: number; body: string }>, failWith?: number) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? 'GET', body: (init?.body as string) ?? null });
      if (u.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_tok' }), { status: 200 });
      }
      if (failWith && !u.includes('/access_tokens')) return new Response('{}', { status: failWith });
      if (u.includes('/comments?')) return new Response(JSON.stringify(existing), { status: 200 });
      return new Response(JSON.stringify({ id: 1 }), { status: u.endsWith('/comments') ? 201 : 200 });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetchImpl };
  }

  // A PKCS#8 test key is exercised in github.test.ts; here the JWT signer just needs
  // any valid RSA key, so reuse the same generation approach lazily via githubConfig.
  const keyPem = async (): Promise<string> => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  };

  it('creates when no marker comment exists, updates in place when one does', async () => {
    const pem = await keyPem();
    const marker = PREVIEW_COMMENT_MARKER;

    const fresh = fakeGithub([{ id: 5, body: 'unrelated comment' }]);
    const cfg = githubConfig({ GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 's', GITHUB_APP_PRIVATE_KEY: pem }, fresh.fetchImpl)!;
    expect(await upsertPrComment(cfg, '11', 'acme-inc/hr-portal', 42, marker, `${marker}\nhello`)).toEqual({ ok: true });
    const create = fresh.calls.at(-1)!;
    expect(create.method).toBe('POST');
    expect(create.url).toContain('/repos/acme-inc/hr-portal/issues/42/comments');

    const existing = fakeGithub([{ id: 7, body: `${marker}\nold url` }]);
    const cfg2 = githubConfig({ GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 's', GITHUB_APP_PRIVATE_KEY: pem }, existing.fetchImpl)!;
    expect(await upsertPrComment(cfg2, '11', 'acme-inc/hr-portal', 42, marker, `${marker}\nnew url`)).toEqual({ ok: true });
    const update = existing.calls.at(-1)!;
    expect(update.method).toBe('PATCH');
    expect(update.url).toContain('/issues/comments/7');
  });

  it('surfaces a 403 as needsPermissions instead of throwing', async () => {
    const pem = await keyPem();
    const gh = fakeGithub([], 403);
    const cfg = githubConfig({ GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 's', GITHUB_APP_PRIVATE_KEY: pem }, gh.fetchImpl)!;
    expect(await upsertPrComment(cfg, '11', 'acme-inc/hr-portal', 42, PREVIEW_COMMENT_MARKER, 'x')).toEqual({ needsPermissions: true });
  });
});
