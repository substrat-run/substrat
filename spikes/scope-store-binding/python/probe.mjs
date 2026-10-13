/**
 * Starts the Python store with pywrangler and checks the envelope.
 * Run from spikes/scope-store-binding after `uv sync` in python/.
 * A failure here is recorded; it does not change what run.mjs already showed.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pythonDir = dirname(fileURLToPath(import.meta.url));
const port = 8793;
// A fresh name each run: wrangler keeps the object's SQLite, so a fixed
// name would increment a counter left by the previous run.
const name = `tenant-1/vertical-py/${randomUUID()}/GRAPH`;

function assert(condition, message, extra) {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    if (extra !== undefined) console.error(extra);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`PASS  ${message}`);
}

const child = spawn('uv', ['run', 'pywrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], {
  cwd: pythonDir,
  stdio: ['ignore', 'inherit', 'inherit'],
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ready() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`pywrangler exited ${child.exitCode} before it was ready`);
    try {
      // One request may sit there while the Python runtime starts. A short
      // abort never lets that first answer finish.
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(90_000) });
      if (response.status < 500) return;
      const text = await response.text();
      throw new Error(`pywrangler answered ${response.status}: ${text.slice(0, 1500)}`);
    } catch (err) {
      if (String(err.message).startsWith('pywrangler answered')) throw err;
      await sleep(300);
    }
  }
  throw new Error('pywrangler did not answer within 180s');
}

try {
  await ready();
  const increment = await fetch(
    `http://127.0.0.1:${port}/call?name=${encodeURIComponent(name)}&op=increment`,
  );
  const incrementBody = await increment.json();
  assert(increment.status === 200 && incrementBody.result?.count === 1, 'python store increments through the envelope', incrementBody);

  const read = await fetch(`http://127.0.0.1:${port}/call?name=${encodeURIComponent(name)}&op=read`);
  const readBody = await read.json();
  assert(read.status === 200 && readBody.result?.count === 1, 'python store reads the same object back', readBody);

  const other = await fetch(
    `http://127.0.0.1:${port}/call?name=${encodeURIComponent(name + '-other')}&op=read`,
  );
  const otherBody = await other.json();
  assert(other.status === 200 && otherBody.result?.count === 0, 'python store gives a second scope its own object', otherBody);

  const size = await fetch(`http://127.0.0.1:${port}/call?name=${encodeURIComponent(name)}&op=substrat.size`);
  const sizeBody = await size.json();
  assert(
    size.status === 200 && typeof sizeBody.result?.bytes === 'number' && sizeBody.result.bytes > 0,
    'python substrat.size reports databaseSize',
    sizeBody,
  );
  console.log('python probe passed');
} finally {
  await stop(child);
}

function stop(child) {
  if (child.exitCode !== null || !child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    child.kill();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('exit', () => resolve());
  });
}
