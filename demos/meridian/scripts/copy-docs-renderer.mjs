#!/usr/bin/env node
// Copy the pinned Scalar API-Reference bundle into the built SPA's asset directory.
//
// /api/docs must never load its renderer from a CDN (design/api-surface.md §2.3), so the
// renderer ships as one of the vertical's OWN static files. It is not part of the SPA's
// import graph — the docs page is HTML the worker returns, referencing
// /assets/scalar-api-reference.js — so Vite never sees it; this copies it in after the
// build, from the package's node_modules dir (its `exports` map does not expose dist/).
//
// This replaces the whole of the former gen-assets.mjs (#340): static files now ride
// Cloudflare's native asset upload path instead of being base64-inlined into the worker
// bundle, so the only thing left to do is put the file where the build output lives.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'node_modules', '@scalar', 'api-reference', 'dist', 'browser', 'standalone.js');
const outDir = join(here, '..', 'app', 'dist', 'assets');
const out = join(outDir, 'scalar-api-reference.js');

if (!existsSync(src)) {
  console.warn('copy-docs-renderer: @scalar/api-reference not installed — /api/docs will 404 its renderer');
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });
copyFileSync(src, out);
console.log('copy-docs-renderer: wrote app/dist/assets/scalar-api-reference.js');
