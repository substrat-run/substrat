import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EmittedLifecycle, EmittedModel } from '@substrat-run/contracts';
import { decisionsLog, entityDiagram, lifecycleDiagram, parseModel, parsePermissions } from '@substrat-run/model-view';
import { type Artifacts, type Bump, type Change, classify } from './bump.js';
import { baseCommit, CannotRun, changesetDirFor, defaultBase, gitRoot, packageNameOf, readArtifacts } from './changeset.js';
import { renderConceptFor } from './concept.js';

/**
 * `substrat plan` — the concept delta a design gate shows (#2363).
 *
 * The design gate is a hard stop, but what an owner approved there was prose, and nobody can see
 * from prose that a change splits an entity, adds a lifecycle state or breaks an API consumer. So
 * the gate shows a DELTA instead, computed from the artifacts of record — `model.json`,
 * `openapi.json` and `PERMISSIONS.md` in the working tree against the merge-base of a base ref:
 *
 *   - the entities added, changed and removed, with the model as Mermaid before and after (the
 *     concept document's own renderer, so the two read with one alias scheme);
 *   - the lifecycle changes: states, transitions, and the operation that triggers each;
 *   - the permission changes, as the permission-diff table (key → description → which roles);
 *   - the spec-version impact, from `bump.ts`'s `classify` — the SAME classifier
 *     `substrat changeset` writes with and `lint:changeset-bump` holds a changeset to, so the
 *     bump an owner approves is the bump the release is held to;
 *   - the decisions-log entry approving it would write.
 *
 * Approval is a person's, never automatic: `--approve <digest>` appends that entry to the
 * Decisions log of `spec/concept.md` and re-syncs its generated sections. The digest names the
 * delta that was SHOWN, so an approval of one delta cannot record another — a model edited
 * between the showing and the approving is refused, and has to be shown again.
 *
 * Every list is sorted and the digest covers no date, path or ref, so the same two trees give
 * the same output on every run. The design is declared before it is built: the delta needs a
 * re-emitted `model.json`, which `spec/model.ts` alone produces, and no handler.
 */

/** A transition, as the gate shows it: who moves the record from where to where. */
export interface TransitionChange {
  readonly entity: string;
  readonly from: string;
  /** The operation that triggers it — what a caller is permitted to run to move the record. */
  readonly operation: string;
  readonly to: string;
  /** `retargeted`: the same operation from the same state now leads elsewhere (`was`). */
  readonly change: 'added' | 'removed' | 'retargeted';
  readonly was?: string;
}

/** One row of the permission-diff table: a key whose description or holders moved. */
export interface PermissionRow {
  readonly key: string;
  readonly description: string;
  /** Roles holding it at the base and now; `null` where the key does not exist on that side. */
  readonly before: readonly string[] | null;
  readonly after: readonly string[] | null;
}

export interface ConceptDelta {
  readonly package: string;
  readonly entities: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly { readonly entity: string; readonly changes: readonly Change[] }[];
    /** The model as a Mermaid `erDiagram`, at the base (`null`: the base has no model) and now. */
    readonly before: string | null;
    readonly after: string;
  };
  readonly lifecycles: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly transitions: readonly TransitionChange[];
    /** Every classifier finding under `lifecycles.*` — states, terminal flags, `allow` lists. */
    readonly changes: readonly Change[];
    /** The changed and added lifecycles as they are now, one state diagram each. */
    readonly after: readonly string[];
  };
  readonly permissions: {
    readonly rows: readonly PermissionRow[];
    /** Every classifier finding on `PERMISSIONS.md` — each flagged for the human checkpoint. */
    readonly changes: readonly Change[];
  };
  readonly impact: { readonly bump: Bump; readonly changes: readonly Change[] };
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
const under = (prefix: string, c: Change) => c.path === prefix || c.path.startsWith(`${prefix}.`);

/** The transitions that differ between two versions of one entity's lifecycle (absent = none). */
function transitionChanges(entity: string, base: EmittedLifecycle | undefined, head: EmittedLifecycle | undefined): TransitionChange[] {
  const edges = (lc: EmittedLifecycle | undefined) => {
    const out = new Map<string, string>();
    for (const [from, def] of Object.entries(lc?.states ?? {})) {
      for (const [operation, to] of Object.entries((def as { on?: Record<string, string> }).on ?? {})) {
        out.set(`${from}\u0000${operation}`, to);
      }
    }
    return out;
  };
  const b = edges(base);
  const h = edges(head);
  const out: TransitionChange[] = [];
  for (const k of sorted(new Set([...b.keys(), ...h.keys()]))) {
    const [from, operation] = k.split('\u0000') as [string, string];
    const was = b.get(k);
    const to = h.get(k);
    if (was === to) continue;
    if (to === undefined) out.push({ entity, from, operation, to: was!, change: 'removed' });
    else if (was === undefined) out.push({ entity, from, operation, to, change: 'added' });
    else out.push({ entity, from, operation, to, change: 'retargeted', was });
  }
  return out;
}

/** The permission-diff rows that differ: a key added, removed, re-described or held by other roles. */
function permissionRows(baseMd: string | null, headMd: string | null): PermissionRow[] {
  const view = (md: string | null) => {
    if (md === null) return { holders: new Map<string, string[]>(), descriptions: new Map<string, string>() };
    const v = parsePermissions(md);
    const holders = new Map<string, string[]>([...v.descriptions.keys()].map((k) => [k, []]));
    for (const r of v.roles) for (const k of r.keys) (holders.get(k) ?? holders.set(k, []).get(k)!).push(r.role);
    for (const list of holders.values()) list.sort();
    return { holders, descriptions: v.descriptions };
  };
  const b = view(baseMd);
  const h = view(headMd);
  const rows: PermissionRow[] = [];
  for (const key of sorted(new Set([...b.holders.keys(), ...h.holders.keys()]))) {
    const before = b.holders.get(key) ?? null;
    const after = h.holders.get(key) ?? null;
    const description = h.descriptions.get(key) ?? b.descriptions.get(key) ?? '';
    if (JSON.stringify(before) === JSON.stringify(after) && b.descriptions.get(key) === h.descriptions.get(key)) continue;
    rows.push({ key, description, before, after });
  }
  return rows;
}

const readModelText = (text: string | null, what: string): EmittedModel | null =>
  text === null ? null : parseModel(JSON.parse(text) as unknown, what);

/** The delta between two sets of artifact texts. Pure: the git and filesystem half is {@link planFor}. */
export function conceptDelta(pkg: string, base: Artifacts, head: Artifacts): ConceptDelta {
  // First: the classifier refuses an artifact that is not JSON with a message naming the file.
  const impact = classify(base, head);
  const baseModel = readModelText(base.model, 'model.json (base)');
  const headModel = readModelText(head.model, 'model.json');
  if (headModel === null) {
    throw new CannotRun('no model.json in the working tree — declare the change in spec/model.ts and re-emit model.json first');
  }
  const modelChanges = impact.changes.filter((c) => c.artifact === 'model');

  const be = new Set(Object.keys(baseModel?.entities ?? {}));
  const he = new Set(Object.keys(headModel.entities));
  const changed = sorted([...be].filter((e) => he.has(e)))
    .map((entity) => ({ entity, changes: modelChanges.filter((c) => under(`entities.${entity}`, c)) }))
    .filter((e) => e.changes.length > 0);
  const added = sorted([...he].filter((e) => !be.has(e)));
  const removed = sorted([...be].filter((e) => !he.has(e)));
  const anyEntity = added.length + removed.length + changed.length > 0;

  const bl = baseModel?.lifecycles ?? {};
  const hl = headModel.lifecycles ?? {};
  const lifecycleNames = sorted(new Set([...Object.keys(bl), ...Object.keys(hl)]));
  const lifecycleChanges = modelChanges.filter((c) => c.path.startsWith('lifecycles.'));
  // Drawn: each lifecycle that is new (a new vertical has no `lifecycles.*` findings, only "model.json added") or changed.
  const touched = lifecycleNames.filter((n) => n in hl && (!(n in bl) || lifecycleChanges.some((c) => under(`lifecycles.${n}`, c))));

  return {
    package: pkg,
    entities: {
      added,
      removed,
      changed,
      before: anyEntity && baseModel ? entityDiagram(baseModel) : null,
      after: anyEntity ? entityDiagram(headModel) : '',
    },
    lifecycles: {
      added: lifecycleNames.filter((n) => !(n in bl)),
      removed: lifecycleNames.filter((n) => !(n in hl)),
      transitions: lifecycleNames.flatMap((n) => transitionChanges(n, bl[n], hl[n])),
      changes: lifecycleChanges,
      after: touched.map((n) => lifecycleDiagram(n, hl[n]!)),
    },
    permissions: {
      rows: permissionRows(base.permissions, head.permissions),
      changes: impact.changes.filter((c) => c.artifact === 'permissions'),
    },
    impact: { bump: impact.bump, changes: impact.changes },
  };
}

/** Whether the delta changes anything at all — an empty one has nothing to approve. */
export const isEmpty = (d: ConceptDelta): boolean => d.impact.changes.length === 0;

/**
 * The delta's identity: the first 12 hex of a SHA-256 over its canonical JSON. No date, ref or
 * path is in a delta, so the same two trees give the same digest wherever they are compared.
 */
export async function digestOf(d: ConceptDelta): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── the decisions-log entry ──────────────────────────────────────────────────────────────────

const code = (xs: readonly string[]) => xs.map((x) => `\`${x}\``).join(', ');

/** One sentence per part of the delta that moved, in the gate's own order. */
export function summaryOf(d: ConceptDelta): string {
  const parts: string[] = [];
  const e = d.entities;
  const entities = [
    e.added.length ? `added ${code(e.added)}` : '',
    e.removed.length ? `removed ${code(e.removed)}` : '',
    e.changed.length ? `changed ${code(e.changed.map((c) => c.entity))}` : '',
  ].filter(Boolean);
  if (entities.length) parts.push(`Entities: ${entities.join('; ')}.`);
  const l = d.lifecycles;
  const lifecycles = [
    l.added.length ? `added for ${code(l.added)}` : '',
    l.removed.length ? `removed from ${code(l.removed)}` : '',
    ...l.transitions.map((t) =>
      t.change === 'retargeted'
        ? `\`${t.operation}\` from \`${t.from}\` now leads to \`${t.to}\` (was \`${t.was}\`) on \`${t.entity}\``
        : `\`${t.operation}\` ${t.change === 'added' ? 'now moves' : 'no longer moves'} \`${t.entity}\` from \`${t.from}\` to \`${t.to}\``,
    ),
  ].filter(Boolean);
  if (lifecycles.length) parts.push(`Lifecycles: ${lifecycles.join('; ')}.`);
  else if (l.changes.length) parts.push(`Lifecycles: ${code(sorted(new Set(l.changes.map((c) => c.path.split('.')[1]!))))} changed.`);
  const p = d.permissions;
  const keys = [
    ...p.rows.filter((r) => r.before === null).map((r) => `\`${r.key}\` added`),
    ...p.rows.filter((r) => r.after === null).map((r) => `\`${r.key}\` removed`),
    ...p.rows.filter((r) => r.before !== null && r.after !== null).map((r) => `\`${r.key}\` now held by ${r.after!.length ? code(r.after!) : 'no role'}`),
  ];
  if (keys.length) parts.push(`Permissions: ${keys.join('; ')}.`);
  else if (p.changes.length) parts.push(`Permissions: ${p.changes.length} change(s) to roles or grant shapes.`);
  if (parts.length === 0 && d.impact.changes.length) parts.push('The operations or the API surface changed; no entity, lifecycle or permission did.');
  return parts.join(' ');
}

/** Wrap a list item at `width`, continuation lines indented two spaces as concept.md writes them. */
function wrapItem(text: string, width = 100): string {
  const lines: string[] = [];
  let line = '-';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line.length + 1 + word.length > width && line.trim() !== '-') {
      lines.push(line);
      line = ` ${word}`;
    } else line += ` ${word}`;
  }
  lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : ` ${l}`)).join('\n');
}

export interface EntryInputs {
  /** `YYYY-MM-DD` — the day it is approved. */
  readonly date: string;
  /** Why, in the owner's words. Absent in a proposal, where a placeholder stands in. */
  readonly why?: string;
  /** Who approved it: the person in the session. Absent in a proposal. */
  readonly by?: string;
  readonly digest: string;
}

/** The decisions-log entry, exactly as `--approve` writes it. */
export function entryFor(d: ConceptDelta, e: EntryInputs): string {
  const why = e.why?.trim() ? e.why.trim().replace(/[.\s]*$/, '.') : '<why, in the owner’s words>.';
  const by = e.by?.trim() || '<approver>';
  return wrapItem(
    `${e.date}: ${why} ${summaryOf(d)} Spec impact: ${d.impact.bump}. Approved by ${by} at the design gate (\`substrat plan\` ${e.digest}).`,
  );
}

// ─── rendering ────────────────────────────────────────────────────────────────────────────────

const MAX_LISTED = 25;
const changeLine = (c: Change) => `- ${c.flagged ? '**Review:** ' : ''}\`${c.path}\` (${c.artifact}): ${c.detail} — ${c.level}`;
const listed = (cs: readonly Change[]) => {
  const lines = cs.map(changeLine);
  return lines.length > MAX_LISTED ? [...lines.slice(0, MAX_LISTED), `- … and ${lines.length - MAX_LISTED} more`] : lines;
};
const roles = (rs: readonly string[] | null) => (rs === null ? '— (no such key)' : rs.length ? code(rs) : '— no role —');
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The delta as Markdown — what the design gate shows. Deterministic for the same inputs. */
export function renderDelta(d: ConceptDelta, opts: { base: string; digest: string; date: string; why?: string }): string {
  const out: string[] = [`# Concept delta — ${d.package}`, '', `Against \`${opts.base}\` (the merge-base with HEAD). Digest \`${opts.digest}\`.`, ''];

  out.push('## Entities', '');
  const e = d.entities;
  if (e.added.length + e.removed.length + e.changed.length === 0) out.push('_No entity is added, changed or removed._', '');
  else {
    if (e.added.length) out.push(`- **Added:** ${code(e.added)}`);
    if (e.removed.length) out.push(`- **Removed:** ${code(e.removed)}`);
    for (const c of e.changed) out.push(`- **Changed:** \`${c.entity}\``, ...listed(c.changes).map((l) => `  ${l}`));
    out.push('', '### Before', '', e.before ?? '_No model at the base: every entity is new._', '', '### After', '', e.after, '');
  }

  out.push('## Lifecycles', '');
  const l = d.lifecycles;
  if (l.changes.length === 0 && l.transitions.length === 0 && l.added.length + l.removed.length === 0) out.push('_No lifecycle, state or transition changes._', '');
  else {
    if (l.added.length) out.push(`- **Lifecycle added:** ${code(l.added)}`);
    if (l.removed.length) out.push(`- **Lifecycle removed:** ${code(l.removed)} — its states are no longer enforced`);
    if (l.transitions.length) {
      out.push('', '| Entity | From | Triggered by | To | Change |', '| --- | --- | --- | --- | --- |');
      for (const t of l.transitions) {
        const change = t.change === 'retargeted' ? `retargeted (was \`${t.was}\`)` : t.change;
        out.push(`| \`${t.entity}\` | \`${t.from}\` | \`${t.operation}\` | \`${t.to}\` | ${change} |`);
      }
      out.push(
        '',
        'Who may trigger a transition is whoever may run its operation. Which key each operation checks is not in the artifacts yet (https://github.com/substrat-run/substrat/issues/2384), so the operation is named here; who holds each key is the roles table in spec/concept.md, and any change to it is under Permissions below.',
      );
    }
    const other = l.changes.filter((c) => !/\.on\./.test(c.path));
    if (other.length) out.push('', ...listed(other));
    if (l.after.length) out.push('', ...l.after.flatMap((block) => [block, '']));
    else out.push('');
  }

  out.push('## Permissions', '');
  const p = d.permissions;
  if (p.rows.length === 0 && p.changes.length === 0) out.push('_No permission key, role or grant shape changes._', '');
  else {
    if (p.rows.length) {
      out.push('| Key | Description | Roles before | Roles after |', '| --- | --- | --- | --- |');
      for (const r of p.rows) out.push(`| \`${r.key}\` | ${cell(r.description) || '—'} | ${roles(r.before)} | ${roles(r.after)} |`);
      out.push('');
    }
    out.push('Each of these is a permission diff a person reads and approves (the human checkpoint):', '', ...listed(p.changes), '');
  }

  out.push('## Spec-version impact', '');
  if (d.impact.bump === 'none') out.push('**none** — nothing a caller sends or reads, and no permission, changed.', '');
  else {
    const top = d.impact.changes.filter((c) => c.level === d.impact.bump);
    out.push(
      `**${d.impact.bump}** — from the same classifier \`substrat changeset\` writes with, over model.json, openapi.json and PERMISSIONS.md. The ${top.length === 1 ? 'change' : `${top.length} changes`} that set it:`,
      '',
      ...listed(top),
      '',
    );
    const rest = d.impact.changes.filter((c) => c.level !== d.impact.bump);
    if (rest.length) out.push('<details><summary>Every other change</summary>', '', ...listed(rest), '', '</details>', '');
  }

  out.push('## Proposed decisions-log entry', '');
  if (isEmpty(d)) out.push('_Nothing to approve: the artifacts are the same as at the base._');
  else {
    out.push(
      '```md',
      entryFor(d, { date: opts.date, digest: opts.digest, ...(opts.why ? { why: opts.why } : {}) }),
      '```',
      '',
      `Approving writes it to the Decisions log of spec/concept.md: \`substrat plan --approve ${opts.digest} --by "<name>" --why "<why>"\`.`,
    );
  }
  return `${out.join('\n')}\n`;
}

// ─── the filesystem and git half ──────────────────────────────────────────────────────────────

/** The changesets base branch when the project releases with changesets, else `main` (on origin when fetched). */
function defaultRef(dir: string, root: string): string {
  try {
    return defaultBase(changesetDirFor(dir, root), root);
  } catch (err) {
    if (!(err instanceof CannotRun)) throw err;
    return gitRefExists('origin/main', root) ? 'origin/main' : 'main';
  }
}

const gitRefExists = (ref: string, cwd: string): boolean =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd }).status === 0;

/** The delta for the vertical at `dir` against the merge-base of `base` (default: the changesets base branch). */
export function planFor(dir: string, base?: string): { delta: ConceptDelta; base: string } {
  const root = gitRoot(dir);
  const ref = base ?? defaultRef(dir, root);
  const commit = baseCommit(ref, root);
  const { base: atBase, head } = readArtifacts(resolve(dir), commit, root);
  return { delta: conceptDelta(packageNameOf(dir), atBase, head), base: ref };
}

/**
 * Insert `entry` as the last item of the `## …Decisions log…` section, before the next `##`
 * heading. Refuses a document without that section: `lint:concept` asks for one, and an entry
 * written anywhere else would not satisfy it.
 */
export function appendDecision(markdown: string, entry: string): string {
  if (decisionsLog(markdown) === undefined) {
    throw new CannotRun('spec/concept.md has no "Decisions log" section (a `##` heading) to record the approval in');
  }
  const lines = markdown.split('\n');
  const at = lines.findIndex((l) => /^##\s+(\d+\.\s*)?decisions log\b/i.test(l));
  const next = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  let end = next < 0 ? lines.length : next;
  while (end > at + 1 && lines[end - 1]!.trim() === '') end--;
  // Below the last entry, or a blank line below the heading of an empty log; whatever followed stays.
  return [...lines.slice(0, end), ...(end === at + 1 ? [''] : []), entry, ...lines.slice(end)].join('\n');
}

export interface PlanOptions {
  readonly base?: string;
  readonly json: boolean;
  readonly why?: string;
  /** `YYYY-MM-DD`. The CLI passes today. */
  readonly date: string;
  /** The digest of the delta that was shown, when approving. */
  readonly approve?: string;
  readonly by?: string;
}

/**
 * Why `--by` or `--why` cannot go into the entry, or `undefined`. A concept marker in it would be
 * a second `<!-- substrat:… -->` in the document — every later sync and `lint:concept` refuses
 * that — and any comment or line break would let one value write structure into concept.md.
 */
export function entryTextProblem(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/<!--|-->/.test(value)) return 'may not contain an HTML comment (`<!--` or `-->`): it would be read as a concept.md marker';
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'must be one line of plain text (no line breaks or control characters)';
  return undefined;
}

/** `substrat plan`, minus the process: what to print and the exit code. */
export async function planCommand(dir: string, opts: PlanOptions): Promise<{ out: string[]; err: string[]; code: 0 | 1 }> {
  const { delta, base } = planFor(dir, opts.base);
  const digest = await digestOf(delta);
  if (opts.approve === undefined) {
    if (opts.json) {
      const entry = isEmpty(delta) ? null : entryFor(delta, { date: opts.date, digest, ...(opts.why ? { why: opts.why } : {}) });
      return { out: [JSON.stringify({ base, digest, ...delta, entry }, null, 2)], err: [], code: 0 };
    }
    return { out: [renderDelta(delta, { base, digest, date: opts.date, ...(opts.why ? { why: opts.why } : {}) })], err: [], code: 0 };
  }

  if (!opts.by?.trim() || !opts.why?.trim()) {
    return { out: [], err: ['--approve needs --by "<who approved it>" and --why "<the reason, in their words>"'], code: 1 };
  }
  if (isEmpty(delta)) return { out: [], err: [`nothing to approve: the artifacts are the same as at ${base}`], code: 1 };
  if (opts.approve !== digest) {
    return {
      out: [],
      err: [
        `the delta is now ${digest}, not the ${opts.approve} that was approved — the artifacts changed since it was shown.`,
        'Show it again (`substrat plan`) and take the approval for what it shows now.',
      ],
      code: 1,
    };
  }
  for (const [name, value] of [['--by', opts.by], ['--why', opts.why]] as const) {
    const problem = entryTextProblem(value);
    if (problem) return { out: [], err: [`${name} ${problem}`], code: 1 };
  }
  const file = join(resolve(dir), 'spec', 'concept.md');
  if (!existsSync(file)) throw new CannotRun(`no spec/concept.md at ${file} — the approval is recorded in its Decisions log`);
  const entry = entryFor(delta, { date: opts.date, why: opts.why, by: opts.by, digest });
  const current = readFileSync(file, 'utf8');
  // The whole result is rendered in memory first, the entry included, and written only once it
  // renders: a refusal (an unreadable marker, wherever it came from) leaves the file byte-identical.
  const { after } = renderConceptFor(dir, appendDecision(current, entry));
  writeFileSync(file, after);
  return {
    out: [`✓ approved ${digest} (${delta.impact.bump}) — recorded in the Decisions log of ${file}, generated sections re-synced`],
    err: [],
    code: 0,
  };
}
