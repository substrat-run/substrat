#!/usr/bin/env node
/**
 * The publish half of `pnpm release`: `pnpm publish -r`, run once more if the first run
 * failed on a transparency-log conflict, and only then.
 *
 * npm signs each package's provenance through sigstore, whose Rekor witness gives the
 * log 5 s to answer and retries the SAME signed entry on a timeout. When Rekor accepted
 * the first request but answered late, the retry draws `(409) an equivalent entry already
 * exists`, which the client reports as `TLOG_CREATE_ENTRY_ERROR` and npm treats as fatal
 * (`fetchOnConflict` is hard-coded off; no npm config reaches it). It fails before the
 * registry upload, so the package is not on npm, and `pnpm publish -r` stops there with
 * every later package unpublished — and the release job, and every prod deploy gated on
 * it, with it.
 *
 * A second run is a different entry rather than the same conflict: a new `npm publish`
 * gets a fresh Fulcio certificate over a fresh ephemeral key and signs again. And it
 * resumes rather than repeats, because `pnpm publish -r` skips a version npm already has.
 * Only that failure is retried: npm's own error line on stderr, from a run that exited
 * non-zero. A run killed by a signal, or one failing otherwise, is not — nothing else here
 * is known to be transient.
 *
 * stdout and stderr are each passed through as they arrive, so every line the logs showed
 * before this wrapper is still there, though the two streams may interleave differently.
 */
import { spawn } from 'node:child_process';
import { pnpmCommand, pnpmMissing } from './publish-manifests.mjs';

const COMMAND = ['publish', '-r', '--access', 'public', '--no-git-checks'];
const TLOG_CONFLICT = /^npm error code TLOG_CREATE_ENTRY_ERROR\r?$/m;

/** Run the publish once; resolves to its exit code and whether it failed on the log conflict. */
function publish() {
  const pnpm = pnpmCommand();
  return new Promise((done, fail) => {
    const child = spawn(pnpm.file, [...pnpm.args, ...COMMAND], { stdio: ['inherit', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      stderr += chunk;
    });
    child.on('error', (error) => fail(pnpmMissing(error)));
    child.on('close', (code) =>
      // `code` is null when a signal ended the run: never a conflict, and never a success.
      done({ code: code ?? 1, conflict: code !== null && code !== 0 && TLOG_CONFLICT.test(stderr) }),
    );
  });
}

let run = await publish();
if (run.conflict) {
  console.error(`\nTLOG_CREATE_ENTRY_ERROR: retrying \`pnpm ${COMMAND.join(' ')}\` once (see tools/publish-packages.mjs)\n`);
  run = await publish();
}
process.exitCode = run.code;
