import { createServer } from 'node:http';
import { webcrypto } from 'node:crypto';
import { spawn } from 'node:child_process';

/**
 * The loopback browser-login flow (`substrat login`). PKCE against the control plane's
 * CLI broker (apps/control-plane/src/cli-auth.ts) — which brokers AuthHero, so the CLI
 * never touches the IdP directly:
 *
 *   1. generate a PKCE verifier + challenge + state; start a localhost server
 *   2. open the browser to {cp}/auth/cli?port&state&challenge
 *   3. the broker signs the user in (AuthHero) and redirects to 127.0.0.1:PORT/callback?code&state
 *   4. exchange {code, verifier} at {cp}/auth/cli/token → the session token
 *
 * The token never transits a URL — only the PKCE-bound `code` does — and the loopback
 * server accepts exactly one callback on the ephemeral port, then closes.
 */

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomB64url = (n = 32): string => b64url(webcrypto.getRandomValues(new Uint8Array(n)));
async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await webcrypto.subtle.digest('SHA-256', enc.encode(verifier))));
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

/** Start a one-shot loopback server; resolves with the `code` from a state-matching callback. */
function awaitCallback(expectedState: string): Promise<{ port: number; code: Promise<string> }> {
  return new Promise((resolvePort) => {
    let resolveCode!: (c: string) => void;
    let rejectCode!: (e: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const html = (title: string, msg: string): void => {
        res.writeHead(url.searchParams.get('code') ? 200 : 400, { 'content-type': 'text/html' });
        res.end(`<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;text-align:center"><h1>${title}</h1><p>${msg}</p></body>`);
      };
      const got = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!got || state !== expectedState) {
        html('Login failed', 'State mismatch — you can close this tab and try again.');
        rejectCode(new Error('loopback callback state mismatch'));
      } else {
        html('Signed in to the substrat CLI', 'You can close this tab and return to your terminal.');
        resolveCode(got);
      }
      server.close();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolvePort({ port, code });
    });
    const timer = setTimeout(() => {
      rejectCode(new Error('login timed out — no browser callback within 5 minutes'));
      server.close();
    }, 5 * 60 * 1000);
    void code.finally(() => clearTimeout(timer));
  });
}

/**
 * Run the full loopback login against `controlPlaneUrl`; returns a session token to store.
 * `fresh` forces a real re-authentication (`substrat login --fresh`): the broker skips any
 * live browser session AND the IdP re-prompts past its SSO cookie — without it, a browser
 * signed in as the wrong account silently wins and no typed email can change the outcome.
 */
export async function browserLogin(controlPlaneUrl: string, opts: { fresh?: boolean } = {}): Promise<string> {
  const cp = controlPlaneUrl.replace(/\/$/, '');
  const verifier = randomB64url(32);
  const challenge = await s256(verifier);
  const state = randomB64url(16);

  const { port, code } = await awaitCallback(state);
  const authUrl = `${cp}/auth/cli?port=${port}&state=${encodeURIComponent(state)}&challenge=${encodeURIComponent(challenge)}${opts.fresh ? '&fresh=1' : ''}`;
  console.log('opening your browser to sign in…');
  console.log(`  if it doesn't open, visit:\n  ${authUrl}\n`);
  openBrowser(authUrl);

  const codeValue = await code;
  const res = await fetch(`${cp}/auth/cli/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codeValue, verifier }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const { token } = (await res.json()) as { token?: string };
  if (!token) throw new Error('token exchange returned no token');
  return token;
}
