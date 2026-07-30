import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in the private 887x/527x block the demos use, clear of the Vite
// and Wrangler defaults. API_PORT matches the control-plane API's dev server
// (packages/control-plane-api/dev/server.mts), so `pnpm dev` in both places
// meets in the middle with no configuration.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5272);
const API_PORT = Number(process.env.PORT ?? 8788);

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
  define: {
    __APP_VERSION__: JSON.stringify(STAMP.version),
    __APP_SHA__: JSON.stringify(STAMP.sha),
  },
  plugins: [react()],
  server: {
    port: WEB_PORT,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
