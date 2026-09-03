/**
 * The one-time service consent, run locally — the step between "I have a Developer
 * Portal integration" and "the live test can run".
 *
 * ## Why this exists
 *
 * Two of the three credential values are copy-paste from the Developer Portal. The
 * third, `tenantId`, is the company's `DatabaseNumber`, and it is not shown anywhere in
 * the portal: it comes back from `GET /3/companyinformation`, which needs an access
 * token, which needs a consent, which needs a browser round-trip. So without this
 * script the credential cannot be assembled at all — and that is a poor thing to
 * discover after a sandbox is finally provisioned.
 *
 * ## What it does, in order
 *
 * 1. Serves a callback on `--redirect-uri` (default `http://localhost:8899/callback`).
 * 2. Prints the consent URL — built by the connector's own {@link fortnoxConsentUrl},
 *    so `account_type=service` is set by the shipped code rather than by this script.
 * 3. Exchanges the returned code for an access token (`authorization_code`).
 * 4. Reads `GET /3/companyinformation` for `DatabaseNumber`.
 * 5. **Mints again with `client_credentials`** using that DatabaseNumber.
 * 6. Prints the three lines to paste into `connectors/fortnox/.dev.vars`.
 *
 * Step 5 is the point. It is the connector's whole premise — that a service consent can
 * be minted from static values with no refresh token — and this proves or disproves it
 * the moment consent completes, using {@link FortnoxApi} itself rather than a
 * reimplementation. If Fortnox refuses there, the connector's credential model is wrong
 * and everything downstream of it needs rethinking; better to learn that here than from
 * a test that silently skips.
 *
 * Read-only against Fortnox: it creates a consent (which is the intent) and otherwise
 * only reads. Harness code — `node:*` is fine here, and `scripts/` ships in no `dist`.
 *
 * Usage, from the repo root:
 *
 *   pnpm fortnox:connect --client-id=<id> --client-secret=<secret>
 *
 * `--redirect-uri` must EXACTLY match one registered in the Developer Portal. Whether
 * Fortnox accepts `http://` or `localhost` there is not documented. If it refuses, put a
 * tunnel in front: register the tunnel's https URL, pass it as `--redirect-uri`, and point
 * the tunnel at `http://localhost:<--listen-port>` (default 8899). This server speaks
 * plain HTTP either way — terminating TLS is the tunnel's job, not this script's.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { connectionId } from '@substrat-run/contracts';
import type { ConnectorConnection } from '@substrat-run/kernel';
import {
  FortnoxApi,
  FortnoxApiError,
  FORTNOX_OAUTH_BASE,
  fortnoxConsentUrl,
} from '../src/api.js';

const arg = (name: string, fallback?: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit?.slice(`--${name}=`.length) ?? process.env[name.toUpperCase().replace(/-/g, '_')] ?? fallback;
  if (value === undefined || value === '') {
    console.error(`fortnox:connect: missing --${name}=…`);
    process.exit(2);
  }
  return value;
};

const clientId = arg('client-id');
const clientSecret = arg('client-secret');
const redirectUri = arg('redirect-uri', 'http://localhost:8899/callback');
// `bookkeeping` is what the SIE export needs; `companyinformation` is what discovers the
// DatabaseNumber. Ask for more here than you need today if you might ever want it —
// scopes cannot be widened without a NEW consent round with every customer.
const scopes = arg('scopes', 'bookkeeping companyinformation').split(/[\s,]+/).filter(Boolean);

const parsedRedirect = new URL(redirectUri);
if (parsedRedirect.protocol !== 'http:' && parsedRedirect.protocol !== 'https:') {
  console.error(`fortnox:connect: --redirect-uri must be http:// or https://, got ${parsedRedirect.protocol}`);
  process.exit(2);
}

/**
 * The port this process LISTENS on, which is not always the redirect URI's port.
 *
 * The callback server below is `node:http` and speaks no TLS, so an `https://` redirect
 * URI is not something it can serve directly — that URI has to terminate somewhere else
 * (a tunnel, a proxy) and be forwarded here in plaintext. Deriving the listen port from
 * the URI would then be wrong twice over: it would bind 443 for a bare `https://` host
 * and it would still never complete a handshake.
 *
 * So they are separate inputs. An `http://` URI defaults the listen port to its own; an
 * `https://` one defaults to 8899 and expects a tunnel, and `--listen-port=` overrides
 * either. This is the fallback the docs promised and could not previously deliver.
 */
const defaultListenPort =
  parsedRedirect.protocol === 'http:' ? Number(parsedRedirect.port || '80') : 8899;
const listenPort = Number(arg('listen-port', String(defaultListenPort)));

/**
 * The CSRF binding for this consent round.
 *
 * 128 bits from the CSPRNG, not a timestamp: `state` is what proves a callback belongs
 * to the round this process started, and a predictable value lets anything that can
 * reach the callback hand this script a code it never asked for. The same standard the
 * connector already holds itself to for Scrive's callback token.
 */
const state = `substrat-${randomBytes(16).toString('hex')}`;

const consentUrl = fortnoxConsentUrl({ clientId, redirectUri, scopes, state });

console.log('\n1. Register this EXACT redirect URI in the Developer Portal:\n');
console.log(`   ${redirectUri}\n`);
console.log('2. Open this URL and approve, signed in as the sandbox company:\n');
console.log(`   ${consentUrl}\n`);
console.log(`   (scopes: ${scopes.join(', ')} — account_type=service)\n`);
if (parsedRedirect.protocol === 'https:') {
  console.log(
    `   NOTE: an https redirect URI cannot be served here — this callback speaks plain HTTP.\n` +
      `   Point a tunnel (cloudflared, ngrok) at http://localhost:${listenPort} so ${redirectUri}\n` +
      `   reaches it, or use the default http://localhost:8899/callback if the portal accepts it.\n`,
  );
}
console.log(`3. Waiting for the callback on port ${listenPort}…\n`);

/** Exchange the one-time code. The only place this flow is ever used. */
async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(`${FORTNOX_OAUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`code exchange failed (HTTP ${res.status}): ${body}`);
  const parsed = JSON.parse(body) as { access_token?: string };
  if (!parsed.access_token) throw new Error(`no access_token in response: ${body}`);
  return parsed.access_token;
}

/** A bare connection carrying a candidate secret — the same shape the probe builds. */
const connectionWith = (secret: Record<string, string>): ConnectorConnection => ({
  id: connectionId.parse('00000000000000000000000000'),
  tenantId: '',
  vertical: '',
  provider: 'fortnox',
  secret,
  expiresAt: null,
  fetch: (input, init) => fetch(input, init as RequestInit) as never,
});

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', redirectUri);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const returnedState = url.searchParams.get('state');

  const done = (message: string) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  };

  if (error) {
    done(`Fortnox refused: ${error}`);
    console.error(`\n✗ Fortnox refused the consent: ${error} ${url.searchParams.get('error_description') ?? ''}`);
    server.close();
    process.exit(1);
  }
  if (!code) return done('Waiting for a code…');
  // The state is ours and round-trips; a mismatch means this callback is not the one we
  // started, and continuing would exchange a code we did not ask for.
  if (returnedState !== state) {
    done('State mismatch — ignoring this callback.');
    console.error(`\n✗ state mismatch: expected ${state}, got ${returnedState ?? '(none)'}`);
    server.close();
    process.exit(1);
  }

  done('Consent received. You can close this tab and return to the terminal.');

  void (async () => {
    try {
      console.log('   ✓ code received, exchanging…');
      const token = await exchangeCode(code);

      // The DatabaseNumber, read the same way the connector reads it.
      const probeRes = await fetch('https://api.fortnox.se/3/companyinformation', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const probeBody = await probeRes.text();
      if (!probeRes.ok) throw new Error(`companyinformation failed (HTTP ${probeRes.status}): ${probeBody}`);
      const info = (JSON.parse(probeBody) as { CompanyInformation?: Record<string, unknown> })
        .CompanyInformation;
      const databaseNumber = info?.DatabaseNumber;
      const companyName = info?.CompanyName;
      if (databaseNumber === undefined) {
        throw new Error(`no DatabaseNumber in companyinformation: ${probeBody}`);
      }
      // A header value, never arithmetic — and `fortnoxSecret` wants a digit-only string.
      const tenantId = String(databaseNumber);
      console.log(`   ✓ company: ${String(companyName ?? '(unnamed)')} — DatabaseNumber ${tenantId}`);

      // THE claim. Everything about this connector's credential model rests on a service
      // consent being mintable from static values, with no refresh token in play.
      console.log('   → verifying grant_type=client_credentials …');
      const api = new FortnoxApi(connectionWith({ clientId, clientSecret, tenantId }));
      await api.accessToken();
      const years = await api.financialYears();
      console.log(`   ✓ client_credentials works — ${years.length} financial year(s) readable\n`);

      console.log('Paste into connectors/fortnox/.dev.vars (gitignored):\n');
      console.log(`FORTNOX_CLIENT_ID=${clientId}`);
      console.log(`FORTNOX_CLIENT_SECRET=${clientSecret}`);
      console.log(`FORTNOX_TENANT_ID=${tenantId}\n`);
      console.log('Then: pnpm --filter @substrat-run/connector-fortnox test\n');
      server.close();
      process.exit(0);
    } catch (err) {
      if (err instanceof FortnoxApiError) {
        console.error(`\n✗ ${err.message}`);
        console.error(`  status ${err.status}${err.refused ? ' (refused — the credential itself)' : ''}`);
        // The failure worth calling out by name, because it invalidates a design premise
        // rather than a config value.
        console.error(
          '\n  If this is the client_credentials step, the consent may not be a SERVICE consent.\n' +
            '  Check that account_type=service was on the authorize URL and that service accounts\n' +
            '  are enabled for this integration in the Developer Portal.',
        );
      } else {
        console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
      }
      server.close();
      process.exit(1);
    }
  })();
});

server.listen(listenPort);
