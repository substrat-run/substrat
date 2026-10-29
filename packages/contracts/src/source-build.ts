import { z } from 'zod';
import { versionOrigin } from './registry.js';

export const SOURCE_BYTES_MAX = 48 * 1024 * 1024;
export const SOURCE_FILES_MAX = 20_000;

/** Canonical relative paths only. Also used before writing a submitted tree to disk. */
export const sourcePath = z.string().min(1).max(1024).refine(
  (p) => !/[\\\x00-\x1f\x7f]/.test(p) && !p.startsWith('/') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git'),
  'expected a repository-relative path without traversal or .git',
);

export function excludedSourcePath(path: string): boolean {
  return path.split('/').some((s) => /^(?:\.git|\.aws|\.ssh|\.codex|\.agents|\.builder|node_modules|dist|dist-worker|coverage|\.wrangler|secrets)$/i.test(s) ||
    /^(?:\.env|\.dev\.vars)(?:\.|$)/i.test(s) || /^(?:\.npmrc|\.netrc|credentials)$/i.test(s) || /\.(?:pem|key|p12|pfx)$/i.test(s));
}

export const sourceFile = z.object({
  path: sourcePath.refine((p) => !excludedSourcePath(p), 'credential or generated path is excluded'),
  base64: z.string().max(SOURCE_BYTES_MAX).refine((s) => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s), 'invalid base64'),
  executable: z.boolean().default(false),
}).strict();

export const sourceSnapshot = z.object({
  files: z.array(sourceFile).min(1).max(SOURCE_FILES_MAX),
  directory: sourcePath.or(z.literal('.')).default('.'),
}).strict().superRefine((tree, ctx) => {
  const allPaths = new Set(tree.files.map((f) => f.path.toLowerCase()));
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of tree.files) {
    const folded = file.path.toLowerCase();
    if (paths.has(folded)) ctx.addIssue({ code: 'custom', message: 'duplicate source path' });
    paths.add(folded);
    bytes += file.base64.length;
    const parent = file.path.split('/');
    while (parent.length > 1) {
      parent.pop();
      if (allPaths.has(parent.join('/').toLowerCase())) {
        ctx.addIssue({ code: 'custom', message: 'source file conflicts with a directory' });
        break;
      }
    }
  }
  if (bytes > SOURCE_BYTES_MAX) ctx.addIssue({ code: 'custom', message: 'source snapshot exceeds upload limit' });
  const pkg = tree.directory === '.' ? 'package.json' : `${tree.directory}/package.json`;
  if (!paths.has(pkg.toLowerCase())) ctx.addIssue({ code: 'custom', message: 'build directory has no package.json' });
});
export type SourceSnapshot = z.infer<typeof sourceSnapshot>;

export const projectRepository = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifacts'), name: z.string().regex(/^[a-zA-Z0-9_-]+$/), remote: z.string().url(), branch: z.string().default('main') }).strict(),
  z.object({ kind: z.literal('github'), owner: z.string().regex(/^[\w-]+$/), repo: z.string().regex(/^[\w.-]+$/), branch: z.string().min(1).max(200).default('main'), directory: sourcePath.or(z.literal('.')).default('.') }).strict(),
]);
export type ProjectRepository = z.infer<typeof projectRepository>;

export const sourceBuildRequest = z.object({
  version: z.string().min(1).max(100),
  name: z.string().min(1).max(200).optional(),
  origin: versionOrigin.optional(),
  snapshot: sourceSnapshot.optional(),
  revision: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  tenant: z.string().min(1).optional(),
  allowFork: z.boolean().default(false),
  allowUnservedUi: z.boolean().default(false),
  allowUnsweptSchedules: z.boolean().default(false),
  requireDataLossCheck: z.boolean().default(false),
}).strict().refine((v) => Boolean(v.snapshot) !== Boolean(v.revision), 'supply exactly one of snapshot or revision');
export type SourceBuildRequest = z.infer<typeof sourceBuildRequest>;

export const sourceBuildResult = z.object({
  projectId: z.string().min(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  dataLoss: z.discriminatedUnion('status', [
    z.object({ status: z.literal('passed'), authored: z.number().int().nonnegative() }),
    z.object({ status: z.literal('skipped'), why: z.string() }),
    z.object({ status: z.literal('incomplete'), authored: z.number().int().nonnegative(), notReplayed: z.number().int().nonnegative(), key: z.string(), message: z.string() }),
  ]),
});

export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  repository: ProjectRepository;
  directory: string;
  revision?: string;
  createdAt: string;
  updatedAt: string;
}

/** Private service result: these parts never come from a public release upload. */
export interface BuiltSource {
  form: FormData;
  projectId: string;
  revision: string;
  dataLoss: z.infer<typeof sourceBuildResult>['dataLoss'];
}

export interface SourceBuildService {
  build(tenantId: string, slug: string, request: SourceBuildRequest): Promise<BuiltSource>;
  projects(tenantId: string, request: Request): Promise<Response>;
}
