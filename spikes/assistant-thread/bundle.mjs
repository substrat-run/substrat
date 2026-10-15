/**
 * What the element costs to ship. Bundles three things with esbuild, minified, and reports
 * raw / gzip / brotli: Lit alone (the floor), the headless client alone (what a native
 * chat would import), and the spike element with the client.
 *
 * The spike element is deliberately small. The shipped one adds markdown, the approval
 * preview, branches, the memory view and the renderer registry, so treat the third number
 * as the floor for the real one, not a forecast.
 */
import { build } from 'esbuild';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(root, '.out'), { recursive: true });

async function size(label, entry, extra = {}) {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    ...extra,
  });
  const code = out.outputFiles[0].contents;
  const row = { label, raw: code.length, gzip: gzipSync(code).length, brotli: brotliCompressSync(code).length };
  writeFileSync(join(root, '.out', `${label.replace(/\W+/g, '-')}.js`), code);
  return row;
}

const lit = join(root, '.out', 'lit-only.entry.mjs');
writeFileSync(lit, `import { LitElement, html } from 'lit'; export { LitElement, html };`);

const rows = [
  await size('Lit alone', lit),
  await size('Headless client alone', join(root, 'src', 'assistant-client.mjs')),
  await size('Spike element + client + Lit', join(root, 'src', 'element.mjs')),
];
const kb = (n) => (n / 1024).toFixed(1).padStart(6);
console.log('label'.padEnd(32), 'raw KB'.padStart(8), 'gzip KB'.padStart(8), 'brotli KB'.padStart(10));
for (const r of rows) console.log(r.label.padEnd(32), kb(r.raw), kb(r.gzip), kb(r.brotli));
writeFileSync(join(root, 'bundle.json'), JSON.stringify(rows, null, 2));
