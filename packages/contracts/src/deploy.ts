import { z } from 'zod';
import { permissionKey } from './ids.js';
import { envVarSpec, capability } from './manifest.js';

// The deploy manifest is the JSON part a `substrat push` sends alongside the
// module files (self-serve-deploy.md). It lives here — not in the transport
// package — because BOTH ends must speak the same shape: the CLI builds and
// validates it before upload, the control plane re-parses it at the trust
// boundary and runs the §4 sandbox contract against the result. One schema,
// two parses, no drift.

/** A binding the uploaded worker declares, as far as the sandbox contract check needs it. */
export const declaredBinding = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  class_name: z.string().optional(),
  script_name: z.string().optional(),
  /** For a `d1` binding: the database id — a vertical's OWN store (self-serve-deploy.md §4). */
  id: z.string().optional(),
});
export type DeclaredBinding = z.infer<typeof declaredBinding>;

/** The JSON part a `substrat push` sends alongside the module files. */
export const deployManifest = z.object({
  version: z.string().min(1),
  /** Display name for a first-time register; defaults to the slug. */
  name: z.string().min(1).optional(),
  /** Filename of the main module among the uploaded parts. */
  entry: z.string().min(1),
  compatibilityDate: z.string().min(1),
  compatibilityFlags: z.array(z.string().min(1)).default([]),
  doClasses: z.array(z.string().min(1)).default([]),
  bindings: z.array(declaredBinding).default([]),
  /** The vertical's declared env-spec (from its package.json `substrat.envSpec`), stored on
   *  the registry so a host/console renders a config form for it. Optional + validated here. */
  envSpec: z.array(envVarSpec).optional(),
  /** Registry-driven install (marketplace-publish.md §3), from package.json `substrat.*` —
   *  carried so the dashboard installs without a hardcoded catalog entry. Validated here. */
  ownerGrants: z.array(permissionKey).optional(),
  entitlements: z.array(z.string()).optional(),
  provides: z.array(capability).optional(),
  requires: z.array(capability).optional(),
  /** Computed by the builder's toolchain; what the promotion checkpoint compares. */
  digests: z.object({
    manifest: z.string().min(1),
    permission: z.string().min(1),
    migration: z.string().min(1),
  }),
});
export type DeployManifest = z.infer<typeof deployManifest>;
