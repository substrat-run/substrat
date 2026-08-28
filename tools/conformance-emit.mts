/**
 * CONFORMANCE.md — the generated receipt, sibling of PERMISSIONS.md (#866).
 *
 * Enforcement here is architectural, and therefore invisible. A scope IS a
 * Durable Object with its own SQLite, so another tenant's row is not
 * absent-by-predicate but absent-by-construction — which is the strongest claim
 * the platform makes and the hardest one to show anybody. A buyer cannot see an
 * absence and an auditor cannot file it. `kernel-design` §11.2 committed to the
 * output years before this file existed: *"Isolation suite: the §10 table above,
 * run adversarially; results published (the trust page)."*
 *
 * `PERMISSIONS.md` is already most of the document. What it cannot do is prove
 * the runtime obeys it: it is a signed statement of intent with no evidence
 * attached. The entity-check conformance kit is the evidence. This tool is the
 * join.
 *
 * ## The count discipline — the part that decides whether it is worth anything
 *
 * The tempting version generates every endpoint × every tenant and reports a
 * four-figure assertion count. It is not done here, deliberately. Cross-tenant
 * isolation is ONE kernel fact, tested once in `scope-host-suite.ts` against both
 * adapters (K-3). Restating it per endpoint per app produces a big number that
 * measures the same thing N times, and an auditor who notices that discounts the
 * whole artifact — leaving it worth less than the absence it replaced.
 *
 * So the report has two sections and the split IS the design:
 *
 *  1. **Kernel-enforced properties** — cited once, naming the contract suite that
 *     verifies them, with no per-app number attached.
 *  2. **This app's assertions** — the entity-check pairs, covered and uncovered
 *     BY NAME. The only part that varies per app, and the only part where a count
 *     means anything.
 *
 * ## Where the facts come from
 *
 * Each package declares `substrat.conformance` — a path to the module its own
 * `test/entity-checks.test.ts` imports. So the covered/uncovered partition
 * printed here is computed by `planEntityCheckCoverage` from the SAME `inputs`
 * and `refEntityType` the suite is driven with. The artifact cannot claim
 * coverage the suite does not have, because there is no second copy of the facts
 * to drift. Same principle as `tools/permission-diff.mts`, same reason.
 *
 * What this artifact is NOT: a record that the tests passed. It is the statement
 * of what is asserted; CI going red is what makes the statement true. That is
 * exactly the standing of `PERMISSIONS.md`, and saying so plainly is the
 * difference between a trust page and a marketing page.
 *
 * Deterministic by construction: only operation names, permission keys, entity
 * type names and declared prose reach the output. No sample input VALUE is ever
 * printed — several are freshly minted ULIDs, and printing one would make the
 * artifact drift on every run.
 *
 * Exit codes follow boundary-lint's: 0 = fine, 1 = drift (the checkpoint
 * firing), 2 = the tool could not do its job. A checkpoint that checked nothing
 * must never print a green light.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// The PURE half of the conformance kit, imported by path rather than by package
// name: the root workspace depends on nothing, and `entity-check-suite.ts` next to
// it imports vitest at module load. The split exists for this call site (#866).
import { planEntityCheckCoverage } from '../packages/contract-tests/src/entity-check-plan.js';

const root = new URL('..', import.meta.url).pathname;
const check = process.argv.includes('--check');
const GROUPS = ['demos', 'engines'] as const;

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`conformance-emit: ${message}\n`);
  process.exit(2);
}

const code = (s: string) => `\`${s}\``;

/**
 * The kernel properties this report cites, each ONCE.
 *
 * Held here rather than parsed out of `kernel-design.md` §10: a markdown table
 * is prose a person edits for readability, and a report that silently rendered
 * fewer rows because a pipe moved would be the worst kind of wrong. The `test`
 * column names a real `it(…)` in the contract suites — grep-able, so a claim
 * whose test was deleted is findable by hand even though nothing here can catch
 * it automatically. That gap is stated in the artifact rather than hidden.
 */
const KERNEL_PROPERTIES = [
  {
    claim: 'Generated code cannot read another tenant’s data',
    mechanism:
      'Data is reachable only through a `ScopeStub` the kernel mints; the host cross-checks the ' +
      '`(tenantId, scopeId)` pair on every call and fails closed, so a scope under another tenant ' +
      'is indistinguishable from one that does not exist.',
    decision: 'K-3',
    suite: 'scope-host-suite.ts',
    test: 'fails closed on a mismatched (tenantId, scopeId) pair',
  },
  {
    claim: 'Generated code cannot skip or forge the audit trail',
    mechanism:
      'The event envelope is stamped kernel-side and emission is transactional through the ' +
      'scope’s outbox, so a write without its event is a tested bug class rather than a ' +
      'convention. The passed check — and the grant it resolved through — is stamped onto the ' +
      'event by the kernel, not by the module.',
    decision: 'K-4, K-34',
    suite: 'permission-suite.ts',
    test: 'stamps an entity-grant emit with the granting entity ref (K-34)',
  },
  {
    claim: 'A rolled-back region cannot leave its authorization behind',
    mechanism:
      'A sub-transaction that throws discards its writes, events, links, grants and platform ' +
      'intents together — including the accumulated checks, which live in JavaScript and would ' +
      'otherwise survive the rollback.',
    decision: 'K-34',
    suite: 'atomic-suite.ts',
    test: 'does not carry a discarded check into a later event (K-34)',
  },
  {
    claim: 'A narrowed grant cannot widen into scope-wide access',
    mechanism:
      'A grant narrowed to one entity answers for that entity and nothing else. It does not ' +
      'satisfy a node-level check — which is precisely what makes the per-app section below able ' +
      'to tell an entity check from a node check.',
    decision: 'K-12',
    suite: 'permission-suite.ts',
    test: 'entity-narrowed grants resolve through declared parent edges (rule 3)',
  },
  {
    claim: 'A list read cannot return a column the vertical never declared',
    mechanism:
      'List reads are answered against the declared vocabulary: an undeclared column is not a ' +
      'filter that returns nothing, it is a refusal.',
    decision: 'K-41',
    suite: 'list-suite.ts',
    test: 'refuses a filter the declaration does not offer',
  },
] as const;

/**
 * Every §1 citation names a test that exists — checked, not trusted.
 *
 * The first draft of the table above cited a `list-suite.ts` test called
 * `'refuses a filter on an undeclared column'`. No such test exists; the real
 * one is `'refuses a filter the declaration does not offer'`. A trust page whose
 * evidence column points at nothing is worse than one with no evidence column,
 * so the citation is verified here rather than left to a reader's grep.
 *
 * It is a substring match against the suite source, which is the same instrument
 * `nodeOnlySuite` uses and has the same limit: it proves the string is present,
 * not that the test asserts what the row claims. That half stays human.
 */
function verifyCitations(): void {
  const suiteDir = join(root, 'packages/contract-tests/src');
  for (const p of KERNEL_PROPERTIES) {
    const path = join(suiteDir, p.suite);
    if (!existsSync(path)) {
      cannot(
        `§1 cites ${p.suite}, which does not exist.\n` +
          `  Remedy: fix the citation in tools/conformance-emit.mts, or restore the suite.`,
      );
    }
    if (!readFileSync(path, 'utf8').includes(p.test)) {
      cannot(
        `§1 cites a test that ${p.suite} does not contain:\n` +
          `    ${p.test}\n` +
          `  Every receipt in the fleet would point a reader at nothing.\n` +
          `  Remedy: name the real test, or drop the row if the property is no longer verified.`,
      );
    }
  }
}

/** What a package's declared conformance module exports. */
interface Declaration {
  readonly kind: 'driven' | 'declared' | 'asserted';
  readonly subject: string;
  readonly because?: string;
  readonly operations?: Readonly<Record<string, object>>;
  readonly sources?: readonly string[];
  readonly inputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly uncovered?: Readonly<Record<string, string>>;
  readonly alsoGrant?: Readonly<
    Record<string, { readonly permissions: readonly string[]; readonly because: string }>
  >;
  readonly coEntities?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly refEntityType?: string;
}

/** A permission check an operation declares, as the report needs to describe it. */
interface DeclaredCheck {
  readonly key: string;
  readonly entity?: string;
  readonly entityFrom?: string;
  readonly refFrom?: string;
  readonly idFrom?: string;
  readonly resolved?: string;
}

/**
 * Every operation's authority, partitioned the way a reader needs it.
 *
 * The split matters more than it looks. An operation checking at the node is not
 * a gap — it is the right answer wherever authority is scope-wide, and #865's
 * whole finding was that absence reads as coverage when the two are not told
 * apart. So node checks are COUNTED here rather than omitted, and a walk
 * (`narrows`) is counted as its own thing.
 *
 * `narrows` with `unchecked` is a fourth thing again, and reporting it as a walk
 * was the same conflation one level down: `invites/accept` checks nothing at all —
 * the recipient holds nothing yet and the invitation is the authority — and the
 * receipt read "1 per-entity proof walk" directly under a header counting zero
 * narrowed checks. It is not ungated either; the declaration states a reason, which
 * is precisely what distinguishes it from an oversight. So it gets its own row.
 *
 * Read off the flag rather than off an empty `checks`, because empty is ALSO what a
 * walk over a composed engine's key looks like (Callout's portal walk checks
 * `workorder:read`, which the engine declares and a vertical must not restate).
 * Those really are walks, and counting them as unchecked would trade this bug for
 * a worse one.
 */
function surveyOperations(operations: Readonly<Record<string, object>>) {
  const node: string[] = [];
  const walks: string[] = [];
  const declaredNoCheck: string[] = [];
  const narrowed: { name: string; check: DeclaredCheck }[] = [];
  let ungated: string[] = [];

  for (const [name, raw] of Object.entries(operations)) {
    const op = raw as {
      permission?: string | DeclaredCheck;
      narrows?: { unchecked?: boolean };
    };
    if (op.narrows) {
      if (op.narrows.unchecked) declaredNoCheck.push(name);
      else walks.push(name);
      continue;
    }
    const permission = op.permission;
    if (!permission) {
      ungated.push(name);
      continue;
    }
    if (typeof permission === 'string') {
      node.push(name);
      continue;
    }
    if (permission.entity || permission.entityFrom || permission.refFrom) {
      narrowed.push({ name, check: permission });
    } else {
      node.push(name);
    }
  }
  ungated = ungated.sort();
  return {
    node: node.sort(),
    walks: walks.sort(),
    declaredNoCheck: declaredNoCheck.sort(),
    narrowed,
    ungated,
  };
}

/** How a narrowed check names its target — the phrase the report prints. */
function targetOf(check: DeclaredCheck): string {
  if (check.refFrom) return `whole ref from ${code(check.refFrom)}`;
  const type = check.entity ? code(check.entity) : `type from ${code(check.entityFrom!)}`;
  return check.idFrom ? `${type}, id from ${code(check.idFrom)}` : `${type}, resolved in the handler`;
}

function renderHeader(pkg: string, subtitle: string): string[] {
  return [
    `<!-- GENERATED by tools/conformance-emit.mts from each package's declared`,
    `     substrat.conformance module — do not edit by hand.`,
    `     Regenerate: pnpm lint:conformance`,
    `     This file states what is ASSERTED. CI going red is what makes it true. -->`,
    ``,
    `# Conformance receipt — ${pkg}`,
    ``,
    subtitle,
    ``,
  ];
}

function renderKernelSection(): string[] {
  return [
    `## 1. Kernel-enforced properties`,
    ``,
    `These hold for every app on the platform, and they are cited **once**. They are not`,
    `re-asserted per operation: cross-tenant isolation is one kernel fact, and restating it`,
    `per endpoint would produce a larger number measuring the same thing repeatedly.`,
    ``,
    `Each is verified by \`@substrat-run/contract-tests\`, which every scope-host adapter runs`,
    `in CI — the pure-SQLite one and the Cloudflare Durable Object one alike (D-14). An app`,
    `inherits them by running on the platform; nothing in the app's own code can opt out.`,
    ``,
    `| Property | Mechanism | Decision | Verified by |`,
    `| --- | --- | --- | --- |`,
    ...KERNEL_PROPERTIES.map(
      (p) =>
        `| ${p.claim} | ${p.mechanism} | ${p.decision} | ${code(p.suite)} — ${code(p.test)} |`,
    ),
    ``,
  ];
}

function renderDriven(decl: Declaration): string[] {
  const operations = decl.operations!;
  const survey = surveyOperations(operations);
  const { covered, uncovered } = planEntityCheckCoverage(
    operations,
    decl.inputs ?? {},
    decl.refEntityType,
    decl.coEntities,
  );

  // The vacuity plug. A package declaring `driven` whose plan is empty would
  // render a section of zeroes under a heading that says its checks are driven.
  if (survey.narrowed.length === 0) {
    cannot(
      `${decl.subject} declares kind 'driven' but no operation narrows to an entity.\n` +
        `  Remedy: this package's claim is node-only — declare it with \`declareNodeOnly\`,\n` +
        `  which asserts the empty plan instead of rendering a receipt over nothing.`,
    );
  }

  const byName = new Map<string, string[]>();
  for (const c of covered) byName.set(c.name, [...(byName.get(c.name) ?? []), c.entity]);

  const out: string[] = [
    `## 2. This app's entity checks`,
    ``,
    `An operation that should check per-entity but checks at the node passes for **anyone**`,
    `holding the key anywhere in the scope, with every test still green. Only a behavioural`,
    `pair separates the two, and the pair is generated from the declaration rather than`,
    `written by hand — so an operation added tomorrow is in it or named as missing from it.`,
    ``,
    `The probe principal holds the key **only** through a grant narrowed to one entity, never`,
    `scope-wide. Case 1 grants on A and invokes against A, and requires no denial — a node`,
    `check fails this, because a narrowed grant does not widen. Case 2 grants on A and invokes`,
    `against B, and requires a permission denial specifically.`,
    ``,
    `**${covered.length} pair${covered.length === 1 ? '' : 's'} driven** across ${byName.size} of ` +
      `this package's ${survey.narrowed.length} narrowed check${survey.narrowed.length === 1 ? '' : 's'}.`,
    ``,
    `| Operation | Permission | Narrows to | Driven |`,
    `| --- | --- | --- | --- |`,
    ...survey.narrowed
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, check }) => {
        const types = byName.get(name);
        const driven = types ? types.map(code).join(', ') : '— see §3 —';
        return `| ${code(name)} | ${code(check.key)} | ${targetOf(check)} | ${driven} |`;
      }),
    ``,
  ];

  out.push(
    `## 3. Not driven, by name`,
    ``,
    `A conformance kit that quietly covers the easy half reads as "checked" when it is not.`,
    `Every narrowed check the kit cannot generate is listed here with its reason, and the`,
    `suite asserts this list **exactly** — an operation that becomes undrivable, or one that`,
    `stops being, fails CI until this file is regenerated and the change is read.`,
    ``,
  );
  const rows = Object.entries(uncovered).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) {
    out.push(`Every narrowed check this package declares is driven.`, ``);
  } else {
    out.push(
      `| Operation | Why it cannot be driven |`,
      `| --- | --- |`,
      ...rows.map(([name, reason]) => `| ${code(name)} | ${reason} |`),
      ``,
    );
  }

  const grants = Object.entries(decl.alsoGrant ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (grants.length) {
    out.push(
      `### Authority beyond the declared key`,
      ``,
      `An operation's declared permission is the gate it opens with, not necessarily the whole`,
      `authority it exercises. Where the kit had to grant more for a case to run at all, the`,
      `extra keys are here with the reason — the one place that gap is written down.`,
      ``,
      `| Operation | Also granted | Because |`,
      `| --- | --- | --- |`,
      ...grants.map(
        ([name, g]) => `| ${code(name)} | ${g.permissions.map(code).join(', ')} | ${g.because} |`,
      ),
      ``,
    );
  }

  // Only for operations the kit drives: a co-entity declared on one it cannot
  // (or one that does not exist) is a stale note the suite refuses at collect
  // time, and §3 is the receipt's one place for an undriven declaration.
  const driven = new Set(covered.map(({ name }) => name));
  const beside = Object.entries(decl.coEntities ?? {})
    .filter(([name]) => driven.has(name))
    .sort(([a], [b]) => a.localeCompare(b));
  if (beside.length) {
    out.push(
      `### A second entity the kit supplies`,
      ``,
      `An operation that names another entity of the kind it narrows to — a merge, a move —`,
      `needs that entity to exist for the pair to run at all, so the kit makes one per case and`,
      `grants it the same keys as the target. What the pair measures is unchanged: the declared`,
      `check on the target. That the handler also checks the second entity is the operation's`,
      `own claim, and is **not** asserted here.`,
      ``,
      `| Operation | Field | Made as |`,
      `| --- | --- | --- |`,
      ...beside.flatMap(([name, fields]) =>
        Object.entries(fields)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([field, type]) => `| ${code(name)} | ${code(field)} | ${code(type)} |`),
      ),
      ``,
    );
  }

  out.push(...renderRestOfSurface(survey, 4));
  return out;
}

/**
 * The operations that claim no entity check — counted, never omitted.
 *
 * Leaving them out would reproduce the exact failure #865 named: a reader cannot
 * tell "assessed and node-level" from "nobody looked", and the second is what
 * silence looks like.
 */
function renderRestOfSurface(survey: ReturnType<typeof surveyOperations>, section: number): string[] {
  const out = [
    `## ${section}. The rest of the surface`,
    ``,
    `Not every operation should narrow. Authority over a scope-wide act — creating a record,`,
    `configuring the workspace — belongs at the node, and declaring an entity check there`,
    `would be wrong rather than safer. These are counted here so that "no entity check" reads`,
    `as an assessment rather than as silence.`,
    ``,
    `| Kind | Count | Operations |`,
    `| --- | --- | --- |`,
    `| Node-level check | ${survey.node.length} | ${survey.node.map(code).join(', ') || '—'} |`,
    `| Per-entity proof walk (\`narrows\`) | ${survey.walks.length} | ${survey.walks.map(code).join(', ') || '—'} |`,
  ];
  // Only when there is one: an empty row here would read as a category the package
  // was measured against and found wanting, and checking nothing is not a default
  // anything falls into — it has to be declared, with a reason.
  if (survey.declaredNoCheck.length) {
    out.push(
      `| Declared no check (\`narrows.unchecked\`) | ${survey.declaredNoCheck.length} | ${survey.declaredNoCheck.map(code).join(', ')} |`,
    );
  }
  out.push(``);
  if (survey.ungated.length) {
    out.push(
      `> **${survey.ungated.length} operation(s) declare no permission at all:**`,
      `> ${survey.ungated.map(code).join(', ')}`,
      ``,
    );
  }
  return out;
}

function renderNodeOnly(decl: Declaration): string[] {
  const out: string[] = [
    `## 2. This app's entity checks — none, and that is the assessment`,
    ``,
    decl.because!,
    ``,
  ];

  if (decl.kind === 'declared') {
    const survey = surveyOperations(decl.operations!);
    out.push(
      `**How this is established.** This package declares its operation surface, so the claim is`,
      `read off the declaration by the same \`planEntityCheckCoverage\` the conformance kit uses:`,
      `the plan is empty. That is exact rather than lexical, and the day an operation declares a`,
      `narrowed check the plan stops being empty and CI goes red.`,
      ``,
      `A second assertion covers the other way this could read as coverage — an operation with no`,
      `check **at all** also produces an empty plan, so emptiness alone cannot tell "checks at the`,
      `node" from "checks nothing".`,
      ``,
      ...renderRestOfSurface(survey, 3),
    );
  } else {
    out.push(
      `**How this is established, and how much it proves.** This package has no declared`,
      `operation surface for the kit to read, so the claim is a tripwire over the module's own`,
      `source: no two-argument \`ctx.check(perm, entityRef)\` appears in it. That is weaker than`,
      `the driven pair by a wide margin, and the difference is stated rather than left to be`,
      `discovered:`,
      ``,
      `- It proves an **absence**, never a behaviour. The kit generates a case that fails on a`,
      `  wrong implementation; this one only notices a new call site.`,
      `- It is **lexical**. A check assembled indirectly — a helper taking the ref, a call built`,
      `  across lines — is invisible to it.`,
      `- It says nothing about whether node-only is **right**. That judgement is the prose above.`,
      ``,
      `What it buys: the day someone narrows an operation here, this goes red, and the change`,
      `has to either declare the check and wire the real kit or rewrite the assessment.`,
      ``,
      `Source covered: ${decl.sources!.map((s) => code(s.slice(root.length))).join(', ')}`,
      ``,
    );
  }
  return out;
}

function renderLimits(kind: Declaration['kind'], section: number): string[] {
  const out = [
    `## ${section}. Not covered by this artifact`,
    ``,
    `- **This is a statement of what is asserted, not a record that it passed.** The assertions`,
    `  live in \`test/entity-checks.test.ts\` and run on every CI job; a red one blocks the merge.`,
    `  This file being current is gated by \`pnpm lint:conformance --check\`.`,
    `- **A narrowed check sitting behind a node gate is unreachable by the kit.** The probe holds`,
    `  nothing scope-wide — which is exactly what lets case 1 separate an entity check from a`,
    `  node check — so it is refused at the opening gate before the narrowed check is evaluated.`,
    `  Such an operation declares its opening gate and appears above as a node check.`,
    `- **An operation may exercise a second authority the declaration cannot record.** A handler`,
    `  checking a key at the node and then narrowing another on an entity it mints has one`,
    `  \`permission\` field to say so with.`,
    `- **The kernel rows in §1 name their verifying test by string.** Deleting that test does not`,
    `  make this file go red; the citation is grep-able so the join can be checked by hand.`,
  ];
  if (kind === 'driven') {
    out.push(
      `- **Case 1 asserts "was not denied", not "succeeded".** The kit supplies plausible input,`,
      `  not a valid domain state, so a business refusal there is not read as a permission answer.`,
      `  Case 2 is strict and demands a permission denial specifically.`,
    );
  }
  out.push(``);
  return out;
}

function render(pkg: string, decl: Declaration): string {
  if (decl.kind === 'driven') {
    const { covered } = planEntityCheckCoverage(
      decl.operations!,
      decl.inputs ?? {},
      decl.refEntityType,
      decl.coEntities,
    );
    const survey = surveyOperations(decl.operations!);
    const subtitle =
      `${Object.keys(decl.operations!).length} operations · ${survey.narrowed.length} narrowed ` +
      `check${survey.narrowed.length === 1 ? '' : 's'} · ${covered.length} conformance ` +
      `pair${covered.length === 1 ? '' : 's'} driven`;
    return [
      ...renderHeader(pkg, subtitle),
      ...renderKernelSection(),
      ...renderDriven(decl),
      ...renderLimits(decl.kind, 5),
    ].join('\n');
  }
  const count =
    decl.kind === 'declared'
      ? `${Object.keys(decl.operations!).length} operations · 0 narrowed checks`
      : `no declared operation surface · 0 narrowed checks`;
  return [
    ...renderHeader(pkg, `${count} · assessed node-only`),
    ...renderKernelSection(),
    ...renderNodeOnly(decl),
    ...renderLimits(decl.kind, decl.kind === 'declared' ? 4 : 3),
  ].join('\n');
}

// ---------------------------------------------------------------------------

interface Target {
  rel: string;
  dir: string;
  entry: string;
  pkg: string;
}

verifyCitations();

const targets: Target[] = [];
const exempt: string[] = [];

for (const group of GROUPS) {
  const groupDir = join(root, group);
  let entries: string[];
  try {
    entries = readdirSync(groupDir);
  } catch {
    cannot(`no ${group}/ directory — run from the repo root`);
  }
  for (const n of entries.sort()) {
    const dir = join(groupDir, n);
    if (!statSync(dir).isDirectory()) continue;
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name?: string;
      substrat?: { conformance?: string; permissions?: string };
    };
    const entry = pkgJson.substrat?.conformance;
    if (entry) {
      targets.push({ rel: `${group}/${n}`, dir, entry, pkg: pkgJson.name ?? `${group}/${n}` });
      continue;
    }

    // A package with an assessment but no declared pointer would render nothing
    // while looking assessed. A vertical with a permission surface but neither
    // is the #865 hole itself. Both are exit 2; a package with genuinely no
    // module surface is named as exempt rather than skipped in silence.
    if (existsSync(join(dir, 'test/entity-checks.test.ts'))) {
      cannot(
        `${group}/${n} has test/entity-checks.test.ts but declares no \`substrat.conformance\`.\n` +
          `  Its assessment would be invisible to the trust page while CI stayed green.\n` +
          `  Remedy: add \`"substrat": { "conformance": "test/conformance.ts" }\` and move the\n` +
          `  suite's options into that module. See demos/todo/test/conformance.ts.`,
      );
    }
    if (group === 'engines') {
      cannot(
        `engines/${n} declares no \`substrat.conformance\` and has no entity-check assessment.\n` +
          `  Zero narrowed declarations is indistinguishable from nobody having looked, which is\n` +
          `  the failure this artifact exists to end.\n` +
          `  Remedy: assess it and declare the result — \`declareEntityChecks\`,\n` +
          `  \`declareNodeOnly\` or \`assertNodeOnly\` in test/conformance.ts.`,
      );
    }
    if (pkgJson.substrat?.permissions) {
      const surface = (await import(
        pathToFileURL(join(dir, pkgJson.substrat.permissions)).href
      )) as { permissions?: { modules?: unknown[] } };
      const modules = surface.permissions?.modules ?? [];
      if (modules.length > 0) {
        cannot(
          `${group}/${n} registers ${modules.length} module(s) but declares no\n` +
            `  \`substrat.conformance\`. Its operations would appear in PERMISSIONS.md as intent\n` +
            `  with no evidence attached anywhere.\n` +
            `  Remedy: assess it and declare the result in test/conformance.ts.`,
        );
      }
      exempt.push(`${group}/${n} (declares an explicitly empty permission surface)`);
    }
  }
}

if (targets.length === 0) cannot(`no package under demos/ or engines/ declares substrat.conformance.`);

const drifted: string[] = [];
for (const { rel, dir, entry, pkg } of targets) {
  const mod = (await import(pathToFileURL(join(dir, entry)).href)) as {
    conformance?: Declaration;
  };
  const decl = mod.conformance;
  if (!decl || !decl.kind || !decl.subject) {
    cannot(
      `${rel}/${entry} exports no \`conformance\` declaration.\n` +
        `  Without it this package is skipped and CI goes green over an unassessed surface.\n` +
        `  Remedy: export \`const conformance = declareEntityChecks({ … })\` (or\n` +
        `  \`declareNodeOnly\` / \`assertNodeOnly\`). See engines/booking/test/conformance.ts.`,
    );
  }
  if (decl.kind !== 'driven' && !decl.because) {
    cannot(
      `${rel} claims node-only with no reason given.\n` +
        `  An assessment with no reasoning is indistinguishable from nobody having thought\n` +
        `  about it, and this artifact prints it to a reader outside the repo.\n` +
        `  Remedy: add \`because\` to the declaration.`,
    );
  }

  const path = join(dir, 'CONFORMANCE.md');
  const content = render(pkg, decl);
  const shown = path.slice(root.length);
  if (!check) {
    writeFileSync(path, content);
    continue;
  }
  if (!existsSync(path)) {
    cannot(
      `${shown} does not exist.\n` +
        `  A missing artifact is a broken setup, not drift.\n` +
        `  Remedy: pnpm lint:conformance && git add ${shown}`,
    );
  }
  if (readFileSync(path, 'utf8') !== content) drifted.push(shown);
}

if (drifted.length) {
  console.error(`conformance-emit: ${drifted.length} receipt(s) out of date\n`);
  for (const path of drifted) console.error(`  ✗ ${path}`);
  console.error(
    `\n  The conformance surface changed and the receipt was not regenerated.\n` +
      `  Run: pnpm lint:conformance — then READ the diff.\n`,
  );
  process.exit(1);
}

for (const e of exempt) console.log(`conformance-emit: exempt — ${e}`);
console.log(
  check
    ? `conformance-emit: ${targets.length} receipt(s) match`
    : `conformance-emit: wrote ${targets.length} receipt(s)`,
);
