/**
 * #2178: the versions the active primary scopes of a vertical that a promote or a serve moves were
 * last provisioned against (`provisionedVersionId`, written only after a provision or reconcile
 * succeeds): those routed on a serving ref, and those of an owner tenant. A retirement reaches a
 * scope only at its reconcile, so a scope provisioned behind the retiring version still holds the
 * keys. #2185: and whether that reconcile FINISHED the version's retirements
 * (`retirementsFinishedVersionId` equal to the receipt), since one that left a retirement open still
 * writes the receipt. One row per (version, finished), with how many installs and one of them to
 * name, however many installs there are. Installs with NO receipt are a row too (`version_id` null):
 * a switch clears the receipt (#2045), a rewind and a restore do (#2185), and a new install has none until its first
 * reconcile. The sweep reconciles every unfinished or receiptless install on its next pass, so a
 * refusal they cause is transient unless that reconcile keeps failing, answers 'unsupported', or
 * cannot report its retirements (an `adapter-cloudflare` or `vertical-host` that predates the report). Binds
 * `(vertical, servingRef, ownerTenant)`; a null matches nothing. The directory has no index on
 * `vertical`, so this scans its scopes table: once per promote or serve.
 *
 * #2184: and which binding shapes the reconcile reported the installs have bound through a link
 * (`bound_shapes`, JSON `{version, types}`), counted only while its version is the receipt's, else
 * null (unknown). Grouped by it too: each set is a subset of one version's table-held bootstrap
 * shapes, sorted, so a fleet of one vertical has a handful.
 *
 * Review of #2220: and by the version each install RUNS (`runningVersionOf`: the served version on
 * the serving script, else its pointer), since a receipt behind it speaks for neither the bindings
 * nor the retirements of what it runs now. Bind its parameters with {@link provisionedVersionsParams}.
 *
 * So the rows are at most (receipt versions × running versions × 2 × distinct type sets), still
 * independent of how many installs there are.
 */
export const PROVISIONED_VERSIONS_SQL = `SELECT provisioned_version_id AS version_id,
    CASE WHEN serving_ref = ? THEN ? ELSE vertical_version_id END AS running_version_id,
    COALESCE(retirements_finished_version_id = provisioned_version_id, 0) AS finished,
    CASE WHEN json_extract(bound_shapes, '$.version') = provisioned_version_id
      THEN json_extract(bound_shapes, '$.types') END AS bound_types,
    COUNT(*) AS installs, MIN(scope_id) AS example
  FROM scopes
  WHERE vertical = ? AND status = 'active' AND forked_from IS NULL AND COALESCE(kind, '') != 'preview'
    AND (serving_ref = ? OR tenant_id = ?)
  GROUP BY provisioned_version_id, running_version_id, finished, bound_types`;

/**
 * `PROVISIONED_VERSIONS_SQL`'s parameters: the installs of `vertical` on `serving`'s script (which
 * run its version) or owned by `ownerTenant`. Null for either matches nothing.
 */
export function provisionedVersionsParams(vertical: string, serving: ServingPointer | null, ownerTenant: string | null): (string | null)[] {
  return [serving?.ref ?? null, serving?.versionId ?? null, vertical, serving?.ref ?? null, ownerTenant];
}

/**
 * #2184: the directory's `bound_shapes` value — the version the reconcile ran against and the types
 * it reported bound, as one JSON value, so the pair is written and cleared together and a receipt
 * rewritten without it (a control plane that predates the column) reads as unknown. Null when
 * there is no receipt or the outcome does not say.
 */
export function boundShapesColumn(versionId: string | null, types: readonly string[] | undefined): string | null {
  return versionId !== null && types ? JSON.stringify({ version: versionId, types: [...new Set(types)].sort() }) : null;
}

/** #2184: `Scope.boundShapes` from the directory's `bound_shapes` value; null for null or anything unreadable. */
export function boundShapesOfColumn(raw: string | null | undefined): { versionId: string; types: string[] } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { version?: unknown; types?: unknown };
    const ok = typeof v.version === 'string' && Array.isArray(v.types) && v.types.every((t) => typeof t === 'string');
    return ok ? { versionId: v.version as string, types: v.types as string[] } : null;
  } catch {
    return null;
  }
}

/** One row of `PROVISIONED_VERSIONS_SQL`: the installs that last reconciled one version. */
export interface InstallsReconciled {
  /** Null: installs with no receipt, which may not have reconciled anything they run. */
  versionId: string | null;
  /**
   * Review of #2220: the version they run now, when the caller knows it. One that differs from
   * `versionId` is a receipt lagging what runs: judged as if nothing about it had been reported.
   */
  runningVersionId: string | null;
  /**
   * #2185: whether their reconcile of `versionId` finished every retirement it declares. False
   * judges them as still holding the keys it retires. Meaningless when `versionId` is null.
   */
  retirementsFinished: boolean;
  /**
   * #2184: the types of `versionId`'s table-held bootstrap shapes their reconcile reported bound
   * through a link, or null when it did not report (or `versionId` is null): the gate then counts
   * every such shape as bound.
   */
  boundShapes: string[] | null;
  installs: number;
  /** One of them, so a refusal can say which install to look at. */
  example: string;
}

/** `PROVISIONED_VERSIONS_SQL`'s rows, as either adapter's driver returns them. */
export function installsReconciledOf(rows: readonly Record<string, unknown>[]): InstallsReconciled[] {
  return rows.map((r) => ({
    versionId: r.version_id == null ? null : String(r.version_id),
    runningVersionId: r.running_version_id == null ? null : String(r.running_version_id),
    retirementsFinished: Number(r.finished) === 1,
    boundShapes: r.bound_types == null ? null : (JSON.parse(String(r.bound_types)) as string[]),
    installs: Number(r.installs),
    example: String(r.example),
  }));
}

/**
 * #2185: one install's own receipt as a {@link InstallsReconciled} group, for a bind or a route of
 * that install, judged by the same rule as the promote's `PROVISIONED_VERSIONS_SQL` rows, with the
 * version it runs before the move (`scopeMoveOf`'s `before`).
 */
export function installReconciled(
  scope: Pick<Scope, 'id' | 'provisionedVersionId' | 'retirementsFinishedVersionId' | 'boundShapes'>,
  runningVersionId: string | null,
): InstallsReconciled {
  const versionId = scope.provisionedVersionId;
  return {
    versionId,
    runningVersionId,
    retirementsFinished: versionId !== null && scope.retirementsFinishedVersionId === versionId,
    boundShapes: versionId !== null && scope.boundShapes?.versionId === versionId ? scope.boundShapes.types : null,
    installs: 1,
    example: scope.id,
  };
}

/**
 * #2184: what the gate counts as bound for a group: the types its reconcile reported, or every
 * table-held bootstrap shape (`'unknown'`) when it did not, or when the group has no receipt.
 */
export function boundEverOf(g: InstallsReconciled): readonly string[] | 'unknown' {
  return g.versionId !== null && g.boundShapes !== null ? g.boundShapes : 'unknown';
}

/** Review of #2220: whether a group's receipt is behind the version its installs run. */
const receiptLags = (g: InstallsReconciled) => g.versionId !== null && g.runningVersionId !== null && g.runningVersionId !== g.versionId;

/** One judgment of the binding-shape gate: a version to judge a move from, and how (`assertNoBindingShapeBreak`). */
export interface StrandJudgment {
  from: string;
  opts: { judgedFrom: string; retiredStillHeld: boolean; boundEver: readonly string[] | 'unknown' };
}

/**
 * What the binding-shape gate judges a move onto `afterId` from, for one group of installs, given
 * the versions the move leaves (`froms`). One rule for both adapters' doors:
 *
 * - no receipt: every one of `froms`, as if nothing about it had run or been reported (the installs
 *   run one of them; judging the others too can only over-refuse, and only while it lasts);
 * - a receipt behind the version they run (review of #2220): that running version the same way,
 *   since whatever it bound or retired since the receipt is not in it — a version that added `bind`
 *   may have reconciled and been claimed through without its receipt landing;
 * - a receipt: its own version, from its own report (#2185, #2184).
 *
 * Each is transient: the sweep reconciles every such install on its next pass.
 */
export function strandJudgmentsOf(g: InstallsReconciled, froms: readonly string[], afterId: string): StrandJudgment[] {
  const judgedFrom = installsReconciledNote(g);
  const unreported = { judgedFrom, retiredStillHeld: true, boundEver: 'unknown' as const };
  if (g.versionId === null) return froms.filter((f) => f !== afterId).map((from) => ({ from, opts: unreported }));
  const out: StrandJudgment[] = [];
  if (receiptLags(g) && g.runningVersionId !== afterId) out.push({ from: g.runningVersionId!, opts: unreported });
  if (g.versionId !== afterId) {
    out.push({ from: g.versionId, opts: { judgedFrom, retiredStillHeld: !g.retirementsFinished, boundEver: boundEverOf(g) } });
  }
  return out;
}

/** What a refusal judged from installs' receipts says it was judged from. */
export function installsReconciledNote(g: InstallsReconciled): string {
  // #2184: the types a link has bound people to, where the reconcile reported any.
  const bound = g.versionId !== null && g.boundShapes?.length ? `, where links have bound people to ${g.boundShapes.join(', ')}` : '';
  const unfinished = g.versionId !== null && !g.retirementsFinished;
  const unknown = g.versionId !== null && g.boundShapes === null;
  // Review of #2220: a receipt behind what they run speaks for none of it.
  const lags = receiptLags(g)
    ? `, and run ${g.runningVersionId}, which that receipt does not speak for: every bootstrap shape of ${g.runningVersionId} ` +
      'with a table holder counts as bound and its retirements as not run'
    : '';
  if (unfinished || unknown) {
    const gaps = [unfinished && 'with its retirements not finished', unknown && 'without reporting which binding shapes links have bound'];
    const waits = [unfinished && 'their retirements to finish', unknown && 'their report'];
    const report = unfinished && unknown ? 'retirement and binding reports (#2185, #2184)' : unfinished ? 'retirement report (#2185)' : 'binding report (#2184)';
    return (
      `${g.installs} install(s) that reconciled ${g.versionId} ${gaps.filter(Boolean).join(' and ')}${bound} (one is ${g.example})${lags}` +
      (unknown ? `, so every bootstrap shape of ${g.versionId} with a table holder counts as bound` : '') +
      `; the drop waits for ${waits.filter(Boolean).join(' and ')}: the sweep reconciles them again each pass. ` +
      "An install whose vertical's @substrat-run/adapter-cloudflare or @substrat-run/vertical-host predates the " +
      `${report} stays here: push a version built on current releases of both packages`
    );
  }
  const which = g.versionId === null ? 'with no reconcile receipt (a switch, a rewind or a restore cleared it, or none was written yet)' : `that last reconciled ${g.versionId}${bound}`;
  return (
    `${g.installs} install(s) ${which} (one is ${g.example})${lags}; the drop waits for their reconcile. ` +
    "If that install's reconcile keeps failing or answers 'unsupported' (a vertical built on a vertical-host " +
    'that cannot reconcile), no sweep writes its receipt: fix the reconcile or push a version built on a ' +
    'current vertical-host, so the retirement reaches it'
  );
}
