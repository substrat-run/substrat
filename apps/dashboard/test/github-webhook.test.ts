import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  PREVIEW_COMMENT_MARKER,
  buildPreviewTag,
  buildPreviewTagPrefix,
  parsePullRequestWebhook,
  previewCommentBody,
  previewActionFor,
  previewReapedBody,
  previewRequestBody,
  previewRequestUrl,
  previewTag,
  prReachesWorkflow,
  resolvePreviewMode,
  verifyGithubSignature,
} from '../src/github-webhook.js';
import { deployWorkflowYaml, githubConfig, upsertPrComment } from '../src/github.js';
import { ownedByBareName } from '../src/deployments.js';

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
  const payload = (action: string, extra: object = {}) =>
    JSON.stringify({
      action,
      number: 42,
      repository: { full_name: 'acme-inc/hr-portal' },
      installation: { id: 987654 },
      pull_request: { title: 'irrelevant extra fields pass through', labels: [{ name: 'preview' }] },
      ...extra,
    });

  it('maps opened/reopened/synchronize to a preview watch, closed to a reap, carrying the labels', () => {
    for (const action of ['opened', 'reopened', 'synchronize']) {
      expect(parsePullRequestWebhook('pull_request', payload(action))).toEqual({
        action: 'sync',
        repo: 'acme-inc/hr-portal',
        prNumber: 42,
        installationId: '987654',
        opened: action !== 'synchronize',
        labels: ['preview'],
      });
    }
    expect(parsePullRequestWebhook('pull_request', payload('closed'))?.action).toBe('closed');
    // A label added is how an on-request repo asks: the event names the one label.
    expect(parsePullRequestWebhook('pull_request', payload('labeled', { label: { name: 'preview' } }))).toMatchObject({
      action: 'labeled',
      label: 'preview',
    });
  });

  it('drops other actions, other events, and malformed payloads', () => {
    expect(parsePullRequestWebhook('pull_request', payload('unlabeled', { label: { name: 'preview' } }))).toBeNull();
    expect(parsePullRequestWebhook('pull_request', payload('labeled'))).toBeNull();
    expect(parsePullRequestWebhook('push', payload('opened'))).toBeNull();
    expect(parsePullRequestWebhook('pull_request', 'not json')).toBeNull();
    expect(parsePullRequestWebhook('pull_request', JSON.stringify({ action: 'opened' }))).toBeNull();
  });
});

describe('which PR events preview', () => {
  const evt = (action: 'sync' | 'closed' | 'labeled', o: { opened?: boolean; labels?: string[]; label?: string } = {}) => ({
    action,
    opened: o.opened ?? false,
    labels: o.labels ?? [],
    ...(o.label ? { label: o.label } : {}),
  });

  it('every-pr watches every open and push, and ignores labels', () => {
    expect(previewActionFor('every-pr', evt('sync', { opened: true }))).toBe('watch');
    expect(previewActionFor('every-pr', evt('sync'))).toBe('watch');
    expect(previewActionFor('every-pr', evt('labeled', { label: 'preview', labels: ['preview'] }))).toBe('ignore');
    expect(previewActionFor('every-pr', evt('closed'))).toBe('reap');
  });

  it('on-request asks on open, watches only a labelled PR, and still reaps on close', () => {
    // Opened without the label: the comment with the Build preview link. A later push: nothing.
    expect(previewActionFor('on-request', evt('sync', { opened: true }))).toBe('ask');
    expect(previewActionFor('on-request', evt('sync'))).toBe('ignore');
    // The label, added or already there: CI builds, so watch for its URL.
    expect(previewActionFor('on-request', evt('labeled', { label: 'preview', labels: ['preview'] }))).toBe('watch');
    expect(previewActionFor('on-request', evt('sync', { labels: ['preview'] }))).toBe('watch');
    expect(previewActionFor('on-request', evt('sync', { opened: true, labels: ['preview'] }))).toBe('watch');
    // Another label on a labelled PR is not a request.
    expect(previewActionFor('on-request', evt('labeled', { label: 'bug', labels: ['preview', 'bug'] }))).toBe('ignore');
    // Reaped whatever its labels: a PR whose label was removed may still hold a preview.
    expect(previewActionFor('on-request', evt('closed'))).toBe('reap');
  });

  it('commits a choice, else the link\'s explicit mode, else on request', () => {
    expect(resolvePreviewMode({ requested: 'every-pr', stored: 'on-request' })).toBe('every-pr');
    expect(resolvePreviewMode({ requested: 'on-request', stored: 'every-pr' })).toBe('on-request');
    expect(resolvePreviewMode({ stored: 'every-pr' })).toBe('every-pr');
    // No choice stored — a first setup, a hand-committed workflow, or a link older than the mode.
    expect(resolvePreviewMode({})).toBe('on-request');
  });

  it('links the comment to the Build preview page, naming the team, repo and PR', () => {
    const url = new URL(previewRequestUrl('https://app.example/', '01JTEAM', 'acme-inc/hr-portal', 42));
    expect(url.origin + url.pathname).toBe('https://app.example/preview-request');
    expect(Object.fromEntries(url.searchParams)).toEqual({ team: '01JTEAM', repo: 'acme-inc/hr-portal', pr: '42' });
    const body = previewRequestBody(url.toString());
    expect(body.startsWith(PREVIEW_COMMENT_MARKER)).toBe(true);
    expect(body).toContain(`[**Build preview**](${url.toString()})`);
    expect(body).toContain('`preview` label');
  });
});

describe('which PRs are offered Build preview', () => {
  it('offers it in a monorepo only to a PR that changes what the workflow is filtered to', async () => {
    const lister = (files: string[]) => {
      const calls = { n: 0 };
      return { calls, list: async () => (calls.n++, files) };
    };
    // Only other packages: the workflow's `paths:` filter never starts, label or not, so a
    // Build preview link would say Building… for thirty minutes and give up.
    const elsewhere = lister(['packages/other/src/a.ts', 'apps/site/package.json']);
    expect(await prReachesWorkflow('apps/helpdesk', elsewhere.list)).toBe(false);
    // The package, a workflow, or the root manifest or lockfile: it does.
    for (const f of ['apps/helpdesk/src/a.ts', '.github/workflows/x.yml', 'package.json', 'pnpm-lock.yaml']) {
      expect(await prReachesWorkflow('apps/helpdesk', lister(['docs/a.md', f]).list), f).toBe(true);
    }
    // A sibling whose name only starts the same is not the package.
    expect(await prReachesWorkflow('apps/helpdesk', lister(['apps/helpdesk-admin/a.ts']).list)).toBe(false);
    // A listing GitHub refused is a no: never a link that may lead nowhere.
    expect(await prReachesWorkflow('apps/helpdesk', async () => { throw new Error('502'); })).toBe(false);
    // The repo root: every PR starts the workflow, so nothing is listed.
    const root = lister([]);
    expect(await prReachesWorkflow(null, root.list)).toBe(true);
    expect(root.calls.n).toBe(0);
    // A link stored before setup recorded the path says nothing either way: no comment.
    expect(await prReachesWorkflow(undefined, lister(['apps/helpdesk/a.ts']).list)).toBe(false);
  });
});

describe('the Build preview ownership gate', () => {
  it('finds the team’s vertical by the bare name a repo link stores', () => {
    // The registry keys a vertical `<tenantSlug>/<name>`; setup stores `<name>`. Comparing the
    // two for equality refused every vertical the team owns.
    const owned = [{ slug: 'acme-x1y2z3/helpdesk' }, { slug: 'acme-x1y2z3/desk-admin' }];
    expect(ownedByBareName(owned, 'helpdesk')).toBe(owned[0]);
    expect(ownedByBareName(owned, 'acme-x1y2z3/helpdesk')).toBe(owned[0]);
    expect(ownedByBareName(owned, 'desk')).toBeUndefined();
    expect(ownedByBareName(owned, 'shop')).toBeUndefined();
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
    for (const body of [previewCommentBody({ sticky }), previewCommentBody({ sticky, build }), previewReapedBody(), previewRequestBody(sticky)]) {
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
