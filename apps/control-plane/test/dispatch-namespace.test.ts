import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dispatchNamespaceOf } from '../src/dispatch-namespace.js';

/**
 * #962: the REST-side WfP calls address the dispatch namespace by NAME, and that name
 * used to default to prod's whenever `DISPATCH_NAMESPACE` was unset — which TEST never
 * set. The name now has no default: unset throws, and the checked-in wrangler.jsonc
 * `vars` (which this pool loads) carry it, so the suite also proves the config is there.
 */
describe('dispatchNamespaceOf', () => {
  it('returns the configured namespace', () => {
    expect(dispatchNamespaceOf({ DISPATCH_NAMESPACE: 'substrat-verticals-test' })).toBe('substrat-verticals-test');
    expect(dispatchNamespaceOf({ DISPATCH_NAMESPACE: '  substrat-verticals  ' })).toBe('substrat-verticals');
  });

  it('throws when unset or blank instead of guessing prod', () => {
    expect(() => dispatchNamespaceOf({})).toThrow(/DISPATCH_NAMESPACE is unset/);
    expect(() => dispatchNamespaceOf({ DISPATCH_NAMESPACE: '' })).toThrow(/DISPATCH_NAMESPACE is unset/);
    expect(() => dispatchNamespaceOf({ DISPATCH_NAMESPACE: '   ' })).toThrow(/DISPATCH_NAMESPACE is unset/);
  });

  it('is a checked-in var in wrangler.jsonc that matches the DISPATCH binding of this environment', () => {
    // The pool loads wrangler.jsonc, so its top-level `vars` ARE this suite's environment.
    expect(dispatchNamespaceOf(env as { DISPATCH_NAMESPACE?: string })).toBe('substrat-verticals');
  });
});
