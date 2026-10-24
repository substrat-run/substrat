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
 * The wire envelope's keys (RFC wire-signing §6, K-58) are the same scheme over two issuers, and
 * the same commands run over them as `pnpm wire-keys` (`tools/wire-keys.mts`, {@link WIRE_FAMILY},
 * `--issuer router|platform`, runbook secrets/wire-keys.md). Each wire list also carries a standby
 * key beside the one in use, which doctor asks for.
 *
 * What the tool will never do: print a private key anywhere but the one place `generate` was
 * told to put it, write a file inside a git work tree, edit the env file, or talk to Cloudflare.
 * A check that fails names the variable and the check, never the value. Kids and public keys
 * are not secret and are printed.
 *
 * Every key judgement is made by `@substrat-run/contracts`' envelope module, the same code a
 * store script, a deployment's entry and the signers run, so this tool cannot accept a key a
 * verifier would refuse.
 */
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  generateScopeStoreKeyPair,
  ScopeStoreKeyError,
  scopeStoreKeyId,
  scopeStorePublicKeyProblem,
  scopeStorePublicKeysFrom,
  scopeStoreSignerPublicKey,
  type ScopeStoreKeyProblem,
  type ScopeStorePublicKeyProblem,
} from '../packages/contracts/src/scope-store-envelope.ts';
import { wireVerificationKeys } from '../packages/contracts/src/wire-signing.ts';
import { parseEnvText, STORE_KEY_AUDIENCES, STORE_KEY_UPLOADER, WIRE_KEY_ISSUERS, WIRE_KEY_UPLOADER } from '../scripts/secrets.mjs';
import { repoRoot } from './repo-path.mjs';

const ROOT = repoRoot(import.meta.url);

/** A refusal. Its message is written by this file and never carries a value it was given. */
export class StoreKeysError extends Error {}

// ── the two families ─────────────────────────────────────────────────────────────

/** One signer's names: its private key, the worker that signs with it, and the list that verifies it. */
interface Member {
  readonly privateKey: string;
  readonly signer: string;
  readonly publicKeys: string;
}

/**
 * A family of keys this tool keeps: two members, each signed for by one worker and verified with
 * one list the uploader writes. Every judgement is shared; a family names what differs.
 */
export interface KeyFamily {
  /** `pnpm <command>`. */
  readonly command: string;
  /** What one member is called, on the command line (`--audience`) and in messages. */
  readonly member: 'audience' | 'issuer';
  /** Exactly two, in a fixed order. */
  readonly members: Readonly<Record<string, Member>>;
  /** The worker that writes both lists into what it uploads. */
  readonly uploader: string;
  /** How both lists are named at once, and who verifies against them. */
  readonly lists: string;
  readonly verifier: string;
  /** What an unset list leaves without one, for the finding. */
  readonly listedFor: string;
  /** What a key in both lists breaks. */
  readonly bothLists: string;
  /** Whether each list carries a standby beside the key in use (RFC wire-signing §6). */
  readonly standby: boolean;
  /** The verifier's own reading of both lists, by member; it throws when it refuses them. */
  readonly load: (lists: Readonly<Record<string, string>>) => Promise<unknown>;
  /** The parts of a rotation that depend on how a list reaches what verifies with it. */
  readonly rotation: {
    /** How a pushed list reaches the verifiers, and how to tell it has. */
    readonly reach: string;
    /** Step 3: what to wait for before switching the signer. */
    readonly wait: string;
    /** Step 5's closing lines: when the dropped key counts as revoked. */
    readonly revoked: readonly string[];
    /** The order for a compromised key. */
    readonly compromise: (privateKey: string, member: string) => readonly string[];
  };
  readonly runbook: string;
}

const STORE_REACH_CAVEAT =
  'The deployed lists reach every store script through the control plane\'s rebuild (#2309): its\n' +
  '       quarter-hourly pass rebuilds a bounded number of scripts each time. The change has reached\n' +
  '       every script once `substrat store-driver status --driver <driver>` reads `scripts: current`\n' +
  '       for every driver; `substrat store-driver rebuild --driver <driver>` runs a pass at once.';

/** The scope-store envelope's keys (K-52): two audiences, one key each. */
const STORE_FAMILY: KeyFamily = {
  command: 'store-keys',
  member: 'audience',
  members: STORE_KEY_AUDIENCES,
  uploader: STORE_KEY_UPLOADER,
  lists: 'STORE_*_PUBLIC_KEYS',
  verifier: 'the store',
  listedFor: 'every store script is uploaded with this list',
  bothLists: 'every store refuses every call while a key is in both lists',
  standby: false,
  load: async (lists) => scopeStorePublicKeysFrom({ caller: lists['caller'] ?? '', platform: lists['platform'] ?? '' }),
  rotation: {
    reach: STORE_REACH_CAVEAT,
    wait: 'Wait until every store script carries the new list: store-driver status reads `scripts: current` (step 2\'s caveat).',
    revoked: [
      '     The old key is revoked only once store-driver status reads `scripts: current` again AND no control-plane',
      '     deploy is still rolling out; after the deploy, force the walk: substrat store-driver rebuild --driver <driver> --deploy-finished.',
    ],
    compromise: (privateKey, member) => [
      'A COMPROMISED key is revoked in a different order: switch the signer FIRST (steps 1, 2 and 4 at once,',
      `accepting that ${member} calls fail at stores that do not yet list the new key), and run`,
      '`substrat store-driver rebuild --driver <driver>` for every driver at once, so the new key reaches them; revoke the old',
      `${privateKey} value at the secrets manager, and only then drop the old public key (step 5).`,
      'Dropping the old public key while it still signs would refuse the platform\'s own calls wherever',
      'the new list arrives. Once that deploy serves only the new version, run',
      '`substrat store-driver rebuild --driver <driver> --deploy-finished` for every driver until',
      'it reads `scripts: current` (issue #2309): until then a pending script still accepts the compromised key.',
    ],
  },
  runbook: 'secrets/store-keys.md',
};

const WIRE_REACH_CAVEAT =
  'A list reaches a deployment only when the control plane uploads it again: plain configuration\n' +
  '       is rewritten on every upload. Nothing yet reports which live deployments carry a list (the\n' +
  '       readiness report is RFC wire-signing follow-on 4), so until it exists a deployment is\n' +
  '       known to carry a list only once it has been uploaded since.';

/**
 * The wire envelope's keys (RFC wire-signing §6, K-58): two issuers, one key in use each and a
 * standby listed beside it, whose private half is held offline. `pnpm wire-keys`.
 */
export const WIRE_FAMILY: KeyFamily = {
  command: 'wire-keys',
  member: 'issuer',
  members: WIRE_KEY_ISSUERS,
  uploader: WIRE_KEY_UPLOADER,
  lists: 'WIRE_*_PUBLIC_KEYS',
  verifier: 'a deployment',
  listedFor: 'every deployment is to be uploaded with this list',
  bothLists: 'a deployment refuses to load lists that share a key, so the router could otherwise sign as the platform',
  standby: true,
  load: async (lists) => wireVerificationKeys({ router: lists['router'] ?? '', platform: lists['platform'] ?? '' }),
  rotation: {
    reach: WIRE_REACH_CAVEAT,
    wait: 'Wait until every live deployment carries the new list (step 2\'s caveat).',
    revoked: [
      '     The old key is revoked only once every live deployment has been uploaded with the list that',
      '     drops it: until then a deployment still listing it accepts it.',
    ],
    compromise: (privateKey, member) => [
      'A COMPROMISED key, or a signer that cannot sign, takes the break-glass path (RFC wire-signing §6):',
      'switch the signer FIRST to the standby key, which every deployment already lists (step 4 with the',
      `standby's file), so no ${member} call is refused; revoke the old ${privateKey} value at the secrets`,
      'manager; then list a new standby (generate one, step 2) and drop the compromised public key (step 5,',
      'which refuses to leave the signer\'s key without a standby beside it unless --without-standby is passed),',
      'and upload every live deployment again at once. A deployment not yet uploaded still accepts the',
      'compromised key. Only platform staff on call take this path, as a person, recorded with the reason.',
    ],
  },
  runbook: 'secrets/wire-keys.md',
};

const membersOf = (family: KeyFamily) => Object.keys(family.members);
const otherOf = (family: KeyFamily, member: string) => membersOf(family).find((m) => m !== member)!;

/** One member's names, or the refusal naming the members there are. */
function memberNames(family: KeyFamily, member: string): Member {
  if (!Object.hasOwn(family.members, member)) throw new StoreKeysError(`--${family.member} must be ${membersOf(family).join(' or ')}`);
  return family.members[member]!;
}

// ── reading one member ───────────────────────────────────────────────────────────

/** A public key, as listed or as derived from a private key. Canonical, so equal text is equal bytes. */
interface Signer {
  readonly publicKey: string;
  readonly kid: string;
}

interface ListedKey extends Signer {
  readonly position: number;
}

interface Finding {
  readonly level: 'error' | 'warn';
  /** The variable (or file) the finding is about. Never its value. */
  readonly subject: string;
  readonly check: string;
}

const PUBLIC_KEY_PROBLEM: Readonly<Record<ScopeStorePublicKeyProblem, string>> = {
  empty: 'is empty',
  length: 'is not 32 bytes of base64url (not a raw Ed25519 public key)',
  'small-order': 'is a small-order point',
  'non-canonical': 'is not canonical base64url (another spelling of a key: unused trailing bits set)',
};

const SIGNER_PROBLEM: Readonly<Record<ScopeStoreKeyProblem, string>> = {
  encoding: 'is not base64url',
  'not-pkcs8-v1': 'is not a 48-byte Ed25519 PKCS8 v1 key (the form generate writes)',
  'not-ed25519': 'is not an Ed25519 PKCS8 key',
  'no-public-half': 'has no public half',
  'small-order': 'is a small-order point',
};

/**
 * The private material a set's env file and staged files hold, in each form a list entry could take
 * by mistake: a key's PKCS8 text and its raw 32-byte seed. Only ever compared, never printed.
 */
function privateForms(texts: readonly (string | undefined)[]): Set<string> {
  const forms = new Set<string>();
  for (const text of texts) {
    const value = text?.trim();
    const bytes = value ? base64UrlToBytes(value) : undefined;
    if (!value || !bytes || bytes.length !== 48) continue;
    forms.add(value);
    forms.add(bytesToBase64Url(bytes.slice(16)));
  }
  return forms;
}

/** Whether a list entry is itself a usable private key, whoever's it is. */
async function isPrivateKey(entry: string): Promise<boolean> {
  try {
    await scopeStoreSignerPublicKey(entry);
    return true;
  } catch {
    return false;
  }
}

/** One member's public-key list, entry by entry. Findings never carry an entry's text. */
async function readList(
  name: string,
  text: string | undefined,
  findings: Finding[],
  family: KeyFamily,
  secrets: ReadonlySet<string>,
): Promise<ListedKey[] | undefined> {
  if (text === undefined) {
    findings.push({ level: 'error', subject: name, check: `is unset: ${family.listedFor}, and the upload refuses without it` });
    return undefined;
  }
  const listed: ListedKey[] = [];
  const entries = text.split(',').map((entry) => entry.trim());
  for (const [i, entry] of entries.entries()) {
    const position = i + 1;
    // A private key, or a seed of one this set holds, pasted where a public key belongs would be
    // handed to every deployment the list reaches. Said before any other check, and never shown.
    if (secrets.has(entry) || (await isPrivateKey(entry))) {
      findings.push({ level: 'error', subject: name, check: `entry ${position} looks like private material: a list holds public keys only` });
      continue;
    }
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
  /** The file's text: one `<PRIVATE KEY NAME>=<pkcs8>` line. */
  readonly text: string;
}

type Phase = 'steady' | 'listed' | 'switched' | 'two-listed' | 'unknown';

interface MemberReport {
  readonly listed: readonly ListedKey[] | undefined;
  readonly signer: Signer | undefined;
  readonly staged: readonly (Signer & { readonly label: string })[];
  readonly phase: Phase;
}

interface DoctorReport {
  /** The family the report was made for, which its rotation is planned in. */
  readonly family: KeyFamily;
  readonly findings: readonly Finding[];
  /** Per audience (the store's) or issuer (the wire's). */
  readonly members: Readonly<Record<string, MemberReport>>;
}

/**
 * Which step of a rotation a list and its signer are at. A family with a standby holds two keys
 * when steady, the one in use and the standby; a rotation adds one.
 */
function phaseOf(listed: readonly ListedKey[] | undefined, signer: Signer | undefined, staged: readonly Signer[], steady: number): Phase {
  if (!listed || !signer || !listed.some((key) => key.publicKey === signer.publicKey)) return 'unknown';
  if (listed.length <= steady) return 'steady';
  const stagedListed = staged.find((key) => listed.some((l) => l.publicKey === key.publicKey));
  if (stagedListed) return stagedListed.publicKey === signer.publicKey ? 'switched' : 'listed';
  return 'two-listed';
}

/**
 * Every check a configured set must pass, from the env file's values and any staged key files.
 * Read-only, and nothing in the report is private: findings name variables, the rest is kids
 * and public keys.
 */
export async function doctor(
  values: Readonly<Record<string, string>>,
  stagedFiles: readonly StagedKey[] = [],
  family: KeyFamily = STORE_FAMILY,
): Promise<DoctorReport> {
  const findings: Finding[] = [];
  const members = membersOf(family);
  const lists: Record<string, ListedKey[] | undefined> = {};
  const signers: Record<string, Signer | undefined> = {};
  const secrets = privateForms([
    ...members.map((m) => values[family.members[m]!.privateKey]),
    ...stagedFiles.flatMap((file) => Object.values(parseEnvText(file.text) as Record<string, string>)),
  ]);
  for (const m of members) {
    const names = family.members[m]!;
    lists[m] = await readList(names.publicKeys, values[names.publicKeys], findings, family, secrets);
    signers[m] = await readSigner(names.privateKey, values[names.privateKey], findings);
  }
  const staged: Record<string, (Signer & { label: string })[]> = Object.fromEntries(members.map((m) => [m, []]));
  for (const file of stagedFiles) {
    const entries = Object.entries(parseEnvText(file.text) as Record<string, string>);
    const member = members.find((m) => entries.length === 1 && entries[0]![0] === family.members[m]!.privateKey);
    if (!member) {
      const lines = members.map((m) => `${family.members[m]!.privateKey}=`).join(' or ');
      findings.push({ level: 'error', subject: file.label, check: `is not one ${lines} line, as generate writes` });
      continue;
    }
    const signer = await readSigner(file.label, entries[0]![1], findings);
    if (signer) staged[member]!.push({ ...signer, label: file.label });
  }

  // A key listed for both members, or one key signing both, lets one member's key sign as the
  // other (for the store: the caller key signing `substrat.erase`, L16).
  const [first, second] = members as [string, string];
  const firstNames = family.members[first]!;
  const secondNames = family.members[second]!;
  for (const key of lists[first] ?? []) {
    const twin = lists[second]?.find((t) => t.publicKey === key.publicKey);
    if (twin) {
      findings.push({ level: 'error', subject: firstNames.publicKeys, check: `entry ${key.position} (kid ${key.kid}) is also ${secondNames.publicKeys} entry ${twin.position}: ${family.bothLists}` });
    }
  }
  if (signers[first] && signers[first]!.publicKey === signers[second]?.publicKey) {
    findings.push({ level: 'error', subject: firstNames.privateKey, check: `is the same key as ${secondNames.privateKey}: each ${family.member} needs its own` });
  }

  const steady = family.standby ? 2 : 1;
  for (const m of members) {
    const other = otherOf(family, m);
    const names = family.members[m]!;
    const otherNames = family.members[other]!;
    const own = lists[m];
    const theirs = lists[other];
    const signer = signers[m];
    if (signer) {
      if (own && !own.some((key) => key.publicKey === signer.publicKey)) {
        findings.push({ level: 'error', subject: names.privateKey, check: `signs as kid ${signer.kid}, which ${names.publicKeys} does not list: every ${m} call is refused (the signer was switched before its key was listed)` });
      }
      if (theirs?.some((key) => key.publicKey === signer.publicKey)) {
        findings.push({ level: 'error', subject: names.privateKey, check: `signs as kid ${signer.kid}, which ${otherNames.publicKeys} lists: its holder could sign ${other} envelopes` });
      }
      // RFC wire-signing §6: a standby listed ahead of need, so a signer that cannot sign switches
      // to a key every verifier already holds. Needed before an environment goes signed-only.
      if (family.standby && own && !own.some((key) => key.publicKey !== signer.publicKey)) {
        findings.push({ level: 'warn', subject: names.publicKeys, check: `lists no standby key beside the one ${names.privateKey} signs with: list one before any environment goes signed-only (${family.runbook})` });
      }
    }
    for (const key of staged[m]!) {
      if (theirs?.some((t) => t.publicKey === key.publicKey)) {
        findings.push({ level: 'error', subject: key.label, check: `(kid ${key.kid}, ${m}) is listed in ${otherNames.publicKeys}` });
      }
      if (signers[other]?.publicKey === key.publicKey) {
        findings.push({ level: 'error', subject: key.label, check: `is the same key as ${otherNames.privateKey}` });
      }
      if (own && !own.some((l) => l.publicKey === key.publicKey)) {
        findings.push({ level: 'warn', subject: key.label, check: `(kid ${key.kid}) is not in ${names.publicKeys} yet: list it and deploy before making it the signer` });
      }
    }
    if (own && own.length > steady) {
      findings.push({ level: 'warn', subject: names.publicKeys, check: `lists ${own.length} keys: a rotation is in progress (pnpm ${family.command} rotate --${family.member} ${m})` });
    }
  }

  // The verifier's own reading of the pair must agree. If it refuses and nothing above did, this
  // tool has fallen behind the envelope module, which is a defect here, not an operator error.
  const texts = Object.fromEntries(members.map((m) => [m, values[family.members[m]!.publicKeys]]));
  if (members.every((m) => texts[m] !== undefined) && !findings.some((f) => f.level === 'error' && f.subject.endsWith('_PUBLIC_KEYS'))) {
    try {
      await family.load(texts as Record<string, string>);
    } catch {
      findings.push({ level: 'error', subject: family.lists, check: `pass every check here but ${family.verifier} refuses them: tools/store-keys.mts is out of step with the envelope module` });
    }
  }

  const report: Record<string, MemberReport> = {};
  for (const m of members) {
    report[m] = { listed: lists[m], signer: signers[m], staged: staged[m]!, phase: phaseOf(lists[m], signers[m], staged[m]!, steady) };
  }
  return { family, findings, members: report };
}

function formatDoctor(report: DoctorReport): string {
  const { family } = report;
  const lines: string[] = [];
  for (const m of membersOf(family)) {
    const names = family.members[m]!;
    const a = report.members[m]!;
    lines.push(`● ${m}  (signer: ${names.signer} ${names.privateKey}; list: ${names.publicKeys})  phase: ${a.phase}`);
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

/**
 * The ordered rotation for one member with the current step marked, or the new list value when
 * `drop` names a kid to remove. Throws {@link StoreKeysError} on an ordering it can see is unsafe;
 * it cannot see what is deployed, and says so. For a family that lists a standby, a drop that would
 * leave the signer's key alone in the list, with no standby beside it, is refused unless
 * `withoutStandby` says so: it takes the break-glass key away.
 */
export function rotatePlan(
  report: DoctorReport,
  member: string,
  env: string,
  drop?: string,
  opts: { readonly withoutStandby?: boolean } = {},
): string {
  const { family } = report;
  const names = memberNames(family, member);
  const a = report.members[member]!;
  const flag = `--${family.member} ${member}`;
  // Any error blocks, the other member's included: a key in both lists breaks both.
  const blocking = report.findings.filter((f) => f.level === 'error');
  if (blocking.length) {
    throw new StoreKeysError(
      `refusing: the ${member} set is not safe to rotate from:\n${blocking.map((f) => `  ✗ ${f.subject} ${f.check}`).join('\n')}\n  (pnpm ${family.command} doctor shows the whole set)`,
    );
  }
  if (drop !== undefined) {
    const listed = a.listed ?? [];
    const target = listed.find((key) => key.kid === drop);
    if (!target) throw new StoreKeysError(`refusing: ${names.publicKeys} lists no key with kid ${drop}`);
    if (!a.signer) throw new StoreKeysError(`refusing: ${names.privateKey} is unset, so dropping a key cannot be checked against the signer`);
    if (target.publicKey === a.signer.publicKey) {
      throw new StoreKeysError(`refusing: kid ${drop} is the key ${names.privateKey} signs with; every ${member} call would be refused. Switch the signer first.`);
    }
    // Never empty: the signer's key is listed (a blocking finding otherwise) and is not the target.
    const rest = listed.filter((key) => key !== target);
    if (family.standby && rest.length < 2 && !opts.withoutStandby) {
      throw new StoreKeysError(
        `refusing: without kid ${drop}, ${names.publicKeys} would list only the key ${names.privateKey} signs with, ` +
          'and no standby beside it to switch to. List a new standby first (generate one, step 2), then drop; ' +
          'or pass --without-standby to drop it anyway.',
      );
    }
    return [
      `New value (paste it into the env file, then push and deploy the ${family.uploader}):`,
      `${names.publicKeys}=${rest.map((key) => key.publicKey).join(',')}`,
      '',
      `Then: node scripts/secrets.mjs push --env ${env} --only ${family.uploader}`,
      `      ${family.rotation.reach}`,
    ].join('\n');
  }
  const at = (phase: Phase[]) => (phase.includes(a.phase) ? '→' : ' ');
  return [
    `Rotating the ${member} key (signer: ${names.signer}, ${names.privateKey}). Current phase: ${a.phase}.`,
    'Each step is finished before the next starts. This tool sees the env file, not what is deployed.',
    ...(a.phase === 'two-listed'
      ? [`${a.listed!.length === 2 ? 'Two' : a.listed!.length} keys are listed and no staged key was given: pass --key-file <the staged file> to tell step 3 from step 5.`]
      : []),
    ...(family.standby
      ? ['The standby key stays listed throughout; only the key in use is rotated. Its private half stays offline.']
      : []),
    '',
    `${at(['steady'])} 1. pnpm ${family.command} generate ${flag} --out <path outside any git work tree>`,
    `     Keep the file until step 4. It is the new private key; the public key and kid are on stderr.`,
    `  2. Add the new public key to ${names.publicKeys} (comma-separated, after the current one),`,
    `     then: node scripts/secrets.mjs push --env ${env} --only ${family.uploader}, and deploy the ${family.uploader}.`,
    `       ${family.rotation.reach}`,
    `     Check: pnpm ${family.command} doctor --env ${env} --key-file <path>  (the staged key must be listed).`,
    `${at(['listed'])} 3. ${family.rotation.wait}`,
    `${at(['listed'])} 4. Switch the signer: replace the ${names.privateKey}= line in the env file with the staged file's line,`,
    `     node scripts/secrets.mjs push --env ${env} --only ${names.signer}, deploy the ${names.signer}, then delete the staged file.`,
    `     Doctor refuses a signer whose key is not listed, which is the ordering that breaks every ${member} call.`,
    `${at(['switched'])} 5. Drop the old key: pnpm ${family.command} rotate ${flag} --drop <old kid> prints the new list.`,
    `     It refuses to drop the key the signer uses. Push and deploy the ${family.uploader} again (same caveat).`,
    ...family.rotation.revoked,
    '',
    ...family.rotation.compromise(names.privateKey, member),
    '',
    `The runbook is ${family.runbook}.`,
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
 * The git work tree (or repository) `dir` is inside: the nearest ancestor holding a `.git` entry,
 * a directory or a worktree's file. Walked on disk rather than asked of git, so it cannot fail
 * open when git is missing or `GIT_DIR` points elsewhere. An ancestor it cannot inspect throws.
 */
function enclosingWorkTree(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    try {
      lstatSync(join(at, '.git'));
      return at;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new StoreKeysError(`refusing: cannot tell whether ${at} is in a git work tree (${code ?? 'error'})`);
      }
    }
    if (dirname(at) === at) return undefined;
  }
}

/**
 * Refuse an output path a private key must not land at: inside this repository or any git work
 * tree (checked on the resolved parent, so a symlink into one is caught), in a directory group
 * members can write or other users can reach at all, or over an existing file.
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
  const workTree = enclosingWorkTree(realParent);
  if (workTree !== undefined) {
    throw new StoreKeysError(`refusing: ${path} is inside the git work tree ${workTree}; a private key never goes there`);
  }
  // Group write lets a group member swap the 0600 file for one holding a key they made, before
  // the operator copies it; any access for others is refused outright. 0750 and 0700 pass.
  const parentMode = statSync(realParent).mode;
  if ((parentMode & 0o027) !== 0) {
    throw new StoreKeysError(
      `refusing: ${realParent} is writable by its group or reachable by other users (mode ${(parentMode & 0o777).toString(8)}); use a directory only you can write`,
    );
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
  member: string,
  target: { readonly out: string } | { readonly toTerminal: boolean },
  io: GenerateIo,
  options: { readonly repoRoot?: string; readonly fs?: WriteFs; readonly family?: KeyFamily } = {},
): Promise<{ readonly publicKey: string; readonly kid: string }> {
  const family = options.family ?? STORE_FAMILY;
  const names = memberNames(family, member);
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
      `${`${family.member}:`.padEnd(12)}${member} (signer: ${names.signer})`,
      `public key: ${pair.publicKey}`,
      `kid:        ${pair.kid}`,
      '',
      `Next: add the public key to ${names.publicKeys} and deploy the ${family.uploader} BEFORE setting ${names.privateKey}.`,
      `      pnpm ${family.command} rotate --${family.member} ${member} prints the whole procedure.`,
      ...(family.standby ? [`      A standby: list it beside the key in use and keep this file offline; it is never set until it is needed.`] : []),
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

const BOOLEAN = new Set(['stdout', 'yes-print-to-terminal', 'without-standby']);

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

function memberOf(args: Args, family: KeyFamily): string {
  const member = one(args, family.member) ?? '';
  memberNames(family, member);
  return member;
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

const usage = (family: KeyFamily) => {
  const flag = `--${family.member} ${membersOf(family).join('|')}`;
  return `usage:
  pnpm ${family.command} generate ${flag} --out <path outside the work tree>
  pnpm ${family.command} generate ${flag} --stdout [--yes-print-to-terminal]
  pnpm ${family.command} doctor [--env prod|test|dev] [--file <env file>] [--key-file <path>]...
  pnpm ${family.command} rotate ${flag} [--env …] [--file …] [--key-file <path>]... [--drop <kid>${family.standby ? ' [--without-standby]' : ''}]
Runbook: ${family.runbook}`;
};

/** Run one command. Returns the exit code; never throws, and never prints a value it read. */
export async function main(argv: readonly string[], io: GenerateIo, family: KeyFamily = STORE_FAMILY): Promise<number> {
  try {
    const args = parseArgs(argv);
    switch (args.command) {
      case 'generate': {
        const toStdout = args.flags.has('stdout');
        const out = one(args, 'out');
        if (toStdout === (out !== undefined)) throw new StoreKeysError('generate needs exactly one of --out <path> or --stdout');
        await generate(memberOf(args, family), out !== undefined ? { out } : { toTerminal: args.flags.has('yes-print-to-terminal') }, io, { family });
        return 0;
      }
      case 'doctor': {
        const { values } = readEnv(args);
        const report = await doctor(values, readStaged(args), family);
        io.stdout.write(`${formatDoctor(report)}\n`);
        return report.findings.some((f) => f.level === 'error') ? 1 : 0;
      }
      case 'rotate': {
        const member = memberOf(args, family);
        const { values, env } = readEnv(args);
        const plan = rotatePlan(await doctor(values, readStaged(args), family), member, env, one(args, 'drop'), {
          withoutStandby: args.flags.has('without-standby'),
        });
        io.stdout.write(`${plan}\n`);
        return 0;
      }
      default:
        io.stderr.write(`${usage(family)}\n`);
        return args.command === undefined ? 0 : 1;
    }
  } catch (error) {
    // Only this file's own messages are shown; anything else is reported by its error name alone.
    io.stderr.write(`✗ ${error instanceof StoreKeysError ? error.message : `unexpected ${(error as Error)?.name ?? 'error'}`}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
}
