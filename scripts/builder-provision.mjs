#!/usr/bin/env node
/**
 * Idempotent provision + deploy for the builder studio (#625/#626/#627).
 *
 *   node scripts/builder-provision.mjs [--env prod] [--skip-deploy] [--dry-run]
 *
 * Safe to run MANY times: every step checks current state before acting and
 * reports ✓ (already correct) or → (changed it now). Exists because multi-step
 * manual ops drift — the platform's own 08-01 rotation incident is the proof —
 * and because "does that bucket exist, are the secrets there?" should be a
 * question this script answers, not a memory.
 *
 * Steps:
 *   1. R2 bucket `substrat-builder-repos` exists       (wrangler; D-52)
 *   2. Rollback trail: reports that it is APP-LEVEL bundle history — R2 has
 *      NO object versioning (verified by probing the v4 API; step 2 below
 *      only says so, it enables nothing)
 *   3. Builder secrets present in the env file          (names only, never values)
 *   4. Push builder secrets                             (delegates: secrets.mjs
 *      push --env <env> --only builder)
 *   5. Deploy                                           (cf:deploy — builds the
 *      container image on first run: SLOW, that is normal)
 *   6. Smoke: anonymous callers must get 401/302, never the app
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const BUCKET = 'substrat-builder-repos';
const HOST = 'https://builder.substrat.net';

const argv = process.argv.slice(2);
const flag = (n) => {
	const i = argv.indexOf(`--${n}`);
	return i === -1 ? undefined : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);
const ENV = flag('env') ?? 'prod';
const DRY = has('dry-run');

const ok = (m) => console.log(`  ✓ ${m}`);
const act = (m) => console.log(`  → ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const fail = (m) => {
	console.error(`  ✗ ${m}`);
	process.exit(1);
};

function sh(cmd, opts = {}) {
	return execSync(cmd, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		// Non-interactive wrangler cannot pick among multiple Cloudflare accounts —
		// pin the platform account from the same secrets file everything else uses.
		env: { ...process.env, ...(secrets.CF_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: secrets.CF_ACCOUNT_ID } : {}) },
		...opts,
	});
}

/** Flat KEY=value parser — same format secrets.mjs reads; values never printed. */
function readEnvFile(path) {
	const out = {};
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
		if (m) out[m[1]] = m[2];
	}
	return out;
}

const envFile = `secrets/platform.${ENV}.env`;
const secrets = readEnvFile(envFile);

console.log(`builder provision · env=${ENV}${DRY ? ' · DRY RUN (no changes)' : ''}\n`);

// ── 1. bucket ────────────────────────────────────────────────────────────────
console.log('R2 bucket');
let bucketExists = false;
try {
	sh(`npx wrangler r2 bucket info ${BUCKET}`, { cwd: 'apps/builder' });
	bucketExists = true;
	ok(`${BUCKET} exists`);
} catch {
	if (DRY) act(`would create ${BUCKET}`);
	else {
		sh(`npx wrangler r2 bucket create ${BUCKET}`, { cwd: 'apps/builder' });
		bucketExists = true;
		act(`created ${BUCKET}`);
	}
}

// ── 2. versioning (dashboard-only: the v4 API has NO versioning endpoint —
// learned by probing; R2 versioning is managed via the S3 API or the dash) ──
console.log('Object versioning (the D-52 rollback trail)');
const token = secrets.BUILDER_CF_API_TOKEN || secrets.CF_API_TOKEN;
const account = secrets.CF_ACCOUNT_ID;
if (!secrets.BUILDER_CF_API_TOKEN && secrets.CF_API_TOKEN) {
	warn('using the control plane CF_API_TOKEN for R2 (no BUILDER_CF_API_TOKEN set) —');
	warn('prefer a dedicated token with only Workers R2 Storage:Edit.');
}
if (!token || !account) {
	warn(`no R2-capable token in ${envFile} — cannot verify the bucket at all.`);
} else {
	const r = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets`,
		{ headers: { authorization: `Bearer ${token}` } },
	);
	const body = await r.json().catch(() => null);
	const names = (body?.result?.buckets ?? []).map((b) => b.name);
	if (body?.success && names.includes(BUCKET)) {
		ok(`token verified against R2 (bucket visible)`);
	} else {
		warn(`token cannot list R2 buckets (HTTP ${r.status}) — check its permissions.`);
	}
	ok('rollback trail: app-level bundle history (R2 has NO object versioning — verified)');
}

// ── 3. secrets present (names only) ─────────────────────────────────────────
console.log(`Secrets in ${envFile}`);
const required = ['BUILDER_OIDC_CLIENT_ID', 'BUILDER_OIDC_CLIENT_SECRET', 'BUILDER_SESSION_SECRET'];
const providers = ['BUILDER_ANTHROPIC_API_KEY', 'BUILDER_DASHSCOPE_API_KEY'];
const missing = required.filter((k) => !secrets[k]);
if (missing.length) {
	fail(
		`missing: ${missing.join(', ')} — fill ${envFile} (secrets.mjs generate covers the session secret), then re-run.`,
	);
}
ok('auth secrets set');
if (!providers.some((k) => secrets[k])) {
	// Near-miss detection: the flat file is shared across workers, so builder
	// keys carry the BUILDER_ prefix — an unprefixed DASHSCOPE_API_KEY is the
	// most common way this goes wrong, and silence about it costs a debug loop.
	const nearMiss = providers
		.map((k) => k.replace(/^BUILDER_/, ''))
		.filter((k) => secrets[k]);
	if (nearMiss.length) {
		warn(`found ${nearMiss.join(', ')} — but builder keys need the BUILDER_ prefix:`);
		for (const k of nearMiss) warn(`  rename ${k} → BUILDER_${k}`);
	} else {
		warn('no model-provider key set — the studio will deploy but every turn 422s.');
		warn(`set ${providers.join(' or ')} in ${envFile} and re-run (idempotent).`);
	}
} else {
	ok(`provider key(s): ${providers.filter((k) => secrets[k]).join(', ')}`);
}

// ── 4. push ──────────────────────────────────────────────────────────────────
console.log('Push worker secrets');
if (DRY) act('would run: secrets.mjs push --env ' + ENV + ' --only builder');
else {
	execFileSync('node', ['scripts/secrets.mjs', 'push', '--env', ENV, '--only', 'builder'], {
		stdio: 'inherit',
		env: { ...process.env, ...(secrets.CF_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: secrets.CF_ACCOUNT_ID } : {}) },
	});
}

// ── 5. deploy ────────────────────────────────────────────────────────────────
console.log('Deploy');
if (has('skip-deploy')) warn('skipped (--skip-deploy)');
else if (DRY) act('would run: pnpm --filter @substrat-run/builder cf:deploy');
else {
	act('deploying (first run builds the container image — slow is normal)…');
	execSync('pnpm --filter @substrat-run/builder cf:deploy', {
		stdio: 'inherit',
		env: { ...process.env, ...(secrets.CF_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: secrets.CF_ACCOUNT_ID } : {}) },
	});
}

// ── 6. smoke ─────────────────────────────────────────────────────────────────
console.log('Smoke (anonymous must never see the app)');
if (DRY || has('skip-deploy')) {
	act('skipped (no deploy this run)');
} else {
	const api = await fetch(`${HOST}/api/session`);
	api.status === 401 ? ok('anonymous API → 401') : fail(`anonymous API → ${api.status} (expected 401)`);
	const page = await fetch(HOST, { headers: { accept: 'text/html' }, redirect: 'manual' });
	page.status === 302
		? ok(`anonymous browser → 302 ${page.headers.get('location')}`)
		: fail(`anonymous browser → ${page.status} (expected 302 to login)`);
}

console.log('\ndone.');
