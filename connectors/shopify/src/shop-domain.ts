/**
 * The shop a tenant names, judged before anything is sent to it.
 *
 * A WooCommerce store runs on the merchant's own domain, so that connector has to judge an arbitrary
 * address. Shopify's Admin API does not: every store answers it at exactly one host, its
 * permanent `<handle>.myshopify.com`, whatever custom domain the storefront shows. So this accepts
 * that one shape and nothing else, which leaves no address for a tenant to point the platform at:
 *
 * - `acme`, `acme.myshopify.com`, `https://acme.myshopify.com` and
 *   `https://acme.myshopify.com/admin` all name the shop `acme.myshopify.com`;
 * - a custom domain (`shop.acme.se`) is refused with the reason: the Admin API is not served there,
 *   and calling it would send a client secret to a host Shopify does not own;
 * - anything carrying credentials, a port, a query or a fragment is refused.
 *
 * A handle is what Shopify allows in a `myshopify.com` name: lowercase letters, digits and
 * hyphens, not starting or ending with a hyphen. Input is lowercased first.
 */
export class ShopDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopDomainError';
  }
}

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUFFIX = '.myshopify.com';

/** The shop's `<handle>.myshopify.com`, or a {@link ShopDomainError} naming what was wrong. */
export function shopDomain(input: string): string {
  let text = input.trim().toLowerCase();
  if (text === '') throw new ShopDomainError('the shop is empty: give its myshopify.com address, e.g. acme.myshopify.com');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(text);
  if (scheme) {
    if (scheme[1] !== 'https') throw new ShopDomainError(`the shop address must be https, not ${scheme[1]}`);
    text = text.slice(scheme[0].length);
  }
  // A path is allowed only as what a person copies from the admin (`/admin`, `/admin/...`); it is
  // dropped. Anything that would make the address carry something else is refused.
  if (/[@?#]/.test(text)) throw new ShopDomainError('the shop address must not carry credentials, a query or a fragment');
  const host = text.split('/')[0] ?? '';
  if (host.includes(':')) throw new ShopDomainError('the shop address must not name a port');
  const handle = host.endsWith(SUFFIX) ? host.slice(0, -SUFFIX.length) : host.includes('.') ? null : host;
  if (handle === null) {
    throw new ShopDomainError(
      `'${host}' is not a myshopify.com address. Shopify serves its Admin API only at the shop's permanent ` +
        `<handle>.myshopify.com name (Settings → Domains shows it), never at a custom domain.`,
    );
  }
  if (!HANDLE.test(handle)) throw new ShopDomainError(`'${handle}' is not a Shopify shop handle`);
  return `${handle}${SUFFIX}`;
}
