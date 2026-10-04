/**
 * One vertical's script FAMILY (#1877), as the pattern `$metadata.service` is matched with —
 * the field Workers Logs indexes every event by. The stem itself is the serving script;
 * `<stem>-<ulid>` is a per-version script (previews, legacy scopes); `<stem>-eu` / `-us` a
 * jurisdictional one (K-30).
 *
 * Anchored, so another vertical whose stem merely begins with this one (`ticket0` and
 * `ticket0-crm`) is not in the family. One pattern for the telemetry query's filter and for a
 * reader that checks the lines it was handed (#1923), so the two cannot disagree about which
 * script a line came from.
 */

/** A lowercased ULID, as it ends a per-version script name (`deploymentRefFor`). */
const SCRIPT_ULID = '[0-9a-hjkmnp-tv-z]{26}';

/** The anchored pattern, as a string (the telemetry API's `regex` filter takes one). */
export function serviceFamilyPattern(stem: string): string {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}(-${SCRIPT_ULID})?(-(eu|us))?$`;
}

/**
 * A test for whether a service is a script of one of the families `stems` name, with the
 * patterns compiled once. An empty list names none.
 */
export function serviceFamilyMatcher(stems: readonly string[]): (service: unknown) => boolean {
  const patterns = stems.map((stem) => new RegExp(serviceFamilyPattern(stem)));
  return (service) => typeof service === 'string' && patterns.some((p) => p.test(service));
}
