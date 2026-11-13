// Web-standard everywhere this runs; declared locally so the connector pulls in no platform typings.
declare const URL: new (input: string) => {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  origin: string;
};

/**
 * The store URL a tenant pastes, judged before anything is sent to it.
 *
 * Every other connector talks to one fixed provider host. A WooCommerce store runs on the
 * merchant's own domain, so the host this connector calls is tenant input — and the platform
 * calling a tenant-chosen address with a credential attached is the shape of a request forgery.
 * This refuses what can be refused from the text alone:
 *
 * - anything but `https:` — the consumer secret travels in an `Authorization` header, and
 *   WooCommerce only accepts it there over TLS;
 * - credentials, a query or a fragment in the URL — the base is a place, never a carrier;
 * - an explicit port — a store is served on 443, and a port is how one public host is probed for
 *   its other services;
 * - an IP literal, in any spelling the URL parser normalises to one (`0x7f000001` is
 *   `127.0.0.1` by the time it is read here);
 * - `localhost`, a single-label name, and the suffixes reserved for private networks
 *   (`.local`, `.internal`, `.lan`, `.home.arpa`, `.localhost`).
 *
 * What it cannot refuse: a public name that resolves to a private address, now or after the
 * check (DNS rebinding). Resolution happens in the runtime's `fetch`, after this. On the hosted
 * platform the egress path is what stands there; on a self-host it is the operator's network.
 *
 * Answers the normalised base — origin plus any path WordPress is installed under, with no
 * trailing slash — or throws a {@link StoreUrlError} naming what was wrong.
 */
export function storeBaseUrl(input: string, options?: { allowLocalHttp?: boolean }): string {
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(input.trim());
  } catch {
    throw new StoreUrlError(`not a URL: '${clip(input)}'`);
  }
  const local = options?.allowLocalHttp === true;
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new StoreUrlError(`the store URL must start with https:// — got ${url.protocol}//`);
  }
  if (url.username !== '' || url.password !== '') throw new StoreUrlError('the store URL must not carry credentials');
  if (url.search !== '' || url.hash !== '') throw new StoreUrlError('the store URL must not carry a query or a fragment');
  if (!local) {
    if (url.port !== '') throw new StoreUrlError(`the store must be served on the default port, not :${url.port}`);
    const host = url.hostname.toLowerCase();
    if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) {
      throw new StoreUrlError('the store URL must name a host, not an IP address');
    }
    if (!host.includes('.')) throw new StoreUrlError(`'${host}' is not a public host name`);
    if (PRIVATE_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
      throw new StoreUrlError(`'${host}' is a private network name, which the platform does not call`);
    }
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

export class StoreUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreUrlError';
  }
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
