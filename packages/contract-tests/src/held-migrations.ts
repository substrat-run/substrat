import { migrationDigestOf } from '@substrat-run/contracts';

/**
 * #2339: a publish's migration digest is the one the host derives from the migrations the
 * version stores, and a version that stores none has a digest equal to no other version's. So a
 * fixture that means "the same migrations as that version" or "different ones" says so with a
 * migration set, not with a digest string the host would refuse or replace.
 *
 * `heldMigrations(tag)` is a publish's `migrationDigest` and `manifestJson` for a version whose
 * migrations are one fixture migration named by `tag`: two versions with the same tag hold the
 * same migrations, two tags hold different ones. `manifest` is merged in (its own `migrations`
 * and `doClasses`, when it has them, are what the digest is derived from).
 */
export async function heldMigrations(
  tag: string,
  manifest: Record<string, unknown> = {},
): Promise<{ migrationDigest: string; manifestJson: string }> {
  const full = { migrations: [{ moduleId: 'fixture', version: '0001-fixture', sql: `-- ${tag}` }], ...manifest };
  return { migrationDigest: await derivedDigestOf(full), manifestJson: JSON.stringify(full) };
}

/** The digest the host derives for a manifest that carries `migrations` (and `doClasses`, default none). */
export async function derivedDigestOf(manifest: Record<string, unknown>): Promise<string> {
  return migrationDigestOf({
    doClasses: (manifest.doClasses as string[] | undefined) ?? [],
    migrations: manifest.migrations as Parameters<typeof migrationDigestOf>[0]['migrations'],
  });
}

/**
 * A `publishVersion` input whose `migrationDigest` tag becomes a held migration set: its
 * `manifestJson` (when it has one) gains the fixture migration unless it carries its own, and
 * `migrationDigest` (and the manifest's `digests.migration`) become the derived digest.
 */
export async function heldVersion<V extends { migrationDigest: string; manifestJson?: string | null }>(input: V): Promise<V> {
  const manifest = input.manifestJson ? (JSON.parse(input.manifestJson) as Record<string, unknown>) : {};
  const { migrations, ...rest } = manifest;
  const { manifestJson, migrationDigest } = await heldMigrations(
    input.migrationDigest,
    Array.isArray(migrations) ? manifest : rest,
  );
  const held = JSON.parse(manifestJson) as Record<string, unknown>;
  const digests = held.digests as Record<string, unknown> | undefined;
  if (digests) held.digests = { ...digests, migration: migrationDigest };
  return { ...input, migrationDigest, manifestJson: JSON.stringify(held) };
}
