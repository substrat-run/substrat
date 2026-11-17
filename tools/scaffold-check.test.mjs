import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutMembers } from './registry-wait.mjs';

// The real script, end to end, against a local registry that serves every version this checkout
// names (packument + tarball HEAD) and then refuses the tarball itself. The wait passes and the
// published scaffolder fails to install, so the run reaches `main`'s own failure report: what a
// script that died before it (a missing helper, #3263's review) never prints.
// About 2 s locally, over the 1 s budget, because it starts the real script and npm; a mocked
// entry would not prove the script reaches `main`. The timeout is well over 3× that.
test('the registry run waits for every version, then reaches the scaffold step', { timeout: 30_000 }, async () => {
  const members = checkoutMembers();
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.slice(1));
    if (path.endsWith('.tgz')) {
      res.writeHead(req.method === 'HEAD' ? 200 : 404).end();
      return;
    }
    const member = members.get(path);
    if (!member) return res.writeHead(404).end();
    const tarball = `http://127.0.0.1:${server.address().port}/${path}/-/x-${member.version}.tgz`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: path, 'dist-tags': { latest: member.version }, versions: { [member.version]: { name: path, version: member.version, dist: { tarball } } } }));
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const cache = mkdtempSync(join(tmpdir(), 'scaffold-check-test-'));
  try {
    const env = { ...process.env, npm_config_registry: `http://127.0.0.1:${server.address().port}/`, npm_config_cache: cache, npm_config_fetch_retries: '0' };
    delete env.GITHUB_STEP_SUMMARY;
    const { code, output } = await new Promise((done) => {
      const child = spawn(process.execPath, ['tools/scaffold-check.mjs', '--from=registry'], { env });
      let output = '';
      child.stdout.on('data', (c) => (output += c));
      child.stderr.on('data', (c) => (output += c));
      child.on('close', (code) => done({ code, output }));
    });
    assert.equal(code, 1, output);
    assert.match(output, /Waiting until npm serves the \d+ versions the scaffold installs/);
    assert.match(output, /FAIL {2}the published scaffolder exited/);
    assert.doesNotMatch(output, /threw|ReferenceError/);
  } finally {
    server.close();
    rmSync(cache, { recursive: true, force: true });
  }
});
