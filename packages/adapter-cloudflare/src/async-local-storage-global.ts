/**
 * The global key the platform entry publishes its `AsyncLocalStorage` class under, at module load
 * (`tools/platform-entry-emit.mts`), for the scope-work meter (`scope-work.ts`, #3316). A pushed
 * script always has the class there (the uploader gives it `nodejs_als`), but the adapter cannot
 * import `node:async_hooks` itself: the scaffold and the dashboard bundle it with no node flag
 * (#2245, `lint:worker-node-imports`).
 *
 * Its own module, importing nothing, because the platform entry bundles it: every byte the entry
 * pulls in is added to every vertical's upload.
 */
export const ASYNC_LOCAL_STORAGE_GLOBAL = 'substrat.AsyncLocalStorage';
