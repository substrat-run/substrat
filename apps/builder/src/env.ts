/**
 * Local credential loading for the studio's terminal driver.
 *
 * The builder is a Node process in mode A (§3.1), not a Worker, so it does not go
 * through `scripts/secrets.mjs` / `wrangler secret` — that path is for deployed
 * workers and applies when the studio Worker lands. Here the provider key lives
 * in a `.env` covered by the recursive rule at .gitignore:25, and is read into
 * the process that talks to the provider.
 *
 * It is deliberately NOT forwarded into the workspace: `LocalWorkspace` builds a
 * minimal env for `exec` rather than inheriting `process.env`, so the agent's
 * shell never sees the key (§5.3). That property is why the model can run against
 * an untrusted workspace at all.
 *
 * Uses Node's built-in env-file parser — no dependency.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/builder`, derived from this file rather than from cwd. */
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Loaded in order, first value winning — a real environment variable always beats
 * a file, so CI and one-off overrides work without editing anything.
 */
export function envFileCandidates(repoRoot?: string): string[] {
	const files = [join(appDir, '.env')];
	if (repoRoot) files.push(join(resolve(repoRoot), '.env'));
	// The two coincide when --root points at apps/builder; loading twice is
	// harmless but reporting it twice looks like a bug.
	return [...new Set(files)];
}

export interface EnvLoadResult {
	readonly loaded: readonly string[];
	readonly skipped: readonly string[];
}

/**
 * Loads any `.env` that exists. Missing files are not an error: a developer who
 * exports `ANTHROPIC_API_KEY` in their shell should never be told to create a file.
 */
export function loadEnvFiles(repoRoot?: string): EnvLoadResult {
	const loaded: string[] = [];
	const skipped: string[] = [];
	for (const file of envFileCandidates(repoRoot)) {
		if (!existsSync(file)) {
			skipped.push(file);
			continue;
		}
		try {
			process.loadEnvFile(file);
			loaded.push(file);
		} catch {
			skipped.push(file);
		}
	}
	return { loaded, skipped };
}

/** Where to tell the user to put a key, when none is found. */
export function envHint(varName: string): string {
	return (
		`  ${varName} is not set.\n` +
		`  Put it in a gitignored env file:\n` +
		`    cp apps/builder/.env.example apps/builder/.env\n` +
		`    $EDITOR apps/builder/.env\n` +
		`  or export it in your shell for a one-off run.`
	);
}
