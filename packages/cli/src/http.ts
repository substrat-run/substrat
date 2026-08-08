/**
 * Shared JSON parsing for control-plane responses (#387). The single most common
 * misconfiguration — a control-plane URL pointing at the console SPA instead of its
 * `/api` base — used to surface as `Unexpected token '<', "<!doctype "… is not valid
 * JSON` from whichever command ran first: the CLI fetched an HTML page and fed it to
 * `JSON.parse`. Parse at the one place that knows the URL, and when the body is HTML,
 * name the likely fix instead of the token the parser tripped on.
 */

/**
 * When a 5xx carries Cloudflare's redacted-fault shape (`internal error;
 * reference = <id>`), say what it IS (#559 (7)): a platform-side infrastructure
 * fault, not an error in the caller's request or code — and the reference is a
 * handle for CLOUDFLARE support, which the CI error text used to miscall "a
 * control-plane trace only its operator can resolve". Returns '' when the
 * message is not that shape, so callers can append unconditionally.
 */
export function explainPlatformFault(status: number, message: string): string {
  if (status < 500 || !/\binternal error; reference\s*=\s*[a-z0-9]+/i.test(message)) return '';
  return (
    '\nThis is a Cloudflare-side infrastructure fault inside the platform, not a problem ' +
    'with your push or your code. The reference above is a Cloudflare support handle — ' +
    'report it to the platform operator (it is recorded in the console under ' +
    'Operations → Failures); retrying may help only if the fault was momentary.'
  );
}

/** Parse a response body as JSON; on failure, explain what was received and why. */
export function parseJsonBody<T>(body: string, url: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(
      /^\s*</.test(body)
        ? `got HTML, not JSON, from ${url} — is the control-plane URL the API base ` +
          `(e.g. https://console.substrat.net/api, not the console page)? ` +
          `Check --cp / SUBSTRAT_CP_URL / \`substrat login\`.`
        : `got a non-JSON response from ${url}: ${body.slice(0, 200)}`,
    );
  }
}

/** Read a fetch Response's body and parse it via `parseJsonBody`. */
export async function readJson<T>(res: Response, url: string): Promise<T> {
  return parseJsonBody<T>(await res.text(), url);
}

/**
 * Read a paged control-plane list to the END. Every GET list route returns
 * `{ entries, nextCursor }` (contracts pagination.ts) with a defaulted page, and
 * the CLI's reads are complete-list semantics (find the max semver, join installs
 * to hostnames) — so walk the cursor until it runs out, at the route's max page
 * size to keep the walk short. `fetchPage` owns auth headers and error handling.
 */
export async function readAllEntries<T>(
  url: string,
  fetchPage: (pageUrl: string) => Promise<{ entries: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const sep = url.includes('?') ? '&' : '?';
    const pageUrl: string = `${url}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await fetchPage(pageUrl);
    out.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return out;
}
