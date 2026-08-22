import { describe, expect, it } from 'vitest';
import { navPath, parseNav } from '../src/lib/nav';

/**
 * URL ⇄ nav state. The property that matters is that every identifier the console
 * shows in a table survives being put in the address bar and read back — including a
 * tenant-owned vertical's slug, which is `<tenantSlug>/<name>` (#417) and therefore
 * contains a path separator. Reading only the segment after the view resolved
 * `/verticals/acme/crm` to the vertical `acme`, matched nothing, and dropped the
 * operator back on the list with no error.
 */
describe('parseNav', () => {
  it('keeps a slashed vertical slug whole', () => {
    expect(parseNav('/verticals/substrat-9yjbbn/auth-server', '')).toEqual({
      view: 'verticals',
      vertical: 'substrat-9yjbbn/auth-server',
    });
  });

  it('resolves the encoded form to the same slug', () => {
    expect(parseNav('/verticals/substrat-9yjbbn%2Fauth-server', '').vertical).toBe('substrat-9yjbbn/auth-server');
  });

  it('reads a builtin vertical, a tenant and a scope', () => {
    expect(parseNav('/verticals/callout', '').vertical).toBe('callout');
    expect(parseNav('/tenants/01H0', '').tenant).toBe('01H0');
    expect(parseNav('/scopes/01H1', '').scope).toBe('01H1');
  });

  it('falls back to tenants for a bare or unknown path, and honours a legacy ?view=', () => {
    expect(parseNav('/', '')).toEqual({ view: 'tenants' });
    expect(parseNav('/nonsense', '')).toEqual({ view: 'tenants' });
    expect(parseNav('/', '?view=scopes')).toEqual({ view: 'scopes' });
  });
});

describe('navPath', () => {
  it('round-trips a slashed slug', () => {
    const { path } = navPath('verticals', 'substrat-9yjbbn/auth-server', '');
    expect(path).toBe('/verticals/substrat-9yjbbn/auth-server');
    expect(parseNav(path, '').vertical).toBe('substrat-9yjbbn/auth-server');
  });

  it('preserves the dev actor and drops a consumed ?view=', () => {
    expect(navPath('scopes', undefined, '?view=scopes&actor=staff-1').url).toBe('/scopes?actor=staff-1');
  });

  it('omits the detail segment when there is none', () => {
    expect(navPath('verticals', undefined, '').path).toBe('/verticals');
  });
});
