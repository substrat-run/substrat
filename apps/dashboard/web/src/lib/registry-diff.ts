/**
 * The version-to-version permission diff (#336) lives in `@substrat-run/contracts` since #1677,
 * so `substrat promote` reads the same one. Re-exported here so the dashboard's imports stay put.
 */
export {
  diffRegistries,
  hasRegistryChange,
  registryDirection,
  type RegistryDiff,
  type RegistryDirection,
  type RegistryLike,
} from '@substrat-run/contracts';
