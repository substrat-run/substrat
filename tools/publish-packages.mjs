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
 * Any other failure is not retried: nothing else here is known to be transient.
 *
 * Output is passed through unchanged, so the logs read as they did before this wrapper.
 */
import { spawn } from 'node:child_process';

const COMMAND = ['publish', '-r', '--access', 'public', '--no-git-checks'];
const TLOG_CONFLICT = 'TLOG_CREATE_ENTRY_ERROR';

/** Run the publish once; resolves to its exit code and whether it hit the log conflict. */
function publish() {
  return new Promise((done, fail) => {
    const child = spawn('pnpm', COMMAND, { stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    for (const [from, to] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      from.on('data', (chunk) => {
        to.write(chunk);
        output += chunk;
      });
    }
    child.on('error', fail);
    child.on('close', (code) => done({ code: code ?? 1, conflict: output.includes(TLOG_CONFLICT) }));
  });
}

let run = await publish();
if (run.code !== 0 && run.conflict) {
  console.error(`\n${TLOG_CONFLICT}: retrying \`pnpm ${COMMAND.join(' ')}\` once (see tools/publish-packages.mjs)\n`);
  run = await publish();
}
process.exit(run.code);
