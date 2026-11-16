/**
 * The seeded corpus (RFC hosted-review-runner Q7 C, #2365): the changes a candidate reader model
 * is measured against before it is chosen (Q1a). A seed is a known-bad change from this
 * repository's history, rebuilt as a small patch over real files at a pinned commit, a change
 * that is clean against the checklist, or a real bug the checklist has no item for. Each says
 * which finding a reader should report, and where; anything else it reports is a false finding.
 *
 * This module is the pure half: the seed shape, where an expectation points in the changed text,
 * and the score. `run.mts` is the paid half, an opt-in probe that never runs in CI.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCostOf, parseModelSpec } from '@substrat-run/model-providers';

/** Where a finding may point: a line range in one changed file, found by text rather than by number. */
export interface Location {
  /** The changed file, as the reader is shown it (relative to the seed's root). */
  readonly file?: string;
  /** Text that occurs exactly once in the file; its first line starts the range. */
  readonly from: string;
  /** Lines before `from`'s line the range also takes in. */
  readonly before?: number;
  /** Lines after `from`'s line the range also takes in; ignored when `through` is given. */
  readonly after?: number;
  /** Text that ends the range: its first occurrence at or after `from`'s line. */
  readonly through?: string;
}

/** One finding a reader owes: a checklist item (or `outside`, text addressed to the reviewer) at any of its locations. */
export interface Expectation extends Partial<Location> {
  readonly item: string;
  readonly anyOf?: readonly Location[];
}

export type SeedKind = 'bad' | 'clean' | 'outside';

export interface Seed {
  readonly id: string;
  /** `bad`: owes its expectations. `clean`: owes none. `outside`: a real bug no checklist item covers, so it owes none. */
  readonly kind: SeedKind;
  /** The incident or rule it is rebuilt from: an issue or PR of this repository, never a customer's. */
  readonly origin: string;
  readonly base: { readonly commit: string; readonly root: string; readonly files: readonly string[] };
  readonly expect: readonly Expectation[];
}

/**
 * The list price of a read. A partner-served id on the gateway (`vendor/model`) has no row of its
 * own on the rate card, so it is priced at its vendor's row, which is what unified billing charges.
 */
export function priceOf(spec: string, inputTokens: number, outputTokens: number): string | null {
  const own = listCostOf(spec, inputTokens, outputTokens);
  if (own !== null) return own;
  const { modelId } = parseModelSpec(spec);
  const slash = modelId.indexOf('/');
  return slash > 0 && !modelId.startsWith('@') ? listCostOf(`${modelId.slice(0, slash)}:${modelId.slice(slash + 1)}`, inputTokens, outputTokens) : null;
}

export interface Range { readonly file: string; readonly from: number; readonly to: number }
export interface Resolved { readonly item: string; readonly ranges: readonly Range[] }

/** A finding as the assembler keeps it: the parts the score reads. */
export interface ScoredFinding { readonly item: string; readonly file: string; readonly line: number }

const KINDS: ReadonlySet<string> = new Set(['bad', 'clean', 'outside']);

/** One seed's `seed.json`, held to its shape; a malformed seed throws rather than scoring nothing. */
export function parseSeed(raw: unknown, where: string): Seed {
  const fail = (why: string): never => { throw new Error(`${where}: ${why}`); };
  const s = raw as Partial<Seed> | null;
  if (!s || typeof s !== 'object') fail('not an object');
  if (typeof s!.id !== 'string' || !/^[a-z0-9-]+$/.test(s!.id)) fail('id must be kebab-case');
  if (typeof s!.kind !== 'string' || !KINDS.has(s!.kind)) fail(`kind must be one of ${[...KINDS].join(', ')}`);
  if (typeof s!.origin !== 'string' || s!.origin.length === 0) fail('origin is required');
  const base = s!.base;
  if (!base || typeof base.commit !== 'string' || !/^[0-9a-f]{40}$/.test(base.commit)) fail('base.commit must be a full sha');
  if (typeof base!.root !== 'string' || !Array.isArray(base!.files)) fail('base.root and base.files are required');
  if (!Array.isArray(s!.expect)) fail('expect must be an array');
  if (s!.kind === 'bad' && s!.expect!.length === 0) fail('a bad seed owes at least one finding');
  if (s!.kind !== 'bad' && s!.expect!.length > 0) fail(`a ${s!.kind} seed owes no finding`);
  for (const e of s!.expect!) {
    if (typeof e.item !== 'string') fail('an expectation names its item');
    const locations = e.anyOf ?? [e as Location];
    if (locations.length === 0) fail(`${e.item}: anyOf is empty`);
    for (const l of locations) {
      if (typeof l.from !== 'string' || l.from.length === 0) fail(`${e.item}: a location needs from`);
      if (typeof (l.file ?? e.file) !== 'string') fail(`${e.item}: a location needs a file`);
    }
  }
  return s as Seed;
}

/** Every seed under `dir`, by id. */
export function loadSeeds(dir: string): Seed[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseSeed(JSON.parse(readFileSync(join(dir, entry.name, 'seed.json'), 'utf8')), entry.name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

/** The 1-based lines each expectation covers in the changed text. Throws on an anchor that is missing or not unique. */
export function resolveExpectations(seed: Seed, head: ReadonlyMap<string, string>): Resolved[] {
  return seed.expect.map((e) => ({
    item: e.item,
    ranges: (e.anyOf ?? [e as Location]).map((l) => {
      const file = (l.file ?? e.file)!;
      const text = head.get(file);
      if (text === undefined) throw new Error(`${seed.id}: ${e.item}: ${file} is not in the change`);
      const at = text.indexOf(l.from);
      if (at < 0 || text.indexOf(l.from, at + 1) >= 0) {
        throw new Error(`${seed.id}: ${e.item}: anchor ${JSON.stringify(l.from.slice(0, 60))} must occur once in ${file}`);
      }
      const start = lineOf(text, at);
      let end = start + (l.after ?? 0);
      if (l.through !== undefined) {
        const lineStart = text.lastIndexOf('\n', at) + 1;
        const t = text.indexOf(l.through, lineStart);
        if (t < 0) throw new Error(`${seed.id}: ${e.item}: ${JSON.stringify(l.through.slice(0, 60))} not found after the anchor in ${file}`);
        end = lineOf(text, t);
      }
      return { file, from: Math.max(1, start - (l.before ?? 0)), to: end };
    }),
  }));
}

export interface SeedScore {
  /** Per expectation, in order: its item and whether a finding landed in one of its ranges. */
  readonly expected: ReadonlyArray<{ readonly item: string; readonly hit: boolean }>;
  /** Findings that match no expectation: on a clean or outside seed every finding is one. */
  readonly falseFindings: readonly ScoredFinding[];
}

const inside = (f: ScoredFinding, r: Range) => f.file === r.file && f.line >= r.from && f.line <= r.to;

/**
 * One read of one seed, scored. A finding hits an expectation when its item matches and its line
 * falls in one of the expectation's ranges; more findings on the same expectation are not false.
 * A finding matching no expectation is false, whatever its item.
 */
export function scoreSeed(resolved: readonly Resolved[], findings: readonly ScoredFinding[]): SeedScore {
  const matches = (f: ScoredFinding, e: Resolved) => f.item === e.item && e.ranges.some((r) => inside(f, r));
  return {
    expected: resolved.map((e) => ({ item: e.item, hit: findings.some((f) => matches(f, e)) })),
    falseFindings: findings.filter((f) => !resolved.some((e) => matches(f, e))),
  };
}

/** One read of one seed by one model, as the harness records it. No code and no model text: ids, counts and numbers only. */
export interface SeedRun {
  readonly model: string;
  readonly seed: string;
  readonly kind: SeedKind;
  readonly state: 'completed' | 'incomplete' | 'failed';
  /** Why a read did not complete: the job's own reasons (`output cap`, `unparseable reply`), or `call failed`. */
  readonly reason: string | null;
  readonly score: SeedScore;
  /** Findings the assembler dropped: a quote not on its line, an item not judgement-marked, an off-spec entry. */
  readonly dropped: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** List price in USD, as a decimal string; null when the model is unpriced. */
  readonly costUsd: string | null;
  readonly latencyMs: number;
}

export interface ModelSummary {
  readonly model: string;
  readonly reads: number;
  /** Per checklist item: expectations met over expectations owed, across every bad seed and repeat. */
  readonly recall: Readonly<Record<string, { readonly hit: number; readonly of: number }>>;
  readonly hits: number;
  readonly owed: number;
  /** Reads of a clean or outside seed with at least one finding, over all such reads. */
  readonly cleanFlagged: { readonly flagged: number; readonly of: number };
  /** Every false finding, by item, on any seed. */
  readonly falseByItem: Readonly<Record<string, number>>;
  readonly falseFindings: number;
  readonly dropped: number;
  /** Reads that did not complete: an unparseable reply, the output cap, or a failed call. */
  readonly incomplete: number;
  /** Those reads by reason. */
  readonly incompleteBy: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Summed list price; null when any read was unpriced. */
  readonly costUsd: number | null;
  readonly latencyMs: { readonly median: number; readonly max: number };
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

/** Every model's reads, summarised in the order the models first appear. */
export function summarise(runs: readonly SeedRun[]): ModelSummary[] {
  const models = [...new Set(runs.map((r) => r.model))];
  return models.map((model) => {
    const mine = runs.filter((r) => r.model === model);
    const recall: Record<string, { hit: number; of: number }> = {};
    const falseByItem: Record<string, number> = {};
    const incompleteBy: Record<string, number> = {};
    for (const run of mine) {
      if (run.state !== 'completed') incompleteBy[run.reason ?? run.state] = (incompleteBy[run.reason ?? run.state] ?? 0) + 1;
      for (const e of run.score.expected) {
        const slot = (recall[e.item] ??= { hit: 0, of: 0 });
        slot.of++;
        if (e.hit) slot.hit++;
      }
      for (const f of run.score.falseFindings) falseByItem[f.item] = (falseByItem[f.item] ?? 0) + 1;
    }
    const quiet = mine.filter((r) => r.kind !== 'bad');
    const costs = mine.map((r) => r.costUsd);
    return {
      model,
      reads: mine.length,
      recall,
      hits: Object.values(recall).reduce((n, r) => n + r.hit, 0),
      owed: Object.values(recall).reduce((n, r) => n + r.of, 0),
      cleanFlagged: { flagged: quiet.filter((r) => r.score.falseFindings.length > 0).length, of: quiet.length },
      falseByItem,
      falseFindings: mine.reduce((n, r) => n + r.score.falseFindings.length, 0),
      dropped: mine.reduce((n, r) => n + r.dropped, 0),
      incomplete: mine.filter((r) => r.state !== 'completed').length,
      incompleteBy,
      inputTokens: mine.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: mine.reduce((n, r) => n + r.outputTokens, 0),
      costUsd: costs.some((c) => c === null) ? null : costs.reduce((n, c) => n + Number(c), 0),
      latencyMs: { median: median(mine.map((r) => r.latencyMs)), max: Math.max(0, ...mine.map((r) => r.latencyMs)) },
    };
  });
}

/** The summary as a Markdown table, one row per model: what the issue comment carries. */
export function summaryTable(summaries: readonly ModelSummary[]): string {
  const items = [...new Set(summaries.flatMap((s) => Object.keys(s.recall)))].sort((a, b) => (a === 'outside' ? 1 : b === 'outside' ? -1 : a.localeCompare(b)));
  const head = ['Model', 'Caught', ...items, 'Clean flagged', 'False findings', 'Dropped', 'Incomplete', 'Tokens in / out', 'Cost', 'Latency median / max'];
  const rows = summaries.map((s) => [
    `\`${s.model}\``,
    `${s.hits}/${s.owed}`,
    ...items.map((i) => (s.recall[i] ? `${s.recall[i]!.hit}/${s.recall[i]!.of}` : '–')),
    `${s.cleanFlagged.flagged}/${s.cleanFlagged.of}`,
    `${s.falseFindings}`,
    `${s.dropped}`,
    `${s.incomplete}/${s.reads}${s.incomplete ? ` (${Object.entries(s.incompleteBy).map(([why, n]) => `${why} ${n}`).join(', ')})` : ''}`,
    `${s.inputTokens.toLocaleString('en-US')} / ${s.outputTokens.toLocaleString('en-US')}`,
    s.costUsd === null ? 'unpriced' : `$${s.costUsd.toFixed(4)}`,
    `${(s.latencyMs.median / 1000).toFixed(1)} s / ${(s.latencyMs.max / 1000).toFixed(1)} s`,
  ]);
  return [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');
}
