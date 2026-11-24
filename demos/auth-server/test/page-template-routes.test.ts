import { describe, it, expect, afterEach, vi } from 'vitest';
import routes, { type Env } from '../src/routes.js';
import type { AuthServerStub } from '../src/do-contract.js';
import { sampleVariables, type PageVariables } from '../src/page-template.js';
import type { PageTemplateAnswer } from '../src/page-template-data.js';

/**
 * The worker's half of the page template (#3350): it asks the issuer for the template and this
 * request's variables, renders the page itself under the page's policy, and serves the built-in
 * page whenever it cannot. Typed under `tsconfig.worker.json`, as `routes.ts` is.
 */

/** Everything a template can print, on one line (as `page-template.test.ts`). */
const PRINT_ALL = `<html lang="{{ locale }}"><head>{%- auth0:head -%}</head><body>
{{ prompt.name }}|{{ prompt.screen.name }}|{{ locale }}|{{ application.name }}|{{ application.client_id }}|{{ application.metadata.tier }}|{{ user.name }}|{{ user.email }}|{{ branding.colors.primary }}|{{ tenant.friendly_name }}|{{ tenant.enabled_locales | join: "," }}
{%- auth0:widget -%}</body></html>`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a hosted page', () => {
  /** The worker's routes, over an issuer that answers the page read with `answer`. */
  function worker(answer: PageTemplateAnswer | 'unreachable') {
    const stub = {
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname !== '/__page-template') return Response.json({});
        if (answer === 'unreachable') throw new Error('issuer down');
        return Response.json(answer);
      },
    } as unknown as AuthServerStub;
    const env = { AUTH: { idFromName: (n: string) => n, get: () => stub } } as unknown as Env;
    return (path: string) => routes.request(`https://auth.example.com${path}`, {}, env);
  }
  const variables = (): PageVariables => sampleVariables('login', 'en', false);

  it('is drawn inside the template, with a nonce on every script and a policy naming it', async () => {
    const res = await worker({ template: PRINT_ALL, variables: variables(), imageOrigins: ['https://example.com'] })('/login');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("img-src 'self' data: https://example.com");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('login|login|en|Example app|');
    for (const script of html.match(/<script\b[^>]*>/g) ?? []) expect(script).toContain(`nonce="${nonce}"`);
  });

  it.each([
    ['a template that fails at request time', { template: '{%- auth0:head -%}{{ x | nope }}{%- auth0:widget -%}', variables: variables(), imageOrigins: [] }],
    ['an issuer that does not answer', 'unreachable' as const],
  ])('%s gets the built-in page, and a log line', async (_label, answer) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker(answer as PageTemplateAnswer | 'unreachable')('/login');
    // The built-in page: whatever the catch-all serves, and no template policy.
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(await res.text()).not.toContain('login|login');
    expect(errors.mock.calls.flat().join(' ')).toMatch(/page template: (render failed|could not read it)/);
  });

  it('is the built-in page on ?builtin=0, without asking the issuer', async () => {
    const res = await worker('unreachable')('/login?builtin=0');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});

