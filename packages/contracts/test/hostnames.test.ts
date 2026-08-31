import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLATFORM_BASE_DOMAIN,
  RESERVED_LABEL_SEPARATOR,
  isDerivedLabel,
  isPlatformHost,
  parseHostname,
  parsePlatformBaseDomains,
  withLabel,
} from '../src/hostnames.js';

describe('parseHostname', () => {
  it('splits at the FIRST dot — the label a derived name replaces', () => {
    expect(parseHostname('crm.global.substrat.run')).toEqual({ label: 'crm', rest: 'global.substrat.run' });
    expect(parseHostname('crm.ahero.se')).toEqual({ label: 'crm', rest: 'ahero.se' });
  });

  it('lowercases, so a typed-in host and a stored one agree', () => {
    expect(parseHostname('CRM.Global.Substrat.Run')).toEqual({
      label: 'crm',
      rest: 'global.substrat.run',
    });
  });

  it('refuses a bare label — nothing can be minted beside it', () => {
    expect(parseHostname('crm')).toBeUndefined();
    expect(parseHostname('')).toBeUndefined();
  });

  /**
   * The reason call sites guard on this rather than on `hostname.includes('.')`: both of
   * these pass an `includes` check and neither has a first label to derive from.
   */
  it('refuses a hostname with an EMPTY first label', () => {
    expect(parseHostname('.example.com')).toBeUndefined();
    expect(parseHostname('.')).toBeUndefined();
  });
});

describe('withLabel', () => {
  it('mints a sibling in the same zone', () => {
    expect(withLabel('crm.global.substrat.run', 'crm--pr-7')).toBe('crm--pr-7.global.substrat.run');
    expect(withLabel('crm.global.substrat.run', 'crm-portal')).toBe('crm-portal.global.substrat.run');
  });

  it('carries a multi-label base through verbatim', () => {
    expect(withLabel('crm.global.test.substrat.run', 'crm--s1a2b')).toBe(
      'crm--s1a2b.global.test.substrat.run',
    );
  });

  it('is undefined where parseHostname is', () => {
    expect(withLabel('crm', 'x')).toBeUndefined();
    expect(withLabel('.example.com', 'x')).toBeUndefined();
  });

  /**
   * The total overload. A caller that already guarded with `parseHostname` gets a `string`
   * back and needs no non-null assertion — the assertion is the thing that rots when the
   * guard above it moves.
   */
  it('is total when handed a hostname already parsed', () => {
    const parsed = parseHostname('crm.global.substrat.run')!;
    const minted: string = withLabel(parsed, 'crm--pr-7');
    expect(minted).toBe('crm--pr-7.global.substrat.run');
  });
});

describe('the reserved separator', () => {
  it('is `--`, which a tenant label can never contain', () => {
    expect(RESERVED_LABEL_SEPARATOR).toBe('--');
    expect(isDerivedLabel('crm--pr-7')).toBe(true);
    expect(isDerivedLabel('crm--s1a2b')).toBe(true);
    // A single dash is an ordinary tenant-suffixed label, not a derived one.
    expect(isDerivedLabel('crm-sesamy')).toBe(false);
    expect(isDerivedLabel('crm')).toBe(false);
  });
});

describe('parsePlatformBaseDomains', () => {
  it('reads a comma-separated list, trimmed and lowercased', () => {
    expect(parsePlatformBaseDomains(' substrat.run , Test.Substrat.Run ')).toEqual([
      'substrat.run',
      'test.substrat.run',
    ]);
  });

  it('reads unset as an EMPTY list — the #423 shape, kept deliberately', () => {
    expect(parsePlatformBaseDomains(undefined)).toEqual([]);
    expect(parsePlatformBaseDomains('')).toEqual([]);
    expect(parsePlatformBaseDomains(',, ,')).toEqual([]);
  });
});

describe('isPlatformHost', () => {
  const bases = ['substrat.run'];

  it('matches the base itself and any depth of subdomain', () => {
    expect(isPlatformHost('substrat.run', bases)).toBe(true);
    expect(isPlatformHost('x.global.substrat.run', bases)).toBe(true);
    expect(isPlatformHost('x.global.test.substrat.run', bases)).toBe(true);
  });

  /** The dot boundary is the whole point — a bare `endsWith` claims someone else's zone. */
  it('does not match a domain that merely ends with the same letters', () => {
    expect(isPlatformHost('notsubstrat.run', bases)).toBe(false);
    expect(isPlatformHost('substrat.run.evil.example', bases)).toBe(false);
  });

  it('classifies nothing when no base is configured', () => {
    expect(isPlatformHost('x.substrat.run', [])).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    expect(isPlatformHost('X.Global.Substrat.Run', ['substrat.run'])).toBe(true);
    // The BASE side too. `parsePlatformBaseDomains` normalizes, but a caller that
    // assembles its bases some other way must not get a silent `false` here: a
    // classification guard that fails open on capitalization is worse than none.
    expect(isPlatformHost('x.substrat.run', ['SUBSTRAT.RUN'])).toBe(true);
    expect(isPlatformHost('x.substrat.run', ['  Substrat.Run  '])).toBe(true);
  });

  it('ignores an empty base rather than matching everything with it', () => {
    expect(isPlatformHost('anything.example.com', [''])).toBe(false);
    expect(isPlatformHost('anything.example.com', ['   '])).toBe(false);
  });

  it('names the default base rather than spelling the brand at each call site', () => {
    expect(isPlatformHost('x.substrat.run', [DEFAULT_PLATFORM_BASE_DOMAIN])).toBe(true);
  });
});
