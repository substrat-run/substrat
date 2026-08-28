import { describe, expect, it } from 'vitest';
import { EMPTY_GEO } from '@substrat-run/contracts';
import { cloudflareClientContext, cloudflareGeo } from '../src/client-context.js';

/**
 * `request.cf` normalised into the platform's shape. The object below is what the
 * edge actually attaches (trimmed to the fields that matter), so the test reads the
 * real key names rather than ones the normaliser would accept by construction.
 */
const CF = {
  colo: 'ARN',
  country: 'SE',
  isEUCountry: '1',
  continent: 'EU',
  city: 'Stockholm',
  region: 'Stockholm County',
  regionCode: 'AB',
  postalCode: '111 20',
  latitude: '59.33',
  longitude: '18.06',
  timezone: 'Europe/Stockholm',
  asn: 1257,
  asOrganization: 'Tele2',
  httpProtocol: 'HTTP/2',
  tlsVersion: 'TLSv1.3',
};

describe('cloudflareGeo', () => {
  it('carries country, region name, city, timezone and continent — and nothing that locates a street', () => {
    expect(cloudflareGeo(CF)).toEqual({
      country: 'SE',
      region: 'Stockholm County',
      city: 'Stockholm',
      timezone: 'Europe/Stockholm',
      continent: 'EU',
    });
  });

  it("turns Cloudflare's sentinels into null rather than a country a UI would render", () => {
    expect(cloudflareGeo({ ...CF, country: 'T1' }).country).toBeNull();
    expect(cloudflareGeo({ ...CF, country: 'XX' }).country).toBeNull();
  });

  it('is empty for a request that never crossed the edge', () => {
    expect(cloudflareGeo(undefined)).toEqual(EMPTY_GEO);
    expect(cloudflareGeo({})).toEqual(EMPTY_GEO);
    expect(cloudflareGeo('nonsense')).toEqual(EMPTY_GEO);
  });

  it('reads each field on its own, so one odd value does not blank the rest', () => {
    expect(cloudflareGeo({ ...CF, city: 42, timezone: '' })).toMatchObject({
      country: 'SE',
      city: null,
      timezone: null,
      region: 'Stockholm County',
    });
  });
});

describe('cloudflareClientContext', () => {
  it('is the header half from contracts plus the geo half from cf', () => {
    const ctx = cloudflareClientContext({
      headers: new Headers({
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        'accept-language': 'sv-SE,sv;q=0.9,en;q=0.8',
      }),
      cf: CF,
    });
    expect(ctx.language).toBe('sv-SE');
    expect(ctx.device).toMatchObject({ browser: 'Safari', os: 'iOS', kind: 'mobile' });
    expect(ctx.geo.city).toBe('Stockholm');
  });
});
