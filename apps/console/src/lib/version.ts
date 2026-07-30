// Build stamp for the console. `__APP_VERSION__`/`__APP_SHA__` are string-replaced by
// Vite's `define` at build time (see vite.config.ts) from this package's version and the
// commit being built — so the running console can say exactly which build it is. Both are
// plain string literals after the substitution; the `declare` keeps TypeScript happy.
declare const __APP_VERSION__: string;
declare const __APP_SHA__: string;

export const APP_VERSION = __APP_VERSION__;
export const APP_SHA = __APP_SHA__;

/** `v0.5.4 · a1b2c3d` — the muted caption rendered in the shell footer. */
export const VERSION_LABEL = `v${APP_VERSION} · ${APP_SHA}`;
