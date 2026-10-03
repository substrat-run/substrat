import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listVerticalHostnames, unbindHostname, verifyHostname } from '../src/hostnames.js';
import { printInstalls } from '../src/installs.js';
import { requestPublish, setListing } from '../src/listing.js';
import { exchangeLoginCode } from '../src/login.js';
import { promote } from '../src/promote.js';
import { createPreview, deletePreview, listPreviews } from '../src/preview.js';
import { nextVersion, uploadVersion } from '../src/push.js';
import {
  adoptScopeServing,
  adoptVerticalServing,
  provisionScope,
  pullScope,
  rebindScopeVertical,
  restoreScope,
  scopeStatus,
} from '../src/scope.js';
import { printVersions } from '../src/versions.js';
import { fetchWhoami } from '../src/whoami.js';

/**
 * What the CLI puts on the wire and what it prints when the plane answers badly, command by
 * command (#971). The control plane is reached through `ControlPlaneBuilderClient` now; these
 * tests are written against the global `fetch` and the printed message only, so they hold for
 * any implementation — they were first run against the hand-rolled one — and a drift in a URL,
 * a verb, a header, a body or a sentence is a red test here rather than a changed CLI.
 */

const CP = 'https://cp.test/api';
const HEADER = { authorization: 'Bearer tok', 'x-substrat-tenant': 'acme' };
const JSON_TYPE = { 'content-type': 'application/json' };
const T = '01HZZZZZZZZZZZZZZZZZZZZZZT';
const S = '01HZZZZZZZZZZZZZZZZZZZZZZS';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Answer = Response | Error | (() => Response | Promise<Response>);

let seen: Seen[];
let answers: Answer[];
const realFetch = globalThis.fetch;

/** Queue answers (the last repeats); every request is recorded. */
function plane(...queue: Answer[]): void {
  answers = queue;
  seen = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    seen.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: init.body,
    });
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next.clone();
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const page = (entries: unknown[], nextCursor: string | null = null) => json({ entries, nextCursor });
const problem = (status: number, detail: string, code: string) =>
  json({ type: 'about:blank', title: code, status, detail, code }, status);

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

/** The stale-CLI nudge prints only on a TTY. */
function onTty(): void {
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
}
afterEach(() => {
  Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
});
const STALE = { 'x-substrat-cli-latest-version': '999.0.0' };

describe('whoami', () => {
  it('GETs /auth/whoami with the credential map and nothing else', async () => {
    plane(json({ user: { id: 'u' }, tenants: [] }));
    await expect(fetchWhoami(CP, HEADER)).resolves.toEqual({ user: { id: 'u' }, tenants: [] });
    expect(seen).toEqual([{ url: `${CP}/auth/whoami`, method: 'GET', headers: HEADER, body: undefined }]);
  });

  it('drops a trailing slash on the base', async () => {
    plane(json({ user: null, tenants: [] }));
    await fetchWhoami(`${CP}/`, HEADER);
    expect(seen[0]!.url).toBe(`${CP}/auth/whoami`);
  });

  it('a refusal prints the status and the first 200 characters of the body', async () => {
    plane(new Response('x'.repeat(500), { status: 403 }));
    await expect(fetchWhoami(CP, HEADER)).rejects.toThrow(`whoami failed (403): ${'x'.repeat(200)}`);
  });

  it('a 2xx that is a web page says the URL is probably not the API base', async () => {
    plane(new Response('<!doctype html><html>', { status: 200 }));
    await expect(fetchWhoami(CP, HEADER)).rejects.toThrow(/got HTML, not JSON, from https:\/\/cp\.test\/api\/auth\/whoami/);
  });

  it('a network failure is the very error fetch threw', async () => {
    const boom = new TypeError('fetch failed');
    plane(boom);
    await expect(fetchWhoami(CP, HEADER)).rejects.toBe(boom);
  });

  it('never prints the stale-CLI nudge (only push, promote and preview ever did)', async () => {
    onTty();
    plane(json({ user: null, tenants: [] }, 200, STALE));
    await fetchWhoami(CP, HEADER);
    expect(err).toEqual([]);
  });
});

describe('publish and unpublish', () => {
  it('setListing POSTs {"listed"} with the JSON type', async () => {
    plane(json({ slug: 'acme/crm', listed: false }));
    await expect(setListing({ controlPlaneUrl: CP, header: HEADER, slug: 'acme/crm', listed: false })).resolves.toEqual({
      slug: 'acme/crm',
      listed: false,
    });
    expect(seen).toEqual([
      { url: `${CP}/verticals/acme%2Fcrm/listing`, method: 'POST', headers: { ...HEADER, ...JSON_TYPE }, body: '{"listed":false}' },
    ]);
  });

  it('names the verb in the refusal and cuts the body at 300', async () => {
    plane(new Response('y'.repeat(400), { status: 403 }));
    await expect(setListing({ controlPlaneUrl: CP, header: HEADER, slug: 's', listed: true })).rejects.toThrow(
      `publish failed (403): ${'y'.repeat(300)}`,
    );
    await expect(setListing({ controlPlaneUrl: CP, header: HEADER, slug: 's', listed: false })).rejects.toThrow(
      /^unpublish failed \(403\): /,
    );
  });

  it('requestPublish POSTs an empty object and reports a refusal', async () => {
    plane(new Response(null, { status: 202 }));
    await requestPublish({ controlPlaneUrl: CP, header: HEADER, slug: 's' });
    expect(seen).toEqual([
      { url: `${CP}/verticals/s/publish-request`, method: 'POST', headers: { ...HEADER, ...JSON_TYPE }, body: '{}' },
    ]);
    plane(new Response('not yours', { status: 403 }));
    await expect(requestPublish({ controlPlaneUrl: CP, header: HEADER, slug: 's' })).rejects.toThrow(
      'publish request failed (403): not yours',
    );
  });
});

describe('login', () => {
  it('exchanges the code with the JSON type and NO credential', async () => {
    plane(json({ token: 'session' }));
    await expect(exchangeLoginCode(CP, 'c0de', 'verif')).resolves.toBe('session');
    expect(seen).toEqual([
      { url: `${CP}/auth/cli/token`, method: 'POST', headers: JSON_TYPE, body: '{"code":"c0de","verifier":"verif"}' },
    ]);
  });

  it('reports a refusal, an absent token and a web page', async () => {
    plane(new Response('expired', { status: 400 }));
    await expect(exchangeLoginCode(CP, 'c', 'v')).rejects.toThrow('token exchange failed (400): expired');
    plane(json({}));
    await expect(exchangeLoginCode(CP, 'c', 'v')).rejects.toThrow('token exchange returned no token');
    plane(new Response('<html>', { status: 200 }));
    await expect(exchangeLoginCode(CP, 'c', 'v')).rejects.toThrow(/got HTML, not JSON/);
  });
});

describe('hostnames', () => {
  it('lists with the JSON type on a GET (it always sent one), walking the cursor at 200', async () => {
    plane(page([{ hostname: 'a', verticalSlug: 'crm' }], 'next'), page([{ hostname: 'b', verticalSlug: 'acme/crm' }]));
    const rows = await listVerticalHostnames(CP, HEADER, T, 'crm');
    expect(rows.map((r) => r.hostname)).toEqual(['a', 'b']);
    expect(seen.map((r) => [r.url, r.method, r.headers])).toEqual([
      [`${CP}/hostnames?tenantId=${T}&limit=200`, 'GET', { ...HEADER, ...JSON_TYPE }],
      [`${CP}/hostnames?tenantId=${T}&limit=200&cursor=next`, 'GET', { ...HEADER, ...JSON_TYPE }],
    ]);
  });

  it('verifies with a POST and unbinds with a DELETE, both carrying the JSON type', async () => {
    plane(json({ hostname: 'a.example', status: 'active' }));
    await verifyHostname(CP, HEADER, 'a.example');
    await unbindHostname(CP, HEADER, 'a.example').catch(() => undefined);
    expect(seen.map((r) => [r.url, r.method, r.headers, r.body])).toEqual([
      [`${CP}/hostnames/a.example/verify`, 'POST', { ...HEADER, ...JSON_TYPE }, undefined],
      [`${CP}/hostnames/a.example`, 'DELETE', { ...HEADER, ...JSON_TYPE }, undefined],
    ]);
  });

  it('reads a refusal as "<status>: <error>", else the raw body', async () => {
    plane(json({ error: 'a bare public suffix' }, 400));
    await expect(verifyHostname(CP, HEADER, 'x')).rejects.toThrow('400: a bare public suffix');
    plane(new Response('upstream sad', { status: 502 }));
    await expect(verifyHostname(CP, HEADER, 'x')).rejects.toThrow('502: upstream sad');
  });

  it('an unbind answered with an empty body is read as the non-JSON answer it is', async () => {
    plane(new Response(null, { status: 204 }));
    await expect(unbindHostname(CP, HEADER, 'a.example')).rejects.toThrow(/non-JSON response from https:\/\/cp\.test\/api\/hostnames\/a\.example/);
  });
});

describe('versions and installs', () => {
  it('versions reads the paged list and the channels with the credential map only', async () => {
    plane(page([{ id: '01B', version: '0.2.0', admission: 'admitted' }]), page([{ channel: 'prod', versionId: '01B' }]));
    await printVersions(CP, HEADER, 'crm');
    expect(seen.map((r) => [r.url, r.method, r.headers])).toEqual([
      [`${CP}/verticals/crm/versions?limit=200`, 'GET', HEADER],
      [`${CP}/verticals/crm/channels?limit=200`, 'GET', HEADER],
    ]);
    expect(out.join('\n')).toContain('0.2.0');
  });

  it('a refused read prints the problem document, code and detail — not the raw body', async () => {
    plane(problem(403, 'you do not own crm', 'permission_denied'));
    await expect(printVersions(CP, HEADER, 'crm')).rejects.toThrow(
      'control-plane read failed (403 permission_denied): you do not own crm',
    );
  });

  it('a network failure on a read is the error fetch threw', async () => {
    const boom = new TypeError('fetch failed');
    plane(boom);
    await expect(printVersions(CP, HEADER, 'crm')).rejects.toBe(boom);
  });

  it('installs reads the tenant’s scopes, then the hostnames that serve them', async () => {
    plane(
      page([{ id: S, name: 'Acme CRM', status: 'active', vertical: 'crm', forkedFrom: null, createdAt: '2026-01-01T00:00:00Z' }]),
      page([{ hostname: 'crm.example', scopeId: S, verticalSlug: 'crm', status: 'active', canonical: true }]),
    );
    await printInstalls(CP, HEADER, T, 'crm');
    expect(seen.map((r) => [r.url, r.headers])).toEqual([
      [`${CP}/scopes?tenantId=${T}&limit=200`, HEADER],
      [`${CP}/hostnames?tenantId=${T}&limit=200`, { ...HEADER, ...JSON_TYPE }],
    ]);
    expect(out.join('\n')).toContain('crm.example');
  });
});

describe('promote', () => {
  const opts = { controlPlaneUrl: CP, header: HEADER, slug: 'acme/crm', channel: 'prod', versionId: '01V' };

  it('POSTs the version, and the acknowledgement only when one was given', async () => {
    plane(json({ channel: 'prod', versionId: '01V' }));
    await promote(opts);
    await promote({ ...opts, acknowledge: { permissionChange: true } });
    expect(seen.map((r) => [r.url, r.method, r.headers, r.body])).toEqual([
      [`${CP}/verticals/acme%2Fcrm/channels/prod/promote`, 'POST', { ...HEADER, ...JSON_TYPE }, '{"versionId":"01V"}'],
      [
        `${CP}/verticals/acme%2Fcrm/channels/prod/promote`,
        'POST',
        { ...HEADER, ...JSON_TYPE },
        '{"versionId":"01V","acknowledge":{"permissionChange":true}}',
      ],
    ]);
  });

  it('nudges a stale CLI off a SUCCESS and off a REFUSAL — and stays quiet off a tty', async () => {
    onTty();
    plane(json({ channel: 'prod', versionId: '01V' }, 200, STALE));
    await promote(opts);
    expect(err.join('\n')).toMatch(/a newer substrat CLI is available \(999\.0\.0/);
    err.length = 0;
    plane(json({ title: 'x', detail: 'nope', code: 'conflict' }, 409, STALE));
    await expect(promote(opts)).rejects.toThrow('promote failed (409 conflict): nope');
    expect(err.join('\n')).toMatch(/a newer substrat CLI is available/);
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    err.length = 0;
    plane(json({ channel: 'prod', versionId: '01V' }, 200, STALE));
    await promote(opts);
    expect(err).toEqual([]);
  });

  it('a refusal that is not a digest one is the problem line alone — no diff reads', async () => {
    plane(problem(404, 'no such version', 'not_found'));
    await expect(promote(opts)).rejects.toThrow(/^promote failed \(404 not_found\): no such version$/);
    expect(seen).toHaveLength(1);
  });

  it('a network failure is the error fetch threw; a web page names the likely fix', async () => {
    const boom = new TypeError('fetch failed');
    plane(boom);
    await expect(promote(opts)).rejects.toBe(boom);
    plane(new Response('<html>', { status: 200 }));
    await expect(promote(opts)).rejects.toThrow(/got HTML, not JSON/);
  });
});

describe('scope tools', () => {
  const base = { controlPlaneUrl: CP, header: HEADER, tenantId: T, scopeId: S };
  const scopeUrl = `${CP}/tenants/${T}/scopes/${S}`;

  it('pull GETs the export (full only when asked), refuses with the problem detail, and writes the dump', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wire-pull-'));
    const dump = { tenantId: T, scopeId: S, capturedAt: '2026-01-01T00:00:00Z', masked: true, tables: [] };
    plane(json(dump));
    await pullScope({ ...base, full: false, outDir: dir });
    expect(seen).toEqual([{ url: `${scopeUrl}/export`, method: 'GET', headers: HEADER, body: undefined }]);
    expect(existsSync(dir) && readdirSync(dir).length).toBe(1);
    plane(json(dump));
    await pullScope({ ...base, full: true, outDir: dir });
    expect(seen[0]!.url).toBe(`${scopeUrl}/export?full=true`);
    plane(problem(403, 'staff only', 'permission_denied'));
    await expect(pullScope({ ...base, full: false, outDir: dir })).rejects.toThrow('staff only');
    plane(new Response('bad', { status: 502, statusText: 'Bad Gateway' }));
    await expect(pullScope({ ...base, full: false, outDir: dir })).rejects.toThrow('pull refused: 502 Bad Gateway');
  });

  it('provision POSTs with the JSON type and no body, and says what it could not mint', async () => {
    plane(json({ owner: 'u@x', storeError: 'no token' }));
    await provisionScope(base);
    expect(seen).toEqual([{ url: `${scopeUrl}/provision`, method: 'POST', headers: { ...HEADER, ...JSON_TYPE }, body: undefined }]);
    expect(out.join('\n')).toMatch(/could NOT be minted[\s\S]*no token/);
    plane(new Response(null, { status: 500, statusText: 'Internal Server Error' }));
    await expect(provisionScope(base)).rejects.toThrow('provision refused: 500 Internal Server Error');
  });

  it('adopt-serving sends the acknowledgement only when asked and names what a refusal would break', async () => {
    plane(json({ servingRef: 'v1', tables: 3 }));
    await adoptScopeServing(base);
    await adoptScopeServing({ ...base, ackExportBreak: true });
    expect(seen.map((r) => [r.url, r.body])).toEqual([
      [`${scopeUrl}/adopt-serving`, '{}'],
      [`${scopeUrl}/adopt-serving`, '{"acknowledge":{"exportBreak":true}}'],
    ]);
    plane(new Response('<html>', { status: 200 }));
    await expect(adoptScopeServing(base)).rejects.toThrow(/got HTML, not JSON/);
    plane(new Response('x', { status: 500, statusText: 'Server Error' }));
    await expect(adoptScopeServing(base)).rejects.toThrow('adopt-serving refused: 500 Server Error');
  });

  it('restore prints the loader’s detail beside the refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wire-restore-'));
    const file = join(dir, 'backup.dump.json');
    writeFileSync(file, JSON.stringify({ tables: [] }));
    plane(json({ error: 'unloadable dump', detail: 'table x has no DDL' }, 422));
    await expect(restoreScope({ ...base, file })).rejects.toThrow('unloadable dump — table x has no DDL');
    plane(new Response('nope', { status: 500, statusText: 'Server Error' }));
    await expect(restoreScope({ ...base, file })).rejects.toThrow('restore refused: 500 Server Error');
    plane(new Response(null, { status: 200 }));
    await restoreScope({ ...base, file });
    expect(seen[0]).toMatchObject({ url: `${scopeUrl}/restore`, method: 'POST', headers: { ...HEADER, ...JSON_TYPE } });
  });

  it('status reads the record, then the health — and shows the record when the health read fails', async () => {
    plane(
      json({ slug: 'crm', name: 'CRM', status: 'active', vertical: 'crm', verticalVersionId: '01V', schemaVersion: '1', createdAt: 'now' }),
      new Response('down', { status: 503 }),
    );
    await scopeStatus(base);
    expect(seen.map((r) => [r.url, r.headers])).toEqual([
      [scopeUrl, HEADER],
      [`${scopeUrl}/health`, HEADER],
    ]);
    expect(out.join('\n')).toContain(`scope     ${S}`);
    plane(problem(404, 'unknown scope', 'not_found'));
    await expect(scopeStatus(base)).rejects.toThrow('unknown scope');
  });

  it('rebind sends only what was asked, and a refusal keeps the plane’s own words', async () => {
    plane(json({ servingRef: 'v2', tables: 4 }));
    await rebindScopeVertical({ ...base, vertical: 'acme/crm', ackMigrations: false });
    await rebindScopeVertical({ ...base, vertical: 'acme/crm', ackMigrations: true, abandonData: true, ackExportBreak: true });
    expect(seen.map((r) => r.body)).toEqual([
      '{"vertical":"acme/crm"}',
      '{"vertical":"acme/crm","ackMigrations":true,"abandonData":true,"acknowledge":{"exportBreak":true}}',
    ]);
    expect(seen[0]!.url).toBe(`${scopeUrl}/rebind-vertical`);
    plane(problem(409, 'digests differ', 'conflict'));
    await expect(rebindScopeVertical({ ...base, vertical: 'v', ackMigrations: false })).rejects.toThrow('digests differ');
  });

  it('adopt-serving for a whole vertical reports what it managed before it stopped', async () => {
    plane(json({ adopted: ['a', 'b'], alreadyAdopted: ['c'] }));
    await adoptVerticalServing({ controlPlaneUrl: CP, header: HEADER, slug: 'acme/crm' });
    expect(seen).toEqual([
      { url: `${CP}/verticals/acme%2Fcrm/adopt-serving`, method: 'POST', headers: { ...HEADER, ...JSON_TYPE }, body: '{}' },
    ]);
    expect(out.join('\n')).toContain('adopted 2 scope(s), 1 already');
    plane(json({ detail: 'scope d failed', adopted: ['a'], alreadyAdopted: ['b'] }, 500));
    await expect(adoptVerticalServing({ controlPlaneUrl: CP, header: HEADER, slug: 's' })).rejects.toThrow(
      'scope d failed (adopted 2 before stopping)',
    );
    plane(new Response('plain', { status: 200 }));
    out.length = 0;
    await adoptVerticalServing({ controlPlaneUrl: CP, header: HEADER, slug: 's' });
    expect(out.join('\n')).toContain('adopted 0 scope(s), 0 already');
  });
});

describe('preview', () => {
  const base = { controlPlaneUrl: CP, header: HEADER, slug: 'helpdesk' };

  it('every preview call carries the JSON type, reads and deletes included', async () => {
    const all: Seen[] = [];
    plane(json({ scopeId: 'S', hostname: 'h', url: 'u', versionId: 'v', reused: false }));
    await createPreview({ ...base, tag: 'pr-7', versionId: 'v' });
    all.push(...seen);
    plane(json({ deleted: 'S' }));
    await deletePreview({ ...base, tag: 'pr-7' });
    all.push(...seen);
    plane(json([]));
    await listPreviews(base);
    all.push(...seen);
    expect(all.map((r) => [r.url, r.method, r.headers])).toEqual([
      [`${CP}/verticals/helpdesk/previews`, 'POST', { ...HEADER, ...JSON_TYPE }],
      [`${CP}/verticals/helpdesk/previews/pr-7`, 'DELETE', { ...HEADER, ...JSON_TYPE }],
      [`${CP}/verticals/helpdesk/previews`, 'GET', { ...HEADER, ...JSON_TYPE }],
    ]);
  });

  it('nudges a stale CLI off a preview answer', async () => {
    onTty();
    plane(json([], 200, STALE));
    await listPreviews(base);
    expect(err.join('\n')).toMatch(/a newer substrat CLI is available/);
  });
});

describe('the version reads behind push', () => {
  it('nextVersion walks every page at 200 and bumps the max release', async () => {
    plane(page([{ version: '0.1.0' }], 'c1'), page([{ version: '0.4.9' }]));
    await expect(nextVersion(CP, HEADER, ['acme/crm'], undefined)).resolves.toBe('0.4.10');
    expect(seen.map((r) => [r.url, r.headers])).toEqual([
      [`${CP}/verticals/acme%2Fcrm/versions?limit=200`, HEADER],
      [`${CP}/verticals/acme%2Fcrm/versions?limit=200&cursor=c1`, HEADER],
    ]);
  });

  it('a refused, unreachable or malformed read falls back to the seed rather than failing the push', async () => {
    plane(new Response('no', { status: 403 }));
    await expect(nextVersion(CP, HEADER, ['s'], '1.2.3')).resolves.toBe('1.2.3');
    plane(new TypeError('fetch failed'));
    await expect(nextVersion(CP, HEADER, ['s'], undefined)).resolves.toBe('0.0.1');
    plane(new Response('<html>', { status: 200 }));
    await expect(nextVersion(CP, HEADER, ['s'], '2.0.0')).resolves.toBe('2.0.0');
  });
});

describe('the push upload', () => {
  const target = { controlPlaneUrl: CP, authHeader: HEADER, slug: 'acme/crm' };
  const form = () => {
    const f = new FormData();
    f.set('manifest', '{}');
    return f;
  };

  it('POSTs the form with the credential map and NO content type (fetch writes the boundary)', async () => {
    plane(json({ id: 'v1', admission: 'admitted', deploymentRef: 'r', verticalSlug: 'acme/crm' }));
    const f = form();
    await expect(uploadVersion(target, f, 'worker.js (+0 modules)')).resolves.toMatchObject({ id: 'v1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: `${CP}/verticals/acme%2Fcrm/deploy`, method: 'POST', headers: HEADER });
    expect(seen[0]!.body).toBe(f);
    expect(out[0]).toBe(`uploading worker.js (+0 modules) → ${CP}/verticals/acme%2Fcrm/deploy`);
  });

  it('prints the problem document of a refusal, and nudges a stale CLI off it', async () => {
    onTty();
    plane(json({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'fork refused', code: 'conflict', errors: [{ path: 'tenant', message: 'unknown' }] }, 409, STALE));
    await expect(uploadVersion(target, form(), 'w')).rejects.toThrow(
      'push failed (409 conflict): fork refused\n  tenant: unknown',
    );
    expect(err.join('\n')).toMatch(/a newer substrat CLI is available/);
  });

  it('a network failure is the error fetch threw; a web page names the likely fix', async () => {
    const boom = new TypeError('fetch failed');
    plane(boom);
    await expect(uploadVersion(target, form(), 'w')).rejects.toBe(boom);
    plane(new Response('<html>', { status: 200 }));
    await expect(uploadVersion(target, form(), 'w')).rejects.toThrow(/got HTML, not JSON/);
  });
});
