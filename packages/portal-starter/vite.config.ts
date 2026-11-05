import { defineConfig } from 'vite';

const WEB_PORT = Number(process.env.WEB_PORT ?? 5291);
const API_PORT = Number(process.env.PORT ?? 8891);

export default defineConfig({
  server: {
    port: WEB_PORT,
    // `changeOrigin: false`, written out: the API builds its OIDC redirect_uri from the Host
    // it is handed, and the string shorthand rewrites Host.
    proxy: { '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false } },
  },
});
