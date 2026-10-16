#!/usr/bin/env tsx
/**
 * The scope-store envelope's Ed25519 keys (K-52, RFC scope-stores §10.3): generate one, check a
 * configured set, and walk a rotation. Runbook: secrets/store-keys.md.
 *
 *   pnpm store-keys generate --audience caller|platform --out <path outside the work tree>
 *   pnpm store-keys generate --audience caller|platform --stdout [--yes-print-to-terminal]
 *   pnpm store-keys doctor [--env prod|test|dev] [--file <env file>] [--key-file <path>]...
 *   pnpm store-keys rotate --audience caller|platform [--env …] [--file …] [--key-file <path>]... [--drop <kid>]
 *
 * One signing key per audience: the router signs `caller` with STORE_CALLER_KEY, the control
 * plane signs `platform` with STORE_PLATFORM_KEY. Every store script holds only public keys, a
 * list per audience (STORE_CALLER_PUBLIC_KEYS, STORE_PLATFORM_PUBLIC_KEYS), written in by the
 * control plane when it uploads the script.
 *
 * What the tool will never do: print a private key anywhere but the one place `generate` was
 * told to put it, write a file inside a git work tree, edit the env file, or talk to Cloudflare.
 * A check that fails names the variable and the check, never the value. Kids and public keys
 * are not secret and are printed.
 *
 * Every key judgement is made by `@substrat-run/contracts`' envelope module, the same code a
 * store script and both signers run, so this tool cannot accept a key a store would refuse.
 */
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateScopeStoreKeyPair,
  ScopeStoreKeyError,
  scopeStoreKeyId,
  scopeStorePublicKeyProblem,
  scopeStorePublicKeysFrom,
  scopeStoreSignerPublicKey,
  type ScopeStoreAudience,
  type ScopeStoreKeyProblem,
  type ScopeStorePublicKeyProblem,
} from '../packages/contracts/src/scope-store-envelope.ts';
import { parseEnvText, STORE_KEY_AUDIENCES, STORE_KEY_UPLOADER } from '../scripts/secrets.mjs';
import { repoRoot } from './repo-path.mjs';

const ROOT = repoRoot(import.meta.url);
const AUDIENCES = Object.keys(STORE_KEY_AUDIENCES) as ScopeStoreAudience[];
const other = (aud: ScopeStoreAudience): ScopeStoreAudience => (aud === 'caller' ? 'platform' : 'caller');

/** A refusal. Its message is written by this file and never carries a value it was given. */
export class StoreKeysError extends Error {}

interface Finding {
  readonly level: 'error' | 'warn';
  /** The variable (or file) the finding is about. Never its value. */
  readonly subject: string;
  readonly check: string;
}

// ── reading one audience ─────────────────────────────────────────────────────────

/** A public key, as listed or as derived from a private key. Canonical, so equal text is equal bytes. */
interface Signer {
  readonly publicKey: string;
  readonly kid: string;
}

interface ListedKey extends Signer {
  readonly position: number;
}

const PUBLIC_KEY_PROBLEM: Readonly<Record<ScopeStorePublicKeyProblem, string>> = {
  empty: 'is empty',
  length: 'is not 32 bytes of base64url (not a raw Ed25519 public key)',
  'small-order': 'is a small-order point',
  'non-canonical': 'is not canonical base64url (another spelling of a key: unused trailing bits set)',
};

const SIGNER_PROBLEM: Readonly<Record<ScopeStoreKeyProblem, string>> = {
  encoding: 'is not base64url',
  'not-ed25519': 'is not an Ed25519 PKCS8 key',
  'no-public-half': 'has no public half',
  'small-order': 'is a small-order point',
};

/** One audience's public-key list, entry by entry. Findings never carry an entry's text. */
async function readList(name: string, text: string | undefined, findings: Finding[]): Promise<ListedKey[] | undefined> {
  if (text === undefined) {
    findings.push({ level: 'error', subject: name, check: 'is unset: every store script is uploaded with this list, and the upload refuses without it' });
    return undefined;
  }
  const listed: ListedKey[] = [];
  const entries = text.split(',').map((entry) => entry.trim());
  for (const [i, entry] of entries.entries()) {
    const position = i + 1;
    const problem = scopeStorePublicKeyProblem(entry);
    if (problem) {
      findings.push({ level: 'error', subject: name, check: `entry ${position} ${PUBLIC_KEY_PROBLEM[problem]}` });
      continue;
    }
    const twin = listed.find((key) => key.publicKey === entry);
    if (twin) {
      findings.push({ level: 'error', subject: name, check: `entry ${position} is entry ${twin.position} again` });
      continue;
    }
    listed.push({ position, publicKey: entry, kid: await scopeStoreKeyId(entry) });
  }
  return listed;
}

/** A PKCS8 private key's public half, or a finding naming what is wrong with it. */
async function readSigner(subject: string, text: string | undefined, findings: Finding[]): Promise<Signer | undefined> {
  if (text === undefined) {
    findings.push({ level: 'error', subject, check: 'is unset' });
    return undefined;
  }
  try {
    return await scopeStoreSignerPublicKey(text);
  } catch (error) {
    // Reported by its reason alone; nothing the key's parser said is shown.
    findings.push({ level: 'error', subject, check: error instanceof ScopeStoreKeyError ? SIGNER_PROBLEM[error.reason] : 'is not usable' });
    return undefined;
  }
}

// ── doctor ───────────────────────────────────────────────────────────────────────

/** A key `generate` wrote to a file and the operator has not yet made the signer. */
interface StagedKey {
  /** How the operator named it: the file path. */
  readonly label: string;
  /** The file's text: one `STORE_<AUDIENCE>_KEY=<pkcs8>` line. */
  readonly text: string;
}

type Phase = 'steady' | 'listed' | 'switched' | 'two-listed' | 'unknown';

interface AudienceReport {
  readonly listed: readonly ListedKey[] | undefined;
  readonly signer: Signer | undefined;
  readonly staged: readonly (Signer & { readonly label: string })[];
  readonly phase: Phase;
}

interface DoctorReport {
  readonly findings: readonly Finding[];
  readonly audiences: Readonly<Record<ScopeStoreAudience, AudienceReport>>;
}

/** Which step of a rotation a list and its signer are at. */
function phaseOf(listed: readonly ListedKey[] | undefined, signer: Signer | undefined, staged: readonly Signer[]): Phase {
  if (!listed || !signer || !listed.some((key) => key.publicKey === signer.publicKey)) return 'unknown';
  if (listed.length === 1) return 'steady';
  const stagedListed = staged.find((key) => listed.some((l) => l.publicKey === key.publicKey));
  if (stagedListed) return stagedListed.publicKey === signer.publicKey ? 'switched' : 'listed';
  return 'two-listed';
}

/**
 * Every check a configured set must pass, from the env file's values and any staged key files.
 * Read-only, and nothing in the report is private: findings name variables, the rest is kids
 * and public keys.
 */
export async function doctor(values: Readonly<Record<string, string>>, stagedFiles: readonly StagedKey[] = []): Promise<DoctorReport> {
  const findings: Finding[] = [];
  const lists = {} as Record<ScopeStoreAudience, ListedKey[] | undefined>;
  const signers = {} as Record<ScopeStoreAudience, Signer | undefined>;
  for (const aud of AUDIENCES) {
    const names = STORE_KEY_AUDIENCES[aud];
    lists[aud] = await readList(names.publicKeys, values[names.publicKeys], findings);
    signers[aud] = await readSigner(names.privateKey, values[names.privateKey], findings);
  }
  const staged = { caller: [], platform: [] } as Record<ScopeStoreAudience, (Signer & { label: string })[]>;
  for (const file of stagedFiles) {
    const entries = Object.entries(parseEnvText(file.text) as Record<string, string>);
    const audience = AUDIENCES.find((aud) => entries.length === 1 && entries[0]![0] === STORE_KEY_AUDIENCES[aud].privateKey);
    if (!audience) {
      findings.push({ level: 'error', subject: file.label, check: 'is not one STORE_CALLER_KEY= or STORE_PLATFORM_KEY= line, as generate writes' });
      continue;
    }
    const signer = await readSigner(file.label, entries[0]![1], findings);
    if (signer) staged[audience].push({ ...signer, label: file.label });
  }

  // L16: a key listed for both audiences, or one key signing both, lets the caller key sign `substrat.erase`.
  const { caller: callerNames, platform: platformNames } = STORE_KEY_AUDIENCES;
  for (const key of lists.caller ?? []) {
    const twin = lists.platform?.find((t) => t.publicKey === key.publicKey);
    if (twin) {
      findings.push({ level: 'error', subject: callerNames.publicKeys, check: `entry ${key.position} (kid ${key.kid}) is also ${platformNames.publicKeys} entry ${twin.position}: every store refuses every call while a key is in both lists` });
    }
  }
  if (signers.caller && signers.caller.publicKey === signers.platform?.publicKey) {
    findings.push({ level: 'error', subject: callerNames.privateKey, check: `is the same key as ${platformNames.privateKey}: each audience needs its own` });
  }

  for (const aud of AUDIENCES) {
    const names = STORE_KEY_AUDIENCES[aud];
    const otherNames = STORE_KEY_AUDIENCES[other(aud)];
    const own = lists[aud];
    const theirs = lists[other(aud)];
    const signer = signers[aud];
    if (signer) {
      if (own && !own.some((key) => key.publicKey === signer.publicKey)) {
        findings.push({ level: 'error', subject: names.privateKey, check: `signs as kid ${signer.kid}, which ${names.publicKeys} does not list: every ${aud} call is refused (the signer was switched before its key was listed)` });
      }
      if (theirs?.some((key) => key.publicKey === signer.publicKey)) {
        findings.push({ level: 'error', subject: names.privateKey, check: `signs as kid ${signer.kid}, which ${otherNames.publicKeys} lists: its holder could sign ${other(aud)} envelopes` });
      }
    }
    for (const key of staged[aud]) {
      if (theirs?.some((t) => t.publicKey === key.publicKey)) {
        findings.push({ level: 'error', subject: key.label, check: `(kid ${key.kid}, ${aud}) is listed in ${otherNames.publicKeys}` });
      }
      if (signers[other(aud)]?.publicKey === key.publicKey) {
        findings.push({ level: 'error', subject: key.label, check: `is the same key as ${otherNames.privateKey}` });
      }
      if (own && !own.some((l) => l.publicKey === key.publicKey)) {
        findings.push({ level: 'warn', subject: key.label, check: `(kid ${key.kid}) is not in ${names.publicKeys} yet: list it and deploy before making it the signer` });
      }
    }
    if (own && own.length > 1) {
      findings.push({ level: 'warn', subject: names.publicKeys, check: `lists ${own.length} keys: a rotation is in progress (pnpm store-keys rotate --audience ${aud})` });
    }
  }

  // The store's own reading of the pair must agree. If it refuses and nothing above did, this
  // tool has fallen behind the envelope module, which is a defect here, not an operator error.
  const callerText = values[STORE_KEY_AUDIENCES.caller.publicKeys];
  const platformText = values[STORE_KEY_AUDIENCES.platform.publicKeys];
  if (callerText !== undefined && platformText !== undefined && !findings.some((f) => f.level === 'error' && f.subject.endsWith('_PUBLIC_KEYS'))) {
    try {
      scopeStorePublicKeysFrom({ caller: callerText, platform: platformText });
    } catch {
      findings.push({ level: 'error', subject: 'STORE_*_PUBLIC_KEYS', check: 'pass every check here but the store refuses them: tools/store-keys.mts is out of step with the envelope module' });
    }
  }

  const audiences = {} as Record<ScopeStoreAudience, AudienceReport>;
  for (const aud of AUDIENCES) {
    audiences[aud] = { listed: lists[aud], signer: signers[aud], staged: staged[aud], phase: phaseOf(lists[aud], signers[aud], staged[aud]) };
  }
  return { findings, audiences };
}

function formatDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  for (const aud of AUDIENCES) {
    const names = STORE_KEY_AUDIENCES[aud];
    const a = report.audiences[aud];
    lines.push(`● ${aud}  (signer: ${names.signer} ${names.privateKey}; list: ${names.publicKeys})  phase: ${a.phase}`);
    for (const key of a.listed ?? []) {
      const marks = [
        a.signer?.publicKey === key.publicKey ? 'signer' : '',
        ...a.staged.filter((s) => s.publicKey === key.publicKey).map((s) => `staged ${s.label}`),
      ].filter(Boolean);
      lines.push(`    ${key.kid}  ${key.publicKey}${marks.length ? `  ← ${marks.join(', ')}` : ''}`);
    }
    if (a.signer && !a.listed?.some((key) => key.publicKey === a.signer!.publicKey)) lines.push(`    ${a.signer.kid}  (signer, NOT listed)`);
    for (const s of a.staged) if (!a.listed?.some((key) => key.publicKey === s.publicKey)) lines.push(`    ${s.kid}  (staged ${s.label}, not listed)`);
  }
  const errors = report.findings.filter((f) => f.level === 'error');
  const warnings = report.findings.filter((f) => f.level === 'warn');
  if (warnings.length || errors.length) lines.push('');
  for (const f of warnings) lines.push(`· ${f.subject} ${f.check}`);
  for (const f of errors) lines.push(`✗ ${f.subject} ${f.check}`);
  lines.push('', errors.length ? `✗ ${errors.length} problem(s). Private keys are never printed.` : '✓ ok. Private keys are never printed.');
  return lines.join('\n');
}

// ── rotate ───────────────────────────────────────────────────────────────────────

const STORE_REACH_CAVEAT =
  'A store script is written with the lists only when it is uploaded: today that is its vertical\'s\n' +
  '       next push or serve, not a fleet-wide re-ensure (issue #2309). Until that exists, a changed\n' +
  '       list reaches each store script only as its vertical is pushed or served again.';

/**
 * The ordered rotation for one audience with the current step marked, or the new list value
 * when `drop` names a kid to remove. Throws {@link StoreKeysError} on an ordering it can see is
 * unsafe; it cannot see what is deployed, and says so.
 */
export function rotatePlan(report: DoctorReport, aud: ScopeStoreAudience, env: string, drop?: string): string {
  const names = STORE_KEY_AUDIENCES[aud];
  const a = report.audiences[aud];
  // Any error blocks, the other audience's included: a key in both lists breaks both.
  const blocking = report.findings.filter((f) => f.level === 'error');
  if (blocking.length) {
    throw new StoreKeysError(
      `refusing: the ${aud} set is not safe to rotate from:\n${blocking.map((f) => `  ✗ ${f.subject} ${f.check}`).join('\n')}\n  (pnpm store-keys doctor shows the whole set)`,
    );
  }
  if (drop !== undefined) {
    const listed = a.listed ?? [];
    const target = listed.find((key) => key.kid === drop);
    if (!target) throw new StoreKeysError(`refusing: ${names.publicKeys} lists no key with kid ${drop}`);
    if (!a.signer) throw new StoreKeysError(`refusing: ${names.privateKey} is unset, so dropping a key cannot be checked against the signer`);
    if (target.publicKey === a.signer.publicKey) {
      throw new StoreKeysError(`refusing: kid ${drop} is the key ${names.privateKey} signs with; every ${aud} call would be refused. Switch the signer first.`);
    }
    // Never empty: the signer's key is listed (a blocking finding otherwise) and is not the target.
    const rest = listed.filter((key) => key !== target);
    return [
      `New value (paste it into the env file, then push and deploy the ${STORE_KEY_UPLOADER}):`,
      `${names.publicKeys}=${rest.map((key) => key.publicKey).join(',')}`,
      '',
      `Then: node scripts/secrets.mjs push --env ${env} --only ${STORE_KEY_UPLOADER}`,
      `      ${STORE_REACH_CAVEAT}`,
    ].join('\n');
  }
  const at = (phase: Phase[]) => (phase.includes(a.phase) ? '→' : ' ');
  return [
    `Rotating the ${aud} key (signer: ${names.signer}, ${names.privateKey}). Current phase: ${a.phase}.`,
    'Each step is finished before the next starts. This tool sees the env file, not what is deployed.',
    ...(a.phase === 'two-listed' ? ['Two keys are listed and no staged key was given: pass --key-file <the staged file> to tell step 3 from step 5.'] : []),
    '',
    `${at(['steady'])} 1. pnpm store-keys generate --audience ${aud} --out <path outside any git work tree>`,
    `     Keep the file until step 4. It is the new private key; the public key and kid are on stderr.`,
    `  2. Add the new public key to ${names.publicKeys} (comma-separated, after the current one),`,
    `     then: node scripts/secrets.mjs push --env ${env} --only ${STORE_KEY_UPLOADER}, and deploy the ${STORE_KEY_UPLOADER}.`,
    `       ${STORE_REACH_CAVEAT}`,
    `     Check: pnpm store-keys doctor --env ${env} --key-file <path>  (the staged key must be listed).`,
    `${at(['listed'])} 3. Wait until every store script that ${names.signer} calls carries the new list (step 2's caveat).`,
    `${at(['listed'])} 4. Switch the signer: replace the ${names.privateKey}= line in the env file with the staged file's line,`,
    `     node scripts/secrets.mjs push --env ${env} --only ${names.signer}, deploy the ${names.signer}, then delete the staged file.`,
    `     Doctor refuses a signer whose key is not listed, which is the ordering that breaks every ${aud} call.`,
    `${at(['switched'])} 5. Drop the old key: pnpm store-keys rotate --audience ${aud} --drop <old kid> prints the new list.`,
    `     It refuses to drop the key the signer uses. Push and deploy the ${STORE_KEY_UPLOADER} again (same caveat).`,
    '',
    'A COMPROMISED key is revoked in a different order: switch the signer FIRST (steps 1, 2 and 4 at once,',
    `accepting that ${aud} calls fail at stores that do not yet list the new key), revoke the old`,
    `${names.privateKey} value at the secrets manager, and only then drop the old public key (step 5).`,
    'Dropping the old public key while it still signs would refuse the platform\'s own calls wherever',
    'the new list arrives. Either way the fleet-wide effect is bounded by issue #2309: a store script',
    'keeps the old list, and keeps accepting the compromised key, until it is uploaded again.',
    '',
    'The runbook is secrets/store-keys.md.',
  ].join('\n');
}

// ── generate ─────────────────────────────────────────────────────────────────────

/** Whether `path` is `dir` or inside it. */
const inside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

interface WriteFs {
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  fstatSync: typeof fstatSync;
  closeSync: typeof closeSync;
  unlinkSync: typeof unlinkSync;
}
const nodeFs: WriteFs = { openSync, writeSync, fstatSync, closeSync, unlinkSync };

/**
 * Refuse an output path a private key must not land at: inside this repository or any git
 * work tree (checked on the resolved parent, so a symlink into one is caught), in a directory
 * other users can read or write, or over an existing file.
 */
export function assertPrivateOutPath(out: string, repoRoot = ROOT): string {
  const path = resolve(out);
  const parent = dirname(path);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    throw new StoreKeysError(`refusing: the directory ${parent} does not exist`);
  }
  const realRoot = realpathSync(repoRoot);
  if (inside(realRoot, realParent) || inside(resolve(repoRoot), parent)) {
    throw new StoreKeysError(`refusing: ${path} is inside this repository's work tree; a private key never goes there`);
  }
  const git = spawnSync('git', ['-C', realParent, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (git.status === 0) {
    throw new StoreKeysError(`refusing: ${path} is inside the git work tree ${git.stdout.trim()}; a private key never goes there`);
  }
  const parentMode = statSync(realParent).mode;
  if ((parentMode & 0o007) !== 0) {
    throw new StoreKeysError(`refusing: ${realParent} is open to other users (mode ${(parentMode & 0o777).toString(8)}); use a directory only you can read`);
  }
  return join(realParent, relative(parent, path));
}

/**
 * Create `path` exclusively with mode 0600, write `line`, and confirm nobody else can read it.
 * An existing file (or symlink) is refused by the exclusive create; a mode that came out wider
 * than 0600 removes the file and refuses.
 */
export function writePrivateFile(path: string, line: string, fs: WriteFs = nodeFs): void {
  let fd: number;
  try {
    fd = fs.openSync(path, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new StoreKeysError(code === 'EEXIST' ? `refusing: ${path} already exists; generate never overwrites` : `refusing: cannot create ${path} (${code ?? 'error'})`);
  }
  try {
    const mode = fs.fstatSync(fd).mode;
    if ((mode & 0o077) !== 0) {
      fs.closeSync(fd);
      fs.unlinkSync(path);
      throw new StoreKeysError(`refusing: ${path} was created readable by others (mode ${(mode & 0o777).toString(8)}); removed it`);
    }
    fs.writeSync(fd, `${line}\n`);
    fs.closeSync(fd);
  } catch (error) {
    if (error instanceof StoreKeysError) throw error;
    try {
      fs.unlinkSync(path);
    } catch {
      // Already gone.
    }
    throw new StoreKeysError(`refusing: writing ${path} failed; removed it`);
  }
}

export interface GenerateIo {
  readonly stdout: { write(text: string): unknown; readonly isTTY?: boolean };
  readonly stderr: { write(text: string): unknown };
}

export async function generate(
  aud: ScopeStoreAudience,
  target: { readonly out: string } | { readonly toTerminal: boolean },
  io: GenerateIo,
  options: { readonly repoRoot?: string; readonly fs?: WriteFs } = {},
): Promise<{ readonly publicKey: string; readonly kid: string }> {
  const names = STORE_KEY_AUDIENCES[aud];
  // Every refusal happens before the key exists.
  const out = 'out' in target ? assertPrivateOutPath(target.out, options.repoRoot) : undefined;
  if ('toTerminal' in target && io.stdout.isTTY && !target.toTerminal) {
    throw new StoreKeysError(
      'refusing: stdout is a terminal, so the private key would land in its scrollback. Redirect it, use --out, or pass --yes-print-to-terminal.',
    );
  }
  const pair = await generateScopeStoreKeyPair();
  const line = `${names.privateKey}=${pair.privateKey}`;
  if (out) {
    writePrivateFile(out, line, options.fs);
    io.stderr.write(`✓ wrote ${names.privateKey} (mode 0600) to ${out}\n`);
  } else {
    io.stderr.write(
      `! the private key is on stdout. If stdout was not redirected where you meant, it is now in a terminal's\n` +
        `  scrollback or a file you did not intend; treat it as exposed and generate another.\n`,
    );
    io.stdout.write(`${line}\n`);
  }
  io.stderr.write(
    [
      `audience:   ${aud} (signer: ${names.signer})`,
      `public key: ${pair.publicKey}`,
      `kid:        ${pair.kid}`,
      '',
      `Next: add the public key to ${names.publicKeys} and deploy the ${STORE_KEY_UPLOADER} BEFORE setting ${names.privateKey}.`,
      `      pnpm store-keys rotate --audience ${aud} prints the whole procedure.`,
      '',
    ].join('\n'),
  );
  return { publicKey: pair.publicKey, kid: pair.kid };
}

// ── command line ─────────────────────────────────────────────────────────────────

interface Args {
  readonly command: string | undefined;
  readonly flags: Map<string, string[]>;
}

const BOOLEAN = new Set(['stdout', 'yes-print-to-terminal']);

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string[]>();
  const [command, ...rest] = argv;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) throw new StoreKeysError(`unexpected argument at position ${i + 2}`);
    const name = arg.slice(2);
    const value = BOOLEAN.has(name) ? 'true' : rest[++i];
    if (value === undefined) throw new StoreKeysError(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, flags };
}

const one = (args: Args, name: string) => args.flags.get(name)?.at(-1);

function audienceOf(args: Args): ScopeStoreAudience {
  const aud = one(args, 'audience');
  if (aud !== 'caller' && aud !== 'platform') throw new StoreKeysError('--audience must be caller or platform');
  return aud;
}

function readEnv(args: Args): { values: Record<string, string>; env: string } {
  const env = one(args, 'env') ?? 'prod';
  const path = resolve(ROOT, one(args, 'file') ?? `secrets/platform.${env}.env`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new StoreKeysError(`cannot read the env file ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  return { values: parseEnvText(text) as Record<string, string>, env };
}

function readStaged(args: Args): StagedKey[] {
  return (args.flags.get('key-file') ?? []).map((label) => {
    try {
      return { label, text: readFileSync(label, 'utf8') };
    } catch (error) {
      throw new StoreKeysError(`cannot read the key file ${label} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  });
}

const USAGE = `usage:
  pnpm store-keys generate --audience caller|platform --out <path outside the work tree>
  pnpm store-keys generate --audience caller|platform --stdout [--yes-print-to-terminal]
  pnpm store-keys doctor [--env prod|test|dev] [--file <env file>] [--key-file <path>]...
  pnpm store-keys rotate --audience caller|platform [--env …] [--file …] [--key-file <path>]... [--drop <kid>]
Runbook: secrets/store-keys.md`;

/** Run one command. Returns the exit code; never throws, and never prints a value it read. */
export async function main(argv: readonly string[], io: GenerateIo): Promise<number> {
  try {
    const args = parseArgs(argv);
    switch (args.command) {
      case 'generate': {
        const toStdout = args.flags.has('stdout');
        const out = one(args, 'out');
        if (toStdout === (out !== undefined)) throw new StoreKeysError('generate needs exactly one of --out <path> or --stdout');
        await generate(audienceOf(args), out !== undefined ? { out } : { toTerminal: args.flags.has('yes-print-to-terminal') }, io);
        return 0;
      }
      case 'doctor': {
        const { values } = readEnv(args);
        const report = await doctor(values, readStaged(args));
        io.stdout.write(`${formatDoctor(report)}\n`);
        return report.findings.some((f) => f.level === 'error') ? 1 : 0;
      }
      case 'rotate': {
        const aud = audienceOf(args);
        const { values, env } = readEnv(args);
        io.stdout.write(`${rotatePlan(await doctor(values, readStaged(args)), aud, env, one(args, 'drop'))}\n`);
        return 0;
      }
      default:
        io.stderr.write(`${USAGE}\n`);
        return args.command === undefined ? 0 : 1;
    }
  } catch (error) {
    // Only this file's own messages are shown; anything else is reported by its kind alone.
    io.stderr.write(`✗ ${error instanceof StoreKeysError ? error.message : `unexpected ${(error as Error)?.name ?? 'error'}`}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
}
