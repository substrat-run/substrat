import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in the private 527x/887x block the demos + console use, clear of
// the Vite and Wrangler defaults. API_PORT matches the dashboard worker's dev
// server (`wrangler dev --port 8890`, see apps/dashboard/package.json) so
// `pnpm dev` in both places meets in the middle with no configuration.
//
// Unlike the console (whose control-plane API serves at the root), the dashboard
// worker already serves its routes UNDER `/api` — so this proxy keeps the path
// intact (no rewrite). The OIDC round-trip under `/api/auth/*` goes through the
// same proxy, so sign-in works against the local worker.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5275);
const API_PORT = Number(process.env.PORT ?? 8890);

// Build stamp, substituted into the bundle via `define` (see src/lib/version.ts). Version
// is this package's changeset-managed version; the SHA identifies the exact commit built.
// CI build envs (Cloudflare) expose the commit without a .git dir, so those come first;
// `git` is the local-dev fallback. Never throws — a build must not fail over a version banner.
function buildStamp() {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string };
  let sha = process.env.CF_PAGES_COMMIT_SHA ?? process.env.GITHUB_SHA ?? '';
  try {
    if (!sha) sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    /* no git in this build env — fall through to 'dev' */
  }
  return { version: pkg.version ?? '0.0.0', sha: sha ? sha.slice(0, 7) : 'dev' };
}
const STAMP = buildStamp();

export default defineConfig({
  // Assets are served by the worker from its own origin (app.substrat.net) at the
  // root, so keep the default base.
  build: { outDir: 'dist', emptyOutDir: true },
  define: {
    __APP_VERSION__: JSON.stringify(STAMP.version),
    __APP_SHA__: JSON.stringify(STAMP.sha),
  },
  plugins: [react()],
  server: {
    port: WEB_PORT,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
});
