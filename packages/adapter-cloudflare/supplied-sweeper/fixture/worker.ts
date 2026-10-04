/**
 * A scheduled vertical that wires NO sweeper (#1902) — the shape a vertical takes once the
 * platform supplies one. It declares schedules (`perms.ts`), exports only its own scope DO,
 * and mounts the platform surface with its `hostFor`: no `defineScopeSweeperDO`, no `SWEEPER`
 * store, no `noteScope`/`forgetScope` hooks. Everything the schedules need to fire on a hosted
 * deploy comes from the upload (`tools/workerd-as-uploaded.mjs` runs it as the uploader ships it).
 */
import { Hono } from 'hono';
import { CloudflareScopeHost, defineScopeDO } from '../../src/index.js';
import { invocationLog, mountPlatformSurface } from '@substrat-run/vertical-host';
import { MODULES, OWNER_ROLE_KEY, ROLES } from './perms.js';

interface Env {
  SCOPE: DurableObjectNamespace;
  PLATFORM_SECRET?: string;
  ROUTER_SECRET?: string;
}

export const ScopeDO = defineScopeDO(MODULES, {});

function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

const app = new Hono<{ Bindings: Env }>();
app.use('*', invocationLog<Env>({ routerSecret: (env) => env.ROUTER_SECRET }));
mountPlatformSurface<Env>(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor,
  roles: ROLES,
  ownerRoleKey: OWNER_ROLE_KEY,
});

export default app;
