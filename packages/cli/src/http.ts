/**
 * Shared JSON parsing for control-plane responses (#387). The single most common
 * misconfiguration — a control-plane URL pointing at the console SPA instead of its
 * `/api` base — used to surface as `Unexpected token '<', "<!doctype "… is not valid
 * JSON` from whichever command ran first: the CLI fetched an HTML page and fed it to
 * `JSON.parse`. Parse at the one place that knows the URL, and when the body is HTML,
 * name the likely fix instead of the token the parser tripped on.
 */

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
