import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { putPageTemplate } from '../../src/page-template.js';
import type { AuthServerDO } from '../../src/auth-do.js';

/**
 * The page template (#3350) in the deployed worker and issuer, in workerd — which refuses
 * `eval` and `new Function`, so a Liquid engine that compiled templates to code could not run
 * here at all. The worker asks the issuer for the template and this request's variables, and
 * renders the page itself.
 *
 * The standalone issuer answers: these requests carry no router assertion.
 */

const ORIGIN = 'https://auth-server.test';

async function setTemplate(template: string): Promise<void> {
  const stub = env.AUTH.get(env.AUTH.idFromName('auth-server'));
  await runInDurableObject(stub, (_instance, state) => {
    // Straight into storage: the second case is a template a save would refuse.
    putPageTemplate(state.storage.sql, template);
  });
}

beforeAll(async () => {
  const stub = env.AUTH.get(env.AUTH.idFromName('auth-server'));
  await runInDurableObject(stub, (instance) =>
    (instance as unknown as AuthServerDO).provisionInstance({ tenantId: ulid(), scopeId: ulid(), slug: 'acme-auth', name: 'Acme Auth' }, []),
  );
});

describe('a templated page in workerd', () => {
  it('is rendered by the worker, in the visitor’s language, under the page’s policy', async () => {
    await setTemplate(
      '<html lang="{{ locale }}"><head>{%- auth0:head -%}</head><body>' +
        '<p>{{ prompt.screen.name }}:{{ tenant.friendly_name | upcase }}:{% for l in tenant.enabled_locales %}{{ l }}{% unless forloop.last %},{% endunless %}{% endfor %}</p>' +
        '{%- auth0:widget -%}</body></html>',
    );
    const res = await SELF.fetch(`${ORIGIN}/login?ui_locales=sv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'self' 'nonce-[^']+'/);
    const html = await res.text();
    expect(html).toContain('<html lang="sv">');
    expect(html).toContain('<p>login:ACME AUTH:sv,en</p>');
    expect(html).toContain('<div id="root" class="page-template-widget"></div>');
  });

  it('falls back to the built-in page when a stored template spends its budget', async () => {
    // workerd's clock does not move while a render computes, so this ends on the budget.
    await setTemplate(
      '{%- auth0:head -%}{%- auth0:widget -%}{% assign a = "1,2,3,4,5,6,7,8,9,10" | split: "," %}' +
        '{% for i in a %}{% for j in a %}{% for k in a %}{% for l in a %}{% for m in a %}{% for n in a %}{% endfor %}{% endfor %}{% endfor %}{% endfor %}{% endfor %}{% endfor %}',
    );
    const res = await SELF.fetch(`${ORIGIN}/login`);
    // The catch-all's page (a 404 where no app was built), never the template's.
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(await res.text()).not.toContain('page-template-widget');
  });
});
