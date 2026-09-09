import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { saasRoutingTargetOf } from '../src/saas-routing-target.js';

/**
 * #973: the derived default has to be the record production actually publishes.
 *
 * It read `edge.<base>` while `wrangler.jsonc` documents — and the custom-domain runbook
 * hands out — `cname.<base>`. Nothing resolves at `edge.substrat.run`, so a deployment
 * that never set `CF_SAAS_ROUTING_TARGET` told every tenant to point DNS at a name that
 * does not exist, and the bind sat in `verifying` forever. The prefix is the assertion.
 */
describe('saasRoutingTargetOf', () => {
  it('derives `cname.<first base domain>` when the secret is unset', () => {
    expect(saasRoutingTargetOf({ PLATFORM_BASE_DOMAINS: 'substrat.run' })).toBe('cname.substrat.run');
    // First wins, and the list is normalized on the way through.
    expect(saasRoutingTargetOf({ PLATFORM_BASE_DOMAINS: ' Test.Substrat.Run , substrat.run ' })).toBe(
      'cname.test.substrat.run',
    );
  });

  it('falls back to the platform default base domain when no bases are configured', () => {
    expect(saasRoutingTargetOf({})).toBe('cname.substrat.run');
    expect(saasRoutingTargetOf({ PLATFORM_BASE_DOMAINS: '' })).toBe('cname.substrat.run');
  });

  it('prefers an explicitly configured target over the derived one', () => {
    expect(
      saasRoutingTargetOf({ CF_SAAS_ROUTING_TARGET: 'fallback.example.net', PLATFORM_BASE_DOMAINS: 'substrat.run' }),
    ).toBe('fallback.example.net');
    expect(saasRoutingTargetOf({ CF_SAAS_ROUTING_TARGET: '  cname.test.substrat.run  ' })).toBe(
      'cname.test.substrat.run',
    );
  });

  it("derives, from THIS deployment's own checked-in vars, the value wrangler.jsonc documents", () => {
    // The pool loads wrangler.jsonc, so its top-level `vars` ARE this suite's environment
    // (the same trick `dispatch-namespace.test.ts` uses). That makes the comment beside
    // `wrangler secret put CF_SAAS_ROUTING_TARGET` a tested fact rather than prose: the
    // documented example and the value an unset deployment actually gets are one string,
    // and changing either the prefix or `PLATFORM_BASE_DOMAINS` without the other is red.
    const { PLATFORM_BASE_DOMAINS } = env as { PLATFORM_BASE_DOMAINS?: string };
    expect(saasRoutingTargetOf({ PLATFORM_BASE_DOMAINS })).toBe('cname.substrat.run');
  });

  it('reads a blank secret as unset rather than surfacing an empty routing record', () => {
    // A half-run rotation leaves `''`; publishing that as the CNAME value tells the
    // tenant to point their domain at nothing.
    expect(saasRoutingTargetOf({ CF_SAAS_ROUTING_TARGET: '   ', PLATFORM_BASE_DOMAINS: 'substrat.run' })).toBe(
      'cname.substrat.run',
    );
  });
});
