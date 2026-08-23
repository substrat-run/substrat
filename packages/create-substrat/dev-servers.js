/**
 * The dev servers a scaffolded vertical runs — declared once, client-neutrally.
 *
 * `.claude/launch.json` is a Claude Desktop **adapter**: it lets the agent start
 * the server, open it in the Browser pane, and verify its own changes. Under
 * design/agent-surface.md §3 an adapter may route, describe and trigger but may
 * never *hold* substance — so the topology lives here, in the `substrat` block of
 * package.json that `substrat push` and the SessionStart hook already read, and
 * the client file is emitted from it (`pnpm lint:launch`, guarded in CI).
 *
 * A port is deliberately NOT a field. `portEnv` + `portFrom` say *where* the port
 * is bound; the number is read out of that file. Otherwise the declaration becomes
 * a second copy of a number whose first copy is the one that actually runs, and
 * with `autoPort: false` a stale copy is a hard boot failure — for an agent, mid
 * session, which is the worst possible audience for it.
 *
 * @typedef {object} DevServer
 * @property {string}   name      Entry name. Mirrors the `-n` label of the `dev` script.
 * @property {string}   run       pnpm script to run. With `dir`, the script in that subdir.
 * @property {string}  [dir]      Subdirectory of the project (a Vite app), if any.
 * @property {string}   portEnv   The env var that moves this port (`PORT`, `WEB_PORT`, …).
 * @property {string}   portFrom  Project-relative file binding it: `process.env.<portEnv> ?? N`.
 * @property {Record<string,string>} [env] Env the `dev` script sets for this process.
 */

/**
 * Two processes: the local OIDC issuer, and the Hono API that relies on it. There is no
 * web app to scaffold yet.
 *
 * The issuer is a separate PROCESS rather than a branch inside the API on purpose — that
 * is what keeps the vertical free of any dev-only auth path, and lets it be swapped for a
 * real issuer by changing `OIDC_ISSUER` alone.
 */
export const DEV_SERVERS = [
  { name: 'issuer', run: 'issuer', portEnv: 'ISSUER_PORT', portFrom: 'src/server.ts' },
  { name: 'api', run: 'server', portEnv: 'PORT', portFrom: 'src/server.ts' },
];
