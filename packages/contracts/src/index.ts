/**
 * The Zod instance these schemas were built with.
 *
 * Import `z` FROM HERE, not from 'zod', whenever you compose a contracts schema
 * into your own — `z.object({ facility: entityRef, unitPrice: money })` is the
 * pattern the engines themselves use, and it is what "parse, don't trust" asks
 * of every operation input.
 *
 * Zod schemas do not compose across copies or majors: the mix fails at RUNTIME
 * with `Invalid element at key "…": expected a Zod schema`, an error that points
 * nowhere near the cause. We are on Zod 4, which is what `pnpm add zod` gives
 * you today — so the trap is currently dormant, not gone. It re-arms the day Zod
 * 5 ships, and it bit us once already (the packages were Zod 3 while the docs
 * told users to install the then-current Zod 4).
 *
 * Importing `z` from here means the consumer never installs zod at all, so the
 * versions cannot diverge no matter what the registry's `latest` becomes.
 */
export { z } from 'zod';

export * from './ids.js';
export * from './registry.js';
export * from './routing.js';
export * from './tenancy.js';
export * from './introspection.js';
export * from './pagination.js';
export * from './connections.js';
export * from './control-plane.js';
export * from './permission.js';
export * from './events.js';
export * from './platform-request.js';
export * from './manifest.js';
export * from './openapi.js';
export * from './deploy.js';
export * from './ci.js';
export * from './money.js';
export * from './attachments.js';
export * from './model.js';
export * from './operations.js';
export * from './emit-sql.js';
