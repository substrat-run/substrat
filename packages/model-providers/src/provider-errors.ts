/**
 * Provider-failure explanations — WORKER-SAFE (no node imports), shared by the
 * hosted DO and the local CLI.
 *
 * Exists because every provider failure this project has actually hit rendered
 * as something misleading before it rendered as itself: a region-scoped key as
 * "invalid", a missing endpoint as a bad token, and an exhausted weekly quota
 * as "API key is invalid" — that last one is the incident that forced this
 * file. The rule: name the REAL failure class first, keep the provider's own
 * message (it often carries the useful detail, like a quota reset time), and
 * always end with what the user can do next.
 */

export interface ErrorFacts {
	readonly statusCode?: number;
	readonly code?: string;
	readonly url?: string;
	readonly message: string;
}

/** Best-effort extraction from an AI SDK APICallError-shaped object. */
export function errorFacts(err: unknown): ErrorFacts {
	const e = err as Record<string, unknown> | null;
	const data = (e?.['data'] as Record<string, unknown> | undefined)?.['error'] as
		| Record<string, unknown>
		| undefined;
	return {
		statusCode: typeof e?.['statusCode'] === 'number' ? (e['statusCode'] as number) : undefined,
		code: typeof data?.['code'] === 'string' ? (data['code'] as string) : undefined,
		url: typeof e?.['url'] === 'string' ? (e['url'] as string) : undefined,
		message: err instanceof Error ? err.message : String(err),
	};
}

/**
 * Turn a provider error into an actionable message, or null to keep the raw
 * one. `where` distinguishes the credential's home so the "what next" step is
 * real: 'hosted' → worker secrets; 'local' → apps/builder/.env.
 */
export function explainProviderFailure(
	provider: string,
	err: unknown,
	where: 'hosted' | 'local',
): string | null {
	const f = errorFacts(err);
	const fix =
		where === 'hosted'
			? `worker secret (secrets/platform.prod.env → BUILDER_* → secrets.mjs push --only builder)`
			: `apps/builder/.env`;

	// Quota exhaustion is NOT an invalid key — the misread that forced this file.
	if (f.code === 'insufficient_quota' || /quota .*(exhaust|exceed)|insufficient_quota/i.test(f.message)) {
		return [
			`${provider}: quota exhausted — the key is fine, the plan's budget is spent.`,
			`  Provider says: ${f.message}`,
			`  Next: wait for the stated reset, top up the plan, or switch model in the picker`,
			`  (another provider keeps working meanwhile).`,
		].join('\n');
	}

	// Rate limit ≠ quota ≠ auth: transient, retry-shaped.
	if (f.statusCode === 429) {
		return [
			`${provider}: rate limited (HTTP 429) — transient, not a key problem.`,
			`  Provider says: ${f.message}`,
			`  Next: retry the turn in a moment.`,
		].join('\n');
	}

	if (f.statusCode === 401 || f.statusCode === 403) {
		const lines = [
			`${provider}: credential rejected (HTTP ${f.statusCode}).`,
			`  Provider says: ${f.message}`,
		];
		if (provider === 'qwen') {
			lines.push(
				`  DashScope keys are REGION- and WORKSPACE-scoped — the key is often fine,`,
				`  just minted for a different endpoint than ${f.url || 'the one configured'}.`,
				`  Check the key and DASHSCOPE_BASE_URL agree (${fix}).`,
			);
		} else {
			lines.push(`  Check the key in the ${fix} — no stray quotes or whitespace.`);
		}
		return lines.join('\n');
	}

	if (/model.{0,4}not.{0,4}exist|model_not_found|does not exist/i.test(f.message)) {
		return [
			`${provider}: this endpoint does not serve that model id.`,
			`  Provider says: ${f.message}`,
			`  Next: pick a different model in the picker — workspace/regional plans`,
			`  expose their own catalogs, so an id valid elsewhere can be absent here.`,
		].join('\n');
	}

	return null;
}
