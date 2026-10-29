/** Runs as an unprivileged user inside a fresh build container; no platform credentials. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildRelease, readVerticalMeta } from '@substrat-run/cli/dist/push.js';
import { sourceBuildRequest } from '@substrat-run/contracts';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { root: string; slug: string; request: unknown };
const request = sourceBuildRequest.parse(input.request);
const dir = resolve(input.root);
const meta = readVerticalMeta(dir);
if (existsSync('/build/source/pnpm-workspace.yaml')) {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as { name: string };
  execFileSync('pnpm', ['--filter', `${pkg.name}^...`, '--if-present', 'run', 'build'], { cwd: '/build/source', stdio: 'inherit' });
}
const result = await buildRelease({
  ...meta, dir, slug: input.slug, version: request.version, name: request.name ?? meta.name,
  tenant: undefined, controlPlaneUrl: 'https://build.invalid', authHeader: {},
  allowUnservedUi: request.allowUnservedUi, allowUnsweptSchedules: request.allowUnsweptSchedules,
  requireDataLossCheck: request.requireDataLossCheck,
});
const parts = await Promise.all([...result.form.entries()].map(async ([name, value]) =>
  typeof value === 'string' ? { name, text: value } : {
    name, base64: Buffer.from(await value.arrayBuffer()).toString('base64'), type: value.type,
  }));
writeFileSync(process.argv[3]!, JSON.stringify({ parts, dataLoss: result.dataLoss }));
