import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A stand-in `wrangler` package, installed into a fixture vertical's `node_modules` where
 * `substrat push` resolves the project's own wrangler (push.ts `resolveWrangler`).
 *
 * Its bin is a plain Node script, so it runs the same on every OS — the shell-script `npx`
 * on PATH it replaces could not run on Windows at all. By default it "builds" by writing one
 * module into `--outdir`, which is all a push reads back. With `FAKE_WRANGLER_ARGV` set it
 * also records the argv, cwd and PATH it was started with, so a test can assert that a path holding
 * a space or a non-ASCII letter arrived as one argument, unchanged.
 */
export const FAKE_WRANGLER_VERSION = '0.0.0-fake';

const BUILDS = `
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (process.env.FAKE_WRANGLER_ARGV) {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
  writeFileSync(process.env.FAKE_WRANGLER_ARGV, JSON.stringify({ argv: args, cwd: process.cwd(), path: process.env[pathKey] }));
}
const out = args[args.indexOf('--outdir') + 1];
writeFileSync(join(out, 'worker.js'), 'export default {};\\n');
`;

/** A wrangler that fails at once, for a case that only needs to prove the build was reached. */
export const FAILING_WRANGLER = `console.error('stub wrangler'); process.exit(9);\n`;

export function installFakeWrangler(dir: string, bin: string = BUILDS): void {
  const pkg = join(dir, 'node_modules', 'wrangler');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'wrangler', version: FAKE_WRANGLER_VERSION, bin: { wrangler: './bin/wrangler.js' } }),
  );
  writeFileSync(join(pkg, 'bin', 'wrangler.js'), bin);
}
