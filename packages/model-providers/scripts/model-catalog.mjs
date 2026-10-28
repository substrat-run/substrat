/** Join the reviewed picker list to exact rows of the card emitted in this run. */
export function catalogFromAllowlist(allowlist, rows) {
	const seen = new Set();
	return allowlist.map((entry) => {
		if (!entry || typeof entry.id !== 'string' || !['active', 'deprecated'].includes(entry.status) || !entry.servedBy) {
			throw new Error('invalid model catalog allow-list entry');
		}
		if (seen.has(entry.id)) throw new Error(`duplicate model catalog id: ${entry.id}`);
		seen.add(entry.id);
		const rateCardIndex = rows.findIndex((row) => `${row.provider}:${row.idPrefix}` === entry.id);
		if (rateCardIndex < 0) throw new Error(`model catalog id has no exact rate-card entry: ${entry.id}`);
		const rate = rows[rateCardIndex];
		if (!rate.tiers.length || rate.tiers.some((tier) => tier.inputPer1M == null || tier.outputPer1M == null)) {
			throw new Error(`model catalog id has no complete price: ${entry.id}`);
		}
		return { id: entry.id, label: rate.label, status: entry.status, servedBy: entry.servedBy, rateCardIndex };
	});
}
