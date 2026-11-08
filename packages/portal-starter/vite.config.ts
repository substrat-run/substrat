import { defineConfig } from 'vite';

const WEB_PORT = Number(process.env.WEB_PORT ?? 5291);
const API_PORT = Number(process.env.PORT ?? 8891);

export default defineConfig({
  server: {
    port: WEB_PORT,
    // `changeOrigin: false`, written out: the API builds its OIDC redirect_uri from the Host
    // it is handed, and the string shorthand rewrites Host.
    proxy: { '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false } },
    // The API keeps every scope's SQLite database in the project's `.data/`, which is inside the
    // root Vite serves files from, so without this `/@fs/<project>/.data/<scope>.sqlite` hands the
    // whole database to anyone who can reach this port, signed in or not. `deny` REPLACES Vite's
    // own list, so its defaults are written out first.
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '**/.data/**',
        '*.{sqlite,sqlite-shm,sqlite-wal}',
      ],
    },
  },
});
