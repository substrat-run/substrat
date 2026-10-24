#!/usr/bin/env tsx
/**
 * The wire envelope's Ed25519 keys (RFC wire-signing §6, K-58): the store-keys commands over the
 * wire's two issuers. Runbook: secrets/wire-keys.md.
 *
 *   pnpm wire-keys generate --issuer router|platform --out <path outside the work tree>
 *   pnpm wire-keys generate --issuer router|platform --stdout [--yes-print-to-terminal]
 *   pnpm wire-keys doctor [--env prod|test|dev] [--file <env file>] [--key-file <path>]...
 *   pnpm wire-keys rotate --issuer router|platform [--env …] [--file …] [--key-file <path>]... [--drop <kid>]
 *
 * The router signs issuer `router` with WIRE_ROUTER_KEY and the control plane issuer `platform`
 * with WIRE_PLATFORM_KEY. A deployment holds only the public lists (WIRE_ROUTER_PUBLIC_KEYS,
 * WIRE_PLATFORM_PUBLIC_KEYS), each the key in use and a standby. Every judgement, and every rule
 * about where a private key may be written, is `tools/store-keys.mts`'s.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, WIRE_FAMILY } from './store-keys.mts';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }, WIRE_FAMILY);
}
