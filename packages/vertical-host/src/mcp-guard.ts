/**
 * What the MCP mount and the operation routes share to keep a delegated token (#1824) at the
 * one endpoint that holds it to its scope. Internal: not re-exported from the package.
 */

/**
 * The claims of a presented JWS bearer, read WITHOUT checking its signature, or `null` when
 * there is no bearer or it is not a JWS. Only ever used to refuse: the resolver verifies the
 * same token, and a request has to pass both.
 */
export function bearerClaims(authorization: string | undefined): Record<string, unknown> | null {
  if (!authorization?.toLowerCase().startsWith('bearer ')) return null;
  const segments = authorization.slice(7).trim().split('.');
  if (segments.length !== 3) return null;
  let claims: unknown;
  try {
    const b64 = segments[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')), (ch) =>
      ch.charCodeAt(0),
    );
    claims = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null; // not a JWS payload, so not a token whose claims can be read here
  }
  return claims !== null && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
}

/** Whether the request's bearer is a DELEGATED token: one carrying RFC 8693 `act`. */
export function carriesAct(authorization: string | undefined): boolean {
  return bearerClaims(authorization)?.['act'] !== undefined;
}

/**
 * Whether a route registered at Hono `pattern` answers a request for the concrete `path`.
 *
 * Literal segments, `:param`, `:param{regex}` and a trailing optional `:param?` are read as
 * Hono reads them. A pattern with a `*` wildcard is NOT judged, and answers false: that is a
 * catch-all or a middleware (`app.use`), which every path meets and none of which is a
 * handler written for this one.
 */
export function patternAnswers(pattern: string, path: string): boolean {
  if (pattern.replace(/\{[^}]*\}/g, '').includes('*')) return false;
  const segments = pattern.split('/');
  const last = segments[segments.length - 1] ?? '';
  // An optional last parameter matches with and without its segment.
  if (/^:[A-Za-z0-9_]+(\{[^}]*\})?\?$/.test(last)) {
    const required = [...segments.slice(0, -1), last.slice(0, -1)].join('/');
    return patternAnswers(required, path) || patternAnswers(segments.slice(0, -1).join('/') || '/', path);
  }
  const source = segments
    .map((seg) => {
      const param = seg.match(/^:[A-Za-z0-9_]+(?:\{(.+)\})?$/);
      if (!param) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return param[1] === undefined ? '[^/]+' : `(?:${param[1]})`;
    })
    .join('/');
  try {
    return new RegExp(`^${source}$`).test(path);
  } catch {
    return false;
  }
}
