import { z } from 'zod';
import type { SqlExec } from './introspect.js';

/**
 * BankID (the Swedish e-ID) — the RP API v6.0 client, the animated-QR computation, and the
 * stored configuration.
 *
 * BankID is NOT an OAuth upstream, which is why it does not live in `src/providers.ts`: there
 * is no redirect, no callback and no client id. The relying party CALLS BankID's API over
 * mutually authenticated TLS — start an order, poll `collect` every two seconds, and read the
 * verified identity (personal number + name) out of the completed order. The user meanwhile
 * approves in the BankID app, reached either by scanning an animated QR code (other device) or
 * by an `autostarttoken` URL (same device). The flow endpoints live in `src/bankid-plugin.ts`;
 * this module is everything under them that has no runtime in it.
 *
 * The mTLS client certificate is the one genuinely runtime-specific piece, so the HTTP call is
 * an injected `BankIdTransport`: the Node dev server presents the PEMs from the stored config
 * (`src/bankid-transport-node.ts`), and the worker presents a Cloudflare mTLS-certificate
 * binding's `fetch` when one is bound. Everything above the transport — request shapes,
 * response parsing, the QR HMAC — is identical in both runtimes and unit-testable with a fake.
 *
 * Configuration is ONE JSON row in the issuer's `config` table (key `bankid`), the same home
 * as the `instance` metadata: BankID is a singleton national scheme, not a growing list, so a
 * row per provider would be shape without meaning. `config.value` is redacted wholesale by the
 * introspection surface (`introspect.ts`), which is exactly what a stored private key needs,
 * and the full dump carries it deliberately, as it carries every credential a rebuild needs.
 */

/* ---- environments ---- */

export type BankIdEnvironment = 'test' | 'production';

/** RP API v6.0 — every older version was discontinued in 2024. */
const API_URLS: Record<BankIdEnvironment, string> = {
  test: 'https://appapi2.test.bankid.com/rp/v6.0',
  production: 'https://appapi2.bankid.com/rp/v6.0',
};

export function bankIdApiUrl(environment: BankIdEnvironment): string {
  return API_URLS[environment];
}

/**
 * BankID's API servers present certificates issued by BankID's OWN root CAs, not publicly
 * trusted ones — a default trust store refuses the handshake outright. These are the published
 * roots (both valid until 2034-12-31; the live test chain is issued directly under the test
 * root, verified 2026-09-03), embedded so the Node transport can pin them. The stored config
 * can override with `caCert` should BankID ever rotate them.
 */
export const BANKID_ROOT_CA: Record<BankIdEnvironment, string> = {
  test: `-----BEGIN CERTIFICATE-----
MIIF0DCCA7igAwIBAgIIIhYaxu4khgAwDQYJKoZIhvcNAQENBQAwbDEkMCIGA1UE
CgwbRmluYW5zaWVsbCBJRC1UZWtuaWsgQklEIEFCMRowGAYDVQQLDBFJbmZyYXN0
cnVjdHVyZSBDQTEoMCYGA1UEAwwfVGVzdCBCYW5rSUQgU1NMIFJvb3QgQ0EgdjEg
VGVzdDAeFw0xNDExMjExMjM5MzFaFw0zNDEyMzExMjM5MzFaMGwxJDAiBgNVBAoM
G0ZpbmFuc2llbGwgSUQtVGVrbmlrIEJJRCBBQjEaMBgGA1UECwwRSW5mcmFzdHJ1
Y3R1cmUgQ0ExKDAmBgNVBAMMH1Rlc3QgQmFua0lEIFNTTCBSb290IENBIHYxIFRl
c3QwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCAKWsJc/kV/0434d+S
qn19mIr85RZ/PgRFaUplSrnhuzAmaXihPLCEsd3Mh/YErygcxhQ/MAzi5OZ/anfu
WSCwceRlQINtvlRPdMoeZtu29FsntK1Z5r2SYNdFwbRFb8WN9FsU0KvC5zVnuDMg
s5dUZwTmdzX5ZdLP7pdgB3zhTnra5ORtkiWiUxJVev9keRgAo00ZHIRJ+xTfiSPd
Jc314maigVRQZdGKSyQcQMTWi1YLwd2zwOacNxleYf8xqKgkZsmkrc4Dp2mR5Pkr
nnKB6A7sAOSNatua7M86EgcGi9AaEyaRMkYJImbBfzaNlaBPyMSvwmBZzp2xKc9O
D3U06ogV6CJjJL7hSuVc5x/2H04d+2I+DKwep6YBoVL9L81gRYRycqg+w+cTZ1TF
/s6NC5YRKSeOCrLw3ombhjyyuPl8T/h9cpXt6m3y2xIVLYVzeDhaql3hdi6IpRh6
rwkMhJ/XmOpbDinXb1fWdFOyQwqsXQWOEwKBYIkM6cPnuid7qwaxfP22hDgAolGM
LY7TPKUPRwV+a5Y3VPl7h0YSK7lDyckTJdtBqI6d4PWQLnHakUgRQy69nZhGRtUt
PMSJ7I4Qtt3B6AwDq+SJTggwtJQHeid0jPki6pouenhPQ6dZT532x16XD+WIcD2f
//XzzOueS29KB7lt/wH5K6EuxwIDAQABo3YwdDAdBgNVHQ4EFgQUDY6XJ/FIRFX3
dB4Wep3RVM84RXowDwYDVR0TAQH/BAUwAwEB/zAfBgNVHSMEGDAWgBQNjpcn8UhE
Vfd0HhZ6ndFUzzhFejARBgNVHSAECjAIMAYGBCoDBAUwDgYDVR0PAQH/BAQDAgEG
MA0GCSqGSIb3DQEBDQUAA4ICAQA5s59/Olio4svHXiKu7sPQRvrf4GfGB7hUjBGk
YW2YOHTYnHavSqlBASHc8gGGwuc7v7+H+vmOfSLZfGDqxnBqeJx1H5E0YqEXtNqW
G1JusIFa9xWypcONjg9v7IMnxxQzLYws4YwgPychpMzWY6B5hZsjUyKgB+1igxnf
uaBueLPw3ZaJhcCL8gz6SdCKmQpX4VaAadS0vdMrBOmd826H+aDGZek1vMjuH11F
fJoXY2jyDnlol7Z4BfHc011toWNMxojI7w+U4KKCbSxpWFVYITZ8WlYHcj+b2A1+
dFQZFzQN+Y1Wx3VIUqSks6P7F5aF/l4RBngy08zkP7iLA/C7rm61xWxTmpj3p6SG
fUBsrsBvBgfJQHD/Mx8U3iQCa0Vj1XPogE/PXQQq2vyWiAP662hD6og1/om3l1PJ
TBUyYXxqJO75ux8IWblUwAjsmTlF/Pcj8QbcMPXLMTgNQAgarV6guchjivYqb6Zr
hq+Nh3JrF0HYQuMgExQ6VX8T56saOEtmlp6LSQi4HvKatCNfWUJGoYeT5SrcJ6sn
By7XLMhQUCOXcBwKbNvX6aP79VA3yeJHZO7XParX7V9BB+jtf4tz/usmAT/+qXtH
CCv9Xf4lv8jgdOnFfXbXuT8I4gz8uq8ElBlpbJntO6p/NY5a08E6C7FWVR+WJ5vZ
OP2HsA==
-----END CERTIFICATE-----
`,
  production: `-----BEGIN CERTIFICATE-----
MIIFvjCCA6agAwIBAgIITyTh/u1bExowDQYJKoZIhvcNAQENBQAwYjEkMCIGA1UE
CgwbRmluYW5zaWVsbCBJRC1UZWtuaWsgQklEIEFCMRowGAYDVQQLDBFJbmZyYXN0
cnVjdHVyZSBDQTEeMBwGA1UEAwwVQmFua0lEIFNTTCBSb290IENBIHYxMB4XDTEx
MTIwNzEyMzQwN1oXDTM0MTIzMTEyMzQwN1owYjEkMCIGA1UECgwbRmluYW5zaWVs
bCBJRC1UZWtuaWsgQklEIEFCMRowGAYDVQQLDBFJbmZyYXN0cnVjdHVyZSBDQTEe
MBwGA1UEAwwVQmFua0lEIFNTTCBSb290IENBIHYxMIICIjANBgkqhkiG9w0BAQEF
AAOCAg8AMIICCgKCAgEAwVA4snZiSFI3r64LvYu4mOsI42A9aLKEQGq4IZo257iq
vPH82SMvgBJgE52kCx7gQMmZ7iSm39CEA19hlILh8JEJNTyJNxMxVDN6cfJP1jMH
JeTES1TmVbWUqGyLpyT8LCJhC9Vq4W3t/O1svGJNOUQIQL4eAHSvWTVoalxzomJh
On97ENjXAt4BLb6sHfVBvmB5ReK0UfwpNACFM1RN8btEaDdWC4PfA72yzV3wK/cY
5h2k1RM1s19PjoxnpJqrmn4qZmP4tN/nk2d7c4FErJAP0pnNsll1+JfkdMfiPD35
+qcclpspzP2LpauQVyPbO21Nh+EPtr7+Iic2tkgz0g1kK0IL/foFrJ0Ievyr3Drm
2uRnA0esZ45GOmZhE22mycEX9l7w9jrdsKtqs7N/T46hil4xBiGblXkqKNG6TvAR
k6XqOp3RtUvGGaKZnGllsgTvP38/nrSMlszNojrlbDnm16GGoRTQnwr8l+Yvbz/e
v/e6wVFDjb52ZB0Z/KTfjXOl5cAJ7OCbODMWf8Na56OTlIkrk5NyU/uGzJFUQSvG
dLHUipJ/sTZCbqNSZUwboI0oQNO/Ygez2J6zgWXGpDWiN4LGLDmBhB3T8CMQu9J/
BcFvgjnUyhyim35kDpjVPC8nrSir5OkaYgGdYWdDuv1456lFNPNNQcdZdt5fcmMC
AwEAAaN4MHYwHQYDVR0OBBYEFPgqsux5RtcrIhAVeuLBSgBuRDFVMA8GA1UdEwEB
/wQFMAMBAf8wHwYDVR0jBBgwFoAU+Cqy7HlG1ysiEBV64sFKAG5EMVUwEwYDVR0g
BAwwCjAIBgYqhXBOAQQwDgYDVR0PAQH/BAQDAgEGMA0GCSqGSIb3DQEBDQUAA4IC
AQAJOjUOS2GJPNrrrqf539aN1/EbUj5ZVRjG4wzVtX5yVqPGcRZjUQlNTcfOpwPo
czKBnNX2OMF+Qm94bb+xXc/08AERqJJ3FPKu8oDNeK+Rv1X4nh95J4RHZcvl4AGh
ECmGMyhyCea0qZBFBsBqQR7oC9afYOxsSovaPqX31QMLULWUYoBKWWHLVVIoHjAm
GtAzMkLwe0/lrVyApr9iyXWhVr+qYGmFGw1+rwmvDmmSLWNWawYgH4NYxTf8z5hB
iDOdAgilvyiAF8Yl0kCKUB2fAPhRNYlEcN+UP/KL24h/pB+hZ9mvR0tM6nW3HVZa
DrvRz4VihZ8vRi3fYnOAkNE6kZdrrdO7LdBc9yYkfQdTcy0N+Aw7q4TkQ8npomrV
mTKaPhtGhA7VICyRNBVcvyoxr+CY7aRQyHn/C7n/jRsQYxs7uc+msq6jRS4HPK8o
lnF9usWZX6KY+8mweJiTE4uN4ZUUBUtt8WcXXDiK/bxEG2amjPcZ/b4LXwGCJb+a
NWP4+iY6kBKrMANs01pLvtVjUS9RtRrY3cNEOhmKhO0qJSDXhsTcVtpbDr37UTSq
QVw83dReiARPwGdURmmkaheH6z4k6qEUSXuFch0w53UAc+1aBXR1bgyFqMdy7Yxi
b2AYu7wnrHioDWqP6DTkUSUeMB/zqWPM/qx6QNNOcaOcjA==
-----END CERTIFICATE-----
`,
};

/* ---- the stored configuration ---- */

const CONFIG_KEY = 'bankid';

const storedConfig = z.object({
  environment: z.enum(['test', 'production']),
  /** PEM: the RP client certificate (with any intermediates). */
  clientCert: z.string().min(1),
  /** PEM: the certificate's private key. Never leaves this module unredacted. */
  clientKey: z.string().min(1),
  /** PEM override for the server trust anchor; absent ⇒ the embedded root above. */
  caCert: z.string().optional(),
  allowSignup: z.boolean(),
  disabled: z.boolean(),
  updatedAt: z.number(),
});

export type BankIdConfig = z.infer<typeof storedConfig>;

export function readBankIdConfig(sql: SqlExec): BankIdConfig | undefined {
  const row = sql.exec('SELECT value FROM config WHERE key = ?', CONFIG_KEY).toArray()[0] as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  const parsed = storedConfig.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : undefined;
}

/** What an admin may set. Cert and key are optional on an edit: absent means "keep stored". */
export interface BankIdInput {
  environment: BankIdEnvironment;
  clientCert?: string;
  clientKey?: string;
  caCert?: string | null;
  allowSignup: boolean;
  disabled: boolean;
}

export function putBankIdConfig(sql: SqlExec, input: BankIdInput, existing?: BankIdConfig): BankIdConfig {
  const clientCert = input.clientCert ?? existing?.clientCert;
  const clientKey = input.clientKey ?? existing?.clientKey;
  if (!clientCert || !clientKey) throw new Error('a client certificate and key are required');
  const next: BankIdConfig = {
    environment: input.environment,
    clientCert,
    clientKey,
    // `null` clears an override; `undefined` keeps whatever is stored.
    ...(input.caCert === null ? {} : (input.caCert ?? existing?.caCert) ? { caCert: input.caCert ?? existing?.caCert } : {}),
    allowSignup: input.allowSignup,
    disabled: input.disabled,
    updatedAt: Date.now(),
  };
  sql.exec('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', CONFIG_KEY, JSON.stringify(next));
  return next;
}

export function deleteBankIdConfig(sql: SqlExec): void {
  sql.exec('DELETE FROM config WHERE key = ?', CONFIG_KEY);
}

/** The panel's view. The key material is never here — only that it exists. */
export function toWireBankId(cfg: BankIdConfig) {
  return {
    environment: cfg.environment,
    certSet: true,
    caSet: Boolean(cfg.caCert),
    allowSignup: cfg.allowSignup,
    disabled: cfg.disabled,
    updatedAt: cfg.updatedAt,
  };
}

/**
 * The signed-out login screen's view, shaped like the OAuth providers' entries so the wire
 * format stays one list. `transportAvailable` is the runtime's word that it can actually
 * present the client certificate (Node always can; the worker only with an mTLS binding) —
 * a button that starts a flow the runtime cannot finish must not be drawn.
 */
export function publicBankIdFrom(
  cfg: BankIdConfig | undefined,
  transportAvailable: boolean,
): { id: string; label: string } | undefined {
  if (!cfg || cfg.disabled || !transportAvailable) return undefined;
  return { id: 'bankid', label: 'BankID' };
}

/* ---- the RP API v6.0 client ---- */

/**
 * One HTTPS POST to the RP API, with the client certificate presented — the runtime-specific
 * seam. `url` is absolute; `body` is the JSON payload. Must resolve (never throw) on any HTTP
 * status, and throw only when the request could not be made at all.
 */
export type BankIdTransport = (url: string, body: unknown) => Promise<{ status: number; body: unknown }>;

/**
 * How long a transport waits before giving up. The SPA polls `collect` every two seconds and
 * a person is standing at the screen, so a stalled connection has to become an error someone
 * sees — an unbounded await leaves the sign-in spinner honest-looking and dead. Both shipped
 * transports apply this; a custom one should too.
 */
export const BANKID_TIMEOUT_MS = 15_000;

const orderResponse = z.object({
  orderRef: z.string(),
  autoStartToken: z.string(),
  qrStartToken: z.string(),
  qrStartSecret: z.string(),
});
export type BankIdOrder = z.infer<typeof orderResponse>;

const collectResponse = z.object({
  orderRef: z.string(),
  status: z.enum(['pending', 'complete', 'failed']),
  hintCode: z.string().optional(),
  completionData: z
    .object({
      user: z.object({
        personalNumber: z.string(),
        name: z.string(),
        givenName: z.string(),
        surname: z.string(),
      }),
    })
    .loose()
    .optional(),
});
export type BankIdCollect = z.infer<typeof collectResponse>;

const apiError = z.object({ errorCode: z.string(), details: z.string().optional() });

/** A refusal from BankID's API, carrying its own error code (`alreadyInProgress`, …). */
export class BankIdApiError extends Error {
  constructor(
    readonly errorCode: string,
    details?: string,
  ) {
    super(`BankID refused the request: ${errorCode}${details ? ` (${details})` : ''}`);
  }
}

async function rpCall<T>(
  transport: BankIdTransport,
  url: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const res = await transport(url, body);
  if (res.status !== 200) {
    const parsed = apiError.safeParse(res.body);
    if (parsed.success) throw new BankIdApiError(parsed.data.errorCode, parsed.data.details);
    throw new Error(`BankID answered ${res.status}`);
  }
  return schema.parse(res.body);
}

/**
 * Start an authentication order. `endUserIp` is REQUIRED by the API and must be the end
 * user's address as this issuer sees it — it is part of BankID's fraud detection, not ours.
 */
export function startOrder(
  transport: BankIdTransport,
  apiUrl: string,
  input: { endUserIp: string },
): Promise<BankIdOrder> {
  return rpCall(transport, `${apiUrl}/auth`, { endUserIp: input.endUserIp }, orderResponse);
}

/** Poll an order. The API's guidance: every two seconds, and not more often. */
export function collectOrder(transport: BankIdTransport, apiUrl: string, orderRef: string): Promise<BankIdCollect> {
  return rpCall(transport, `${apiUrl}/collect`, { orderRef }, collectResponse);
}

/** Cancel an order the user walked away from. A 200 with an empty body on success. */
export async function cancelOrder(transport: BankIdTransport, apiUrl: string, orderRef: string): Promise<void> {
  await transport(`${apiUrl}/cancel`, { orderRef });
}

/** A transport over any `fetch`-shaped function that already presents the client certificate
 *  (Cloudflare's mTLS-certificate binding, in the worker). */
export function fetchBankIdTransport(
  fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ) => Promise<{
    status: number;
    json(): Promise<unknown>;
  }>,
): BankIdTransport {
  return async (url, body) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BANKID_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
}

/* ---- the animated QR code ---- */

/**
 * The v6 "animated" QR: a new frame each second, computed by the RP — never by the client,
 * which is the point (a QR the page could compute forever would be phishable long after the
 * order died). Frame `t` seconds after the order was created is
 *
 *   bankid.{qrStartToken}.{t}.{hmacsha256(qrStartSecret, String(t)) as lowercase hex}
 *
 * pinned by BankID's own documented example in `test/bankid.test.ts`. Web Crypto, so the same
 * code runs in the Durable Object, Node and tests.
 */
export async function animatedQr(qrStartToken: string, qrStartSecret: string, seconds: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(qrStartSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(String(seconds))));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  return `bankid.${qrStartToken}.${seconds}.${hex}`;
}

/**
 * The same-device start URL. `redirect=null` tells the app to return to the calling app
 * without a forced navigation — the SPA is still polling `collect` and picks the session up
 * itself, which works the same on desktop and mobile.
 */
export function autoStartUrl(autoStartToken: string): string {
  return `bankid:///?autostarttoken=${autoStartToken}&redirect=null`;
}
