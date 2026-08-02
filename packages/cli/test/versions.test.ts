import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printVersions } from '../src/versions.js';

/**
 * `versions <slug>` identity resolution (#399): the command must agree with
 * `hostnames <slug>` on WHICH registration a bare product name means. A staff push
 * pinned to a tenant registers `<tenantSlug>/<name>`, so the exact-slug read comes back
 * empty and, before the fix, printed a lineage-fork warning against a perfectly healthy
 * install. These tests drive printVersions against a routed fetch fake.
 */

const CP = 'https://cp.test';

type Routes = Record<string, unknown>;

function stubFetch(routes: Routes) {
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const path = String(url).replace(CP, '');
    if (path in routes) {
      return new Response(JSON.stringify(routes[path]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: `no route for ${path}` }), { status: 404 });
  });
}

const version = (id: string, label: string) => ({ id, version: label, admission: 'admitted' });

let logged: string[];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.join(' '));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const output = () => logged.join('\n');

describe('printVersions — identity resolution (#399)', () => {
  it('an exact-slug match lists versions with no resolution note', async () => {
    stubFetch({
      '/verticals/callout/versions': [version('01A', '1.0.0')],
      '/verticals/callout/channels': [],
    });
    await printVersions(CP, {}, 'callout');
    expect(output()).toContain('1.0.0');
    expect(output()).not.toContain('workspace-prefixed');
  });

  it('a bare name resolves to the single workspace-prefixed registration, like hostnames does', async () => {
    stubFetch({
      '/verticals/egeryds-substrat/versions': [],
      '/verticals': [{ slug: 'callout' }, { slug: 't-0wv2/egeryds-substrat' }],
      '/verticals/t-0wv2%2Fegeryds-substrat/versions': [version('01B', '0.1.43')],
      '/verticals/t-0wv2%2Fegeryds-substrat/channels': [
        { channel: 'prod', versionId: '01B', servingVersionId: '01B' },
      ],
    });
    await printVersions(CP, {}, 'egeryds-substrat');
    expect(output()).toContain("showing 't-0wv2/egeryds-substrat'");
    expect(output()).toContain('0.1.43');
    expect(output()).toContain('prod');
    expect(output()).not.toContain('lineage fork');
  });

  it('several prefixed registrations with versions are listed, never guessed between', async () => {
    stubFetch({
      '/verticals/helpdesk/versions': [],
      '/verticals': [{ slug: 't-aaa/helpdesk' }, { slug: 't-bbb/helpdesk' }],
      '/verticals/t-aaa%2Fhelpdesk/versions': [version('01C', '2.0.0')],
      '/verticals/t-bbb%2Fhelpdesk/versions': [version('01D', '3.0.0')],
    });
    await printVersions(CP, {}, 'helpdesk');
    expect(output()).toContain('substrat versions t-aaa/helpdesk');
    expect(output()).toContain('substrat versions t-bbb/helpdesk');
    expect(output()).not.toContain('2.0.0'); // no table for a guess
  });

  it('a true lineage fork still warns, naming the install-side identity', async () => {
    stubFetch({
      '/verticals/egeryds-substrat/versions': [],
      '/verticals': [{ slug: 'egeryds-crm' }], // tail does not match — not a prefix candidate
      '/hostnames?tenantId=01TENANT': [
        { hostname: 'crm.example', scopeId: '01S', verticalSlug: 't-0wv2/egeryds-substrat' },
      ],
      '/verticals/t-0wv2%2Fegeryds-substrat/versions': [],
    });
    await printVersions(CP, {}, 'egeryds-substrat', '01TENANT');
    expect(output()).toContain('lineage fork');
    expect(output()).toContain("install identity: 't-0wv2/egeryds-substrat'");
  });

  it('no versions and no installs stays a plain "is the slug correct?"', async () => {
    stubFetch({
      '/verticals/typo-slug/versions': [],
      '/verticals': [],
      '/hostnames?tenantId=01TENANT': [],
    });
    await printVersions(CP, {}, 'typo-slug', '01TENANT');
    expect(output()).toContain('no installs are bound');
    expect(output()).not.toContain('lineage fork');
  });
});
