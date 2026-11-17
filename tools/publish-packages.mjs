#!/usr/bin/env node
/**
 * The publish half of `pnpm release`: the public packages in topological waves, each wave once
 * npm SERVES every workspace dependency it pins (#3260), and each run again if it failed on one
 * of the two failures a later run clears, and only then.
 *
 * Order alone is not enough. `pnpm publish -r` already went one package at a time in
 * topological order, and on 2026-11-16 `npx @substrat-run/cli@latest` still failed for a while:
 * npm had accepted `contracts@0.200.0` 52 s before the CLI, and served the CLI before it served
 * the `contracts` it requires. So before each wave, `tools/registry-wait.mjs` asks the registry
 * until each of the wave's workspace dependencies, at the version this checkout carries, is
 * listed by its packument and has a tarball answering 200. That wait is bounded: past it the
 * release fails naming each version npm did not serve, with the waves after it unpublished,
 * and "Re-run failed jobs" resumes from there like any other partial publish. A wave is still
 * `pnpm publish -r`, scoped with `--filter`, so pnpm keeps skipping what npm already has.
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
import { pnpmCommand, pnpmMembers, pnpmMissing } from './publish-manifests.mjs';
import { WAIT_MS, describeUnserved, needsBefore, publishWaves, waitUntilServed } from './registry-wait.mjs';

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

/** Run the publish of `wave` once; resolves to its exit code and which known failure stopped it, if one did. */
function publish(wave) {
  const pnpm = pnpmCommand();
  return new Promise((done, fail) => {
    const child = spawn(pnpm.file, [...pnpm.args, ...COMMAND, ...wave.flatMap((name) => ['--filter', name])], { stdio: ['inherit', 'inherit', 'pipe'] });
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

/**
 * Publish `members` wave by wave; resolves to an exit code. Before each wave, `waitFor` is
 * handed every workspace dependency the wave pins and resolves to those npm still does not
 * serve: any left over stop the release there, before the wave that needs them.
 */
export async function publishInWaves(members, { publishWave, waitFor, log = (line) => console.error(line) }) {
  const waves = publishWaves(members);
  for (const [i, wave] of waves.entries()) {
    const needs = needsBefore(wave, members);
    if (needs.length > 0) {
      log(`\nwave ${i + 1} of ${waves.length}: waiting until npm serves the ${needs.length} it depends on`);
      const missing = await waitFor(needs);
      if (missing.length > 0) {
        log(
          [
            `\nnpm did not serve ${missing.length} of them within the wait, so wave ${i + 1} of ${waves.length} and every wave after it are NOT published:`,
            ...describeUnserved(missing),
            'Publishing them now would let an install fetch a package whose dependency npm cannot hand out (#3260).',
            'Check those versions on npm; once they are served, "Re-run failed jobs" resumes the publish (see tools/publish-packages.mjs).',
          ].join('\n'),
        );
        return 1;
      }
    }
    log(`\nwave ${i + 1} of ${waves.length}: ${wave.join(', ')}`);
    const code = await publishWave(wave);
    if (code !== 0) return code;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await publishInWaves(pnpmMembers(), {
    publishWave: (wave) => publishUntilSettled(() => publish(wave)),
    waitFor: (needs) => waitUntilServed(needs, { timeoutMs: WAIT_MS }),
  });
}
