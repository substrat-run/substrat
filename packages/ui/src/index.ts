// @substrat-run/ui — the shared design-system primitives.
//
// Token-driven React components (inline styles + CSS custom properties only, no
// external CSS beyond the token files). Consumed as source by the Vite apps
// (console, dashboard) — there is no build step; the app bundler transpiles the
// TSX. The design tokens ride along at `@substrat-run/ui/styles.css`.
export * from './components';
export * from './hooks';
