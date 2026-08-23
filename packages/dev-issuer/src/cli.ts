#!/usr/bin/env node
/**
 * Run the dev issuer as its own process — the entrypoint a vertical's `dev` script starts
 * alongside its API and web servers.
 *
 *   tsx src/cli.ts --personas ../../demos/callout/src/personas.ts --port 8879
 *
 * `--personas` names a module exporting `PERSONAS: DevPersona[]`. Pointing it at the
 * vertical's own file is deliberate: the issuer's cast and the identity links the vertical
 * seeds are then the same array, and cannot drift.
 */
import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createDevIssuer } from './issuer.js';
import type { DevPersona } from './personas.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

const personasArg = arg('personas');
if (!personasArg) {
  console.error('substrat-dev-issuer: --personas <module exporting PERSONAS> is required');
  process.exit(1);
}

const modUrl = pathToFileURL(resolve(process.cwd(), personasArg)).href;
const mod = (await import(modUrl)) as { PERSONAS?: DevPersona[]; default?: DevPersona[] };
const personas = mod.PERSONAS ?? mod.default;
if (!Array.isArray(personas) || personas.length === 0) {
  console.error(`substrat-dev-issuer: ${personasArg} exports no non-empty PERSONAS array`);
  process.exit(1);
}

const port = Number(arg('port') ?? process.env.ISSUER_PORT ?? 8879);
serve({ fetch: createDevIssuer({ personas }).fetch, port });

console.log(
  [
    '',
    '  substrat · dev issuer — OIDC, no passwords',
    '  ' + '─'.repeat(52),
    `      issuer                http://localhost:${port}`,
    `      discovery             http://localhost:${port}/.well-known/openid-configuration`,
    '  ' + '─'.repeat(52),
    `    cast   ${personas.map((p) => p.sub).join(', ')}`,
    '    note   dev only — the signing key is checked in and public',
    '',
  ].join('\n'),
);
