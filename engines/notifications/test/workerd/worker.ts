/**
 * The workerd suite's worker: a ScopeDO over the engine and its probe, the directory it
 * reads, and a fetch handler so the worker is valid. Driven through `CloudflareScopeHost`.
 */
import { ControlPlaneDO, defineScopeDO } from '@substrat-run/adapter-cloudflare';
import { MODULES } from './fixture.js';

export const ScopeDO = defineScopeDO(MODULES, {});
export { ControlPlaneDO };

export default {
  fetch: () => new Response('engine-notifications workerd suite', { status: 404 }),
};
