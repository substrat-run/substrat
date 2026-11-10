/**
 * A failed tool stays visible wherever the chat folds work away: in the header
 * of a collapsed tool group, and in the BuildPanel that owns a plan turn's
 * work events (the chat drops its groups once a plan arrives).
 */
import { describe, expect, it } from 'vitest';
import { failedTools } from '../src/BuildPanel.js';
import { groupSummary, type ChatItem, appendEvent } from '../src/Chat.js';
import type { BuildEvent } from '../src/api.js';

const call: BuildEvent = { type: 'tool-call', tool: 'read_file', summary: 'spec/model.ts' };
const failed: BuildEvent = { type: 'tool-result', tool: 'write_file', ms: 3, ok: false };
const passed: BuildEvent = { type: 'tool-result', tool: 'read_file', ms: 2, ok: true };

describe('tool failures', () => {
	it('a collapsed group counts its failures and not the results as calls', () => {
		expect(groupSummary([call, failed])).toMatchObject({ meta: '1 call', failed: 1 });
		expect(groupSummary([call]).failed).toBe(0);
	});

	it('the BuildPanel lists failed tools and ignores successful ones', () => {
		expect(failedTools([call, passed, failed])).toEqual(['write_file']);
	});

	it('a successful result never reaches the chat', () => {
		const items: ChatItem[] = [passed, failed].reduce(appendEvent, [] as ChatItem[]);
		expect(items).toEqual([{ kind: 'event', e: failed }]);
	});
});
