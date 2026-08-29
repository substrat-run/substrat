/**
 * Host helpers — the two questions the disclosure asks of an endpoint.
 *
 * Their own module because BOTH the provider table (a row whose location depends on
 * where its endpoint points) and the catalog (which builds the disclosure) need them,
 * and the table must not import the catalog that reads it.
 */

/** The host of a URL, or the string itself when it will not parse. */
export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * Is a host loopback — this machine, and no other?
 *
 * Answers `true` only for a host it RECOGNISES as loopback. An unfamiliar name, an
 * unparseable URL, `0.0.0.0`, a LAN address: all read as remote. That asymmetry is the
 * point, and it is the direction a privacy claim must be wrong in — telling somebody
 * their prompts stayed on their laptop when they went to a GPU box is a lie, while
 * telling them a local endpoint might have been sent to overstates the exposure and
 * costs them nothing.
 */
export function isLoopbackHost(host: string): boolean {
	// `new URL(...).host` carries the port; the name alone decides. IPv6 arrives
	// bracketed (`[::1]:11434`), which the same strip handles.
	const name = host.replace(/:\d+$/, '').toLowerCase();
	if (name === 'localhost' || name.endsWith('.localhost')) return true; // RFC 6761
	if (name === '[::1]' || name === '::1') return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}
