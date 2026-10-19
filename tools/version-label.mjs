/**
 * A fixture's `version` label written from part of an id (#2402).
 *
 * `vertical_versions` is unique on `(vertical_slug, version)`. The kernel's ulid is monotonic only
 * within a millisecond; in a later one the random half is drawn afresh, so ANY suffix of an id
 * (`id.slice(-4)` is 20 bits) is independent between two versions, and a slug that publishes
 * several of them collides now and then, red on a push to `main` with no change to blame
 * (#2402: `UNIQUE constraint failed: vertical_versions.vertical_slug, vertical_versions.version`).
 * The whole id is the only part two ids from one mint never share, so a label is written from all
 * of it: `1.0.${id.toLowerCase()}`.
 *
 * The rule is scoped to VERSION construction, not to `slice(-n)`: a slug, a tag or a ref that
 * takes the tail of an id (`slug: \`x-${id.slice(-6)}\``) is judged by its own uniqueness and is
 * not this tool's business. It reads one line at a time and sees a `version:` property whose value
 * is, or interpolates, `<identifier>.slice(-<digits>)`. A label reached through a variable
 * (`const tail = id.slice(-4); … version: tail`) is out of its sight.
 */
const TRUNCATED_VERSION = /\bversion\s*:\s*(?:`[^`\n]*\$\{\s*)?[A-Za-z_$][\w$.]*\.slice\(\s*-\d/;

export const REMEDY =
  'A version label built from a slice of an id collides with another version of the same slug now ' +
  'and then (#2402). Write it from the whole id: `1.0.${id.toLowerCase()}`.';

/**
 * @param {string} src
 * @returns {{ line: number, text: string }[]}
 */
export function findTruncatedVersions(src) {
  return src.split('\n').flatMap((text, i) => (TRUNCATED_VERSION.test(text) ? [{ line: i + 1, text: text.trim() }] : []));
}
