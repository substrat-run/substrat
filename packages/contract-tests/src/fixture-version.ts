/**
 * The `version` label a fixture gives a `publishVersion` call, written from the version's own id.
 *
 * `vertical_versions` is unique on `(vertical_slug, version)`, so two versions of one slug must
 * not share a label. The kernel's `ulid()` is monotonic only within a millisecond: in a later one
 * the random half is drawn afresh, so any SUFFIX of an id (`id.slice(-4)` is 20 bits) is
 * independent between versions and two of them collide now and then (#2402). Only the whole id is
 * distinct for two ids from one mint, so the label carries all of it. A label is free-form text
 * (`z.string().min(1)`), which is why a 26-character tail is accepted.
 */
export function fixtureVersion(id: string, major = 1): string {
  return `${major}.0.${id.toLowerCase()}`;
}
