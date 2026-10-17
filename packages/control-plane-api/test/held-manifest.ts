import { migrationDigestOf } from '@substrat-run/contracts';

/**
 * #2339: the control plane derives a version's migration digest from the migrations it stores,
 * and a version that stores none has a digest equal to no other version's. A fixture whose
 * migration digest is a tag ('g1') means "migration set g1", so these make the version hold one
 * fixture migration named by the tag and send the digest the server derives: same tag, same
 * digest; different tags, different digests. Migrations a fixture already carries are kept.
 */
type Migrations = Parameters<typeof migrationDigestOf>[0]['migrations'];

const fixtureMigrations = (tag: string): Migrations => [
  { moduleId: 'fixture', version: '0001-fixture', sql: `-- ${tag}` },
];

async function derived(manifest: Record<string, unknown>, tag: string): Promise<{ migrations: Migrations; digest: string }> {
  const migrations = Array.isArray(manifest.migrations) ? (manifest.migrations as Migrations) : fixtureMigrations(tag);
  const doClasses = (manifest.doClasses as string[] | undefined) ?? [];
  return { migrations, digest: await migrationDigestOf({ doClasses, migrations }) };
}

/** A deploy manifest whose `digests.migration` tag is turned into a held migration set. */
export async function heldManifest<M extends Record<string, unknown>>(manifest: M): Promise<M> {
  const digests = manifest.digests as Record<string, unknown> | undefined;
  if (typeof digests?.migration !== 'string') return manifest;
  const { migrations, digest } = await derived(manifest, digests.migration);
  return { ...manifest, migrations, digests: { ...digests, migration: digest } };
}

/** A `publishVersion` input whose `migrationDigest` tag is turned into a held migration set. */
export async function heldVersion<V extends { migrationDigest: string; manifestJson?: string | null }>(input: V): Promise<V> {
  const manifest = input.manifestJson ? (JSON.parse(input.manifestJson) as Record<string, unknown>) : {};
  const { migrations, digest } = await derived(manifest, input.migrationDigest);
  const digests = manifest.digests as Record<string, unknown> | undefined;
  const held = { ...manifest, migrations, ...(digests ? { digests: { ...digests, migration: digest } } : {}) };
  return { ...input, migrationDigest: digest, manifestJson: JSON.stringify(held) };
}
