/**
 * Workers AI for `substrat dev` (#3420): whether a project gets model access, and the relay that
 * gives it. Loaded by `dev.ts` on demand, so the dev script runs whatever happens here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAuth } from './config.js';
import { startModelRelay, type ModelRelay } from './model-relay.js';
import { planeFor, viaPlane } from './plane.js';
import { failureMessage } from './problem.js';

/** The `substrat` block of the project's package.json, the two fields `dev` reads. */
function projectSubstrat(project: string): { usesModels?: unknown; tenant?: unknown } {
  try {
    const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as { substrat?: { usesModels?: unknown; tenant?: unknown } };
    return pkg.substrat ?? {};
  } catch {
    return {};
  }
}

/** Whether the project's `.env` sets a Workers AI key of its own. */
function dotEnvNamesModelKey(project: string): boolean {
  try {
    return /^\s*(?:export\s+)?CLOUDFLARE_AI_(?:API_TOKEN|BASE_URL)\s*=\s*\S/m.test(readFileSync(join(project, '.env'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Workers AI for a project that declares `substrat.usesModels` (#3420): a loopback relay over
 * the signed-in workspace's short-lived model access, handed to the app as the two variables
 * the model host's `cloudflare` row reads. Every way this can decline leaves the dev script
 * running as it would have without it, and says why in one line.
 */
export async function modelAccessFor(
  project: string,
  env: NodeJS.ProcessEnv,
  options: { models?: boolean; tenant?: string },
  log: (line: string) => void,
): Promise<ModelRelay | undefined> {
  if (options.models === false) return undefined;
  const substrat = projectSubstrat(project);
  if (substrat.usesModels !== true) return undefined;
  if (env.CLOUDFLARE_AI_BASE_URL || env.CLOUDFLARE_AI_API_TOKEN) {
    log('models: using CLOUDFLARE_AI_* from your environment (unset them to use your substrat login)');
    return undefined;
  }
  // A key the app loads from its own `.env` would lose to the relay's (a loaded file does not
  // override the environment), so a project that brought one keeps it.
  if (dotEnvNamesModelKey(project)) {
    log('models: using CLOUDFLARE_AI_* from .env (remove them to use your substrat login)');
    return undefined;
  }
  let auth;
  try {
    const pinned = typeof substrat.tenant === 'string' ? substrat.tenant : undefined;
    auth = resolveAuth({ tenant: options.tenant ?? env.SUBSTRAT_TENANT ?? pinned });
  } catch {
    log('models: not signed in — run `substrat login` to call Workers AI from this app');
    return undefined;
  }
  if (auth.kind !== 'session') {
    log('models: model access needs a person signed in with `substrat login`, not a service token');
    return undefined;
  }
  const plane = planeFor(auth.controlPlaneUrl, auth.header);
  const relay = await startModelRelay({
    issue: async () => {
      const access = await viaPlane(() => plane.issueModelAccess(), (e) => new Error(failureMessage('refused', e.status, e.body ?? e.statusText ?? '')));
      return { ...access, baseUrl: `${auth.controlPlaneUrl}/model-access/${encodeURIComponent(access.tenant.id)}/v1` };
    },
  });
  try {
    const access = await relay.access();
    log(`models: Workers AI through ${auth.controlPlaneUrl}, for workspace ${access.tenant.slug} — usage lands on its model usage ledger`);
    return relay;
  } catch (error) {
    await relay.close();
    log(`models: no model access (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

