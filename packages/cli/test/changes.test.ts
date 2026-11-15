import { afterEach, describe, expect, it } from 'vitest';
import type { VerticalChanges } from '@substrat-run/contracts';
import { formatChanges, readChanges } from '../src/changes.js';

/** `substrat changes`: one GET, the control plane's answer printed as it is. */

const orig = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = orig;
});

function plane(answer: VerticalChanges) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${new URL(input).pathname}`);
    return Response.json(answer);
  }) as typeof fetch;
  return seen;
}

describe('substrat changes', () => {
  it('reads the vertical’s open changes and prints each with its checks and preview', async () => {
    const seen = plane({
      provider: 'github',
      repository: 'acme-org/garden',
      changes: [
        {
          id: '#12', title: 'Add beds', branch: 'feat-beds', url: 'https://github.com/acme-org/garden/pull/12', author: 'ada',
          updatedAt: '2026-11-15T10:00:00Z', head: 'abc', checks: { state: 'failure', failing: ['test', 'lint'] },
          preview: { tag: 'pr-12', url: 'https://garden-acme--pr-12.global.substrat.run' },
        },
        { id: '#11', title: 'Docs', branch: 'docs', url: null, author: null, updatedAt: '2026-11-14T10:00:00Z', head: 'def', checks: { state: 'pending', failing: [] }, preview: null },
      ],
    });
    const changes = await readChanges({ controlPlaneUrl: 'http://cp/api', header: {}, slug: 'garden' });
    expect(seen).toEqual(['GET /api/verticals/garden/changes']);
    expect(formatChanges(changes)).toEqual([
      'open changes in acme-org/garden (GitHub pull requests):',
      '  #12  Add beds',
      '      feat-beds · checks fail: test, lint · ada · updated 2026-11-15T10:00:00Z',
      '      preview pr-12: https://garden-acme--pr-12.global.substrat.run',
      '      https://github.com/acme-org/garden/pull/12',
      '  #11  Docs',
      '      docs · checks running · updated 2026-11-14T10:00:00Z',
    ]);
  });

  it('checks it could not read print as unknown, under the reason', () => {
    expect(formatChanges({
      provider: 'github', repository: 'acme-org/garden', reason: 'the GitHub App cannot read checks for acme-org/garden',
      changes: [{ id: '#12', title: 'Add beds', branch: 'feat-beds', url: null, author: null, updatedAt: 't', head: 'abc', checks: { state: 'unknown', failing: [] }, preview: null }],
    })).toEqual([
      'open changes in acme-org/garden (GitHub pull requests):',
      '  (the GitHub App cannot read checks for acme-org/garden)',
      '  #12  Add beds',
      '      feat-beds · checks unknown · updated t',
    ]);
  });

  it('a repository it cannot read says why, not an empty list', () => {
    expect(formatChanges({ provider: null, repository: 'acme-org/garden', changes: [], reason: "this team has no GitHub connection for 'acme-org'" })).toEqual([
      "no open changes can be read from acme-org/garden: this team has no GitHub connection for 'acme-org'",
    ]);
  });
});
