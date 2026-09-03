import { request } from 'node:https';
import { BANKID_ROOT_CA, type BankIdConfig, type BankIdTransport } from './bankid.js';

/**
 * The Node half of the BankID seam: an HTTPS POST that presents the RP client certificate
 * from the stored config, trusting BankID's own root CA (their API servers do not use
 * publicly trusted certificates, so the default trust store refuses the handshake).
 *
 * `node:https` rather than `fetch`, because this is where the mTLS actually happens: Node's
 * global fetch (undici) takes no per-request client certificate, and a process-wide dispatcher
 * would leak the credential onto every other outbound call this server makes. Imported ONLY by
 * `src/server.ts` — harness code; the worker presents a Cloudflare mTLS-certificate binding
 * instead (`fetchBankIdTransport`).
 *
 * The operator pastes PEMs into the dashboard panel. The test certificate ships from BankID as
 * `FPTestcert5_20240610.p12` (passphrase `qwerty123`); PEM it with
 *
 *   openssl pkcs12 -in FPTestcert5_20240610.p12 -clcerts -nokeys -legacy -passin pass:qwerty123
 *   openssl pkcs12 -in FPTestcert5_20240610.p12 -nocerts -nodes -legacy -passin pass:qwerty123
 */
export function nodeBankIdTransport(
  cfg: Pick<BankIdConfig, 'environment' | 'clientCert' | 'clientKey' | 'caCert'>,
): BankIdTransport {
  return (url, body) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cert: cfg.clientCert,
          key: cfg.clientKey,
          ca: cfg.caCert ?? BANKID_ROOT_CA[cfg.environment],
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              parsed = undefined;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
}
