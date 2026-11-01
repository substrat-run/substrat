/**
 * The Raw tab every detail screen ends with (AuthHero puts one on each): the record as JSON,
 * the cheapest answer to "what is actually stored". Anything that looks like secret material is
 * replaced before it is drawn — the reads behind these screens never return a secret today, and
 * this is what keeps a future field from being the first one that does, on the one screen made
 * for copying text out of.
 */
const SECRET_KEY = /secret|password|token|hash|private|certificate|passphrase/i;
/**
 * A key that NAMES a secret without holding one — `token_endpoint_auth_method`,
 * `client_secret_expires_at` — is configuration the Raw tab exists to show.
 */
const DESCRIBES_A_SECRET = /_(method|endpoint|expires_at|ttl|type)$/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  // Before the object case: a Date has no own keys, so it would be drawn as `{}`.
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) && !DESCRIBES_A_SECRET.test(k) && v !== null && v !== undefined && typeof v !== 'boolean' ? '••••••' : redact(v),
      ]),
    );
  }
  return value;
}

export function RawJson({ value }: { value: unknown }) {
  return (
    <section className="panel">
      <pre style={{ margin: 0, overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: '19px', color: 'var(--text-primary)' }}>
        {JSON.stringify(redact(value), null, 2)}
      </pre>
    </section>
  );
}
