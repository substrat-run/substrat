import { describe, expect, it } from 'vitest';
import { storeBaseUrl } from '../src/store-url.js';

/** The store URL is tenant input the platform will call with a credential: judged before any request. */
describe('store URL guard', () => {
  it('normalises a store URL, keeping a path WordPress is installed under', () => {
    expect(storeBaseUrl(' https://Shop.Example.com/ ')).toBe('https://shop.example.com');
    expect(storeBaseUrl('https://example.com/butik/')).toBe('https://example.com/butik');
  });

  it.each([
    ['http://shop.example.com', 'plain HTTP'],
    ['ftp://shop.example.com', 'another scheme'],
    ['https://user:pw@shop.example.com', 'credentials in the URL'],
    ['https://shop.example.com/?consumer_key=ck', 'a query'],
    ['https://shop.example.com:8443', 'an explicit port'],
    ['https://10.0.0.5', 'a private IPv4 literal'],
    ['https://0x7f000001', 'an IPv4 literal in hex'],
    ['https://[::1]', 'an IPv6 literal'],
    ['https://localhost', 'localhost'],
    ['https://intranet', 'a single-label name'],
    ['https://metadata.google.internal', 'an .internal name'],
    ['https://printer.local', 'an mDNS name'],
    ['shop.example.com', 'no scheme at all'],
  ])('refuses %s — %s', (url) => {
    expect(() => storeBaseUrl(url)).toThrow();
  });

  it('admits a local plain-HTTP store only when the live test asks for it', () => {
    expect(storeBaseUrl('http://localhost:8080', { allowLocalHttp: true })).toBe('http://localhost:8080');
  });
});
