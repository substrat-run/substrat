import { describe, expect, it } from 'vitest';
import { shopDomain } from '../src/shop-domain.js';

describe('shop domain', () => {
  it.each(['acme', 'ACME.myshopify.com', 'https://acme.myshopify.com', 'https://acme.myshopify.com/admin/products', ' acme.myshopify.com/ '])('reads %j as acme.myshopify.com', (input) => {
    expect(shopDomain(input)).toBe('acme.myshopify.com');
  });

  it.each([
    ['', /empty/],
    ['http://acme.myshopify.com', /must be https/],
    ['shop.acme.se', /not a myshopify\.com address/],
    ['acme.myshopify.com.evil.example', /not a myshopify\.com address/],
    ['https://user:pw@acme.myshopify.com', /credentials, a query or a fragment/],
    ['acme.myshopify.com?x=1', /credentials, a query or a fragment/],
    ['acme.myshopify.com:8443', /port/],
    ['-acme', /not a Shopify shop handle/],
    ['ac_me.myshopify.com', /not a Shopify shop handle/],
  ])('refuses %j', (input, error) => {
    expect(() => shopDomain(input)).toThrow(error);
  });
});
