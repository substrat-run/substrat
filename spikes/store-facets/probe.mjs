// The probe sequence against the deployed spike (RUNBOOK.md step 5). Prints one block to paste
// back. Needs no Cloudflare credential: only the dispatcher's URL and the spike's token.
//
//   node probe.mjs --url https://<dispatcher>.workers.dev --token <token> [--graph] [--label <text>]
import { parseArgs } from 'node:util';
import { runProbes } from './probes.mjs';

const { values } = parseArgs({
  options: { url: { type: 'string' }, token: { type: 'string' }, graph: { type: 'boolean' }, label: { type: 'string' } },
});
if (!values.url || !values.token) {
  console.error('usage: node probe.mjs --url <dispatcher url> --token <token> [--graph] [--label <text>]');
  process.exit(2);
}

const request = async (path, params, body) => {
  const url = `${values.url.replace(/\/$/, '')}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    method: path === '/info' ? 'GET' : 'POST',
    headers: { 'x-spike-token': values.token },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, text: text.slice(0, 2000) };
  }
};

const result = await runProbes(request, { graph: Boolean(values.graph) });
console.log('\n==== PASTE BACK FROM HERE ====');
console.log(JSON.stringify({ where: values.label ?? 'deployed', at: new Date().toISOString(), ...result }, null, 2));
console.log('==== PASTE BACK TO HERE ====');
process.exitCode = result.failed ? 1 : 0;
