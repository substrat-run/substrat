import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tenantCredentialPin } from '@substrat-run/control-plane-api';

/**
 * Every route this seam can issue is one the dashboard's tenant credential reaches (#977).
 *
 * The control plane now default-DENIES a tenant-scoped credential: a route off its
 * allowlist is a 403. That is the right posture — forgetting one costs a feature, never
 * an escalation — but it puts the two halves of a working dashboard in two packages,
 * and nothing on either side can see the gap: the plane's suite proves the refusal, the
 * dashboard's suite injects a fake plane and never issues the request, and both stay
 * green while a tab returns 403 in production.
 *
 * So this reads the call sites out of `authority.ts` and asks the plane's own predicate
 * about each. It is a source-level test, which is unusual here and is the point: the
 * fact it checks is "which routes does this file call", and that fact only exists in
 * the file. Writing the list by hand instead is exactly how `GET /scopes` — the Data
 * tab's scope switcher and the whole Move/Retire flow — was missed on the first pass.
 *
 * An unparseable call site FAILS rather than being skipped. A test that quietly ignores
 * what it cannot read is a test that goes green as its subject drifts out of reach.
 */
describe('the tenant credential reaches every route the authority seam calls', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/authority.ts'), 'utf8');

  /** One `this.call/post/page/listAll/walkList(...)` — its HTTP method and its path. */
  interface Site {
    method: string;
    path: string;
    line: number;
  }

  const sites = ((): Site[] => {
    const out: Site[] = [];
    const re = /this\.(call|post|page|listAll|walkList)\s*(<[\s\S]*?>)?\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      // Balance parens from the opening one to find this call's argument list.
      let i = m.index + m[0].length;
      let depth = 1;
      while (depth > 0 && i < src.length) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') depth -= 1;
        i += 1;
      }
      const args = src.slice(m.index + m[0].length, i - 1);
      const line = src.slice(0, m.index).split('\n').length;
      // The first argument is the path: a template or a plain string literal, possibly
      // behind a line comment explaining it. The two private helpers that take a `path`
      // VARIABLE are the plumbing every other site goes through, so they carry no route
      // of their own.
      const head = args.replace(/^(?:\s*\/\/[^\n]*\n)*/, '');
      const literal = /^\s*(`[^`]*`|'[^']*')/.exec(head);
      if (!literal) {
        expect(
          /^\s*(path|url)\b/.test(head),
          `authority.ts:${line}: a call site this test cannot read — ${args.slice(0, 60)}`,
        ).toBe(true);
        continue;
      }
      const raw = literal[1]!.slice(1, -1);
      if (!raw.startsWith('/')) {
        // A path built onto a VARIABLE (`${path}?…`) is the list-walking plumbing, not
        // a route: the route it walks was named at the call site that passed `path` in.
        expect(
          raw.startsWith('${path'),
          `authority.ts:${line}: a path this test cannot read — ${raw.slice(0, 60)}`,
        ).toBe(true);
        continue;
      }
      const path = raw
        // `${…}` is an id or a slug — one path segment either way.
        .replace(/\$\{[^}]*\}/g, 'x')
        .replace(/\?.*$/, '');
      const method = m[1] === 'post' ? 'POST' : (/method:\s*'(\w+)'/.exec(args)?.[1] ?? 'GET');
      out.push({ method, path, line });
    }
    return out;
  })();

  it('found the call sites — a parser that reads nothing proves nothing', () => {
    // A floor, not the exact count: the assertion is that the extraction still works,
    // not that the seam has a particular size.
    expect(sites.length).toBeGreaterThan(60);
    expect(sites.some((s) => s.path === '/scopes' && s.method === 'GET')).toBe(true);
  });

  it('every one of them is on the credential’s allowlist', () => {
    const unreachable = sites
      .filter((s) => tenantCredentialPin(s.method, s.path) === undefined)
      .map((s) => `${s.method} ${s.path} (authority.ts:${s.line})`);
    expect(unreachable).toEqual([]);
  });

  it('the mint is NOT reachable — a credential must not be able to make another', () => {
    // The one route this seam deliberately reaches over the platform service token
    // instead, from the worker. If it ever appears on the allowlist, a tenant token
    // could mint itself a different tenant's and the confinement would be advisory.
    expect(tenantCredentialPin('POST', '/tenant-tokens')).toBeUndefined();
    expect(tenantCredentialPin('GET', '/tenants')).toBeUndefined();
  });
});
