#!/usr/bin/env node
/**
 * The publish half of `pnpm release`: `pnpm publish -r`, run again if it failed on one of the
 * two failures a later run clears, and only then.
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
 *
 * The other is npm's lag in listing a version it has taken. A release run that starts inside
 * that gap reads the version as unpublished and uploads it again, which npm refuses with
 * `409 Conflict … Cannot publish over previously staged version`. Nothing is wrong with the
 * version, and `pnpm publish -r` skips it once it is listed, so the run waits and asks again.
 * On 2026-11-07 a version took 4 minutes 7 seconds to be listed, and the waits cover that.
 *
 * Only those two failures are retried: npm's own error lines on stderr, from a run that exited
 * non-zero. A run killed by a signal, or one failing otherwise, is not — nothing else here
 * is known to be transient.
 *
 * stdout and stderr are each passed through as they arrive, so every line the logs showed
 * before this wrapper is still there, though the two streams may interleave differently.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { pnpmCommand, pnpmMissing } from './publish-manifests.mjs';

const COMMAND = ['publish', '-r', '--access', 'public', '--no-git-checks'];
const TLOG_CONFLICT = /^npm error code TLOG_CREATE_ENTRY_ERROR\r?$/m;
const STAGED_VERSION = /^npm error 409 Conflict .*Cannot publish over previously staged version/m;
const STAGED_WAIT_MS = 60_000;
const STAGED_WAITS = 6;

/** Which failure a later run clears, read off a failed run's stderr; null for any other. */
export function failureOf(stderr) {
  if (TLOG_CONFLICT.test(stderr)) return 'conflict';
  return STAGED_VERSION.test(stderr) ? 'staged' : null;
}

/** Run the publish once; resolves to its exit code and which known failure stopped it, if one did. */
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
      // `code` is null when a signal ended the run: never a known failure, and never a success.
      done({ code: code ?? 1, failure: code !== null && code !== 0 ? failureOf(stderr) : null }),
    );
  });
}

/** Publish until a run passes or stops on something a later run does not clear; resolves to its exit code. */
export async function publishUntilSettled(run, { wait = sleep, waitMs = STAGED_WAIT_MS, waits = STAGED_WAITS } = {}) {
  let conflicts = 0;
  let staged = 0;
  for (;;) {
    const { code, failure } = await run();
    if (failure === 'conflict' && conflicts === 0) {
      conflicts += 1;
      console.error(`\nTLOG_CREATE_ENTRY_ERROR: retrying \`pnpm ${COMMAND.join(' ')}\` once (see tools/publish-packages.mjs)\n`);
    } else if (failure === 'staged' && staged < waits) {
      staged += 1;
      console.error(`\nnpm has not listed a version it took: waiting ${waitMs / 1000} s, then \`pnpm ${COMMAND.join(' ')}\` again (${staged} of ${waits}, see tools/publish-packages.mjs)\n`);
      await wait(waitMs);
    } else {
      return code;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await publishUntilSettled(publish);
}
