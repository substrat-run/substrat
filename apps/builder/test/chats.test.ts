import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chatStatus, compareUrl, newChat, titleFrom, withChats, withoutChat } from '../src/chats.js';
import { projectStorageKeys } from '../src/project-removal.js';

const project = { id: '01JPROJECT', createdAt: '2026-01-01' };

describe('chats', () => {
	it('adopts a project from before chats as its first chat, under the keys it already has', () => {
		const { entry, chat, changed } = withChats(project);
		expect(changed).toBe(true);
		expect(chat).toMatchObject({ id: '01JPROJECT', branch: 'builder/01jproject', title: 'First chat' });
		expect(entry.currentChatId).toBe('01JPROJECT');
		// Its history and record are stored under the project id; removal still reaches them.
		expect(projectStorageKeys(project.id, [chat.id])).toContain('state:01JPROJECT');
		expect(withChats(entry).changed).toBe(false);
	});

	it('never removes the last chat, and a removed current chat hands over to the most recent', () => {
		const a = { ...newChat('A', '2026-01-01'), updatedAt: '2026-01-03' };
		const b = newChat('B', '2026-01-02');
		const c = newChat('C', '2026-01-02');
		const entry = { ...project, chats: [a, b, c], currentChatId: 'B' };
		expect(withoutChat(entry, 'B')?.entry.currentChatId).toBe('A');
		expect(withoutChat(entry, 'C')?.entry.currentChatId).toBe('B');
		expect(withoutChat({ ...entry, chats: [a] }, 'A')).toBeNull();
	});

	it('titles a chat from its first line, cut at a word', () => {
		expect(titleFrom('  Add invoices\nwith VAT')).toBe('Add invoices');
		expect(titleFrom('Add a screen where staff can approve each invoice line before it is exported')).toBe('Add a screen where staff can approve each invoice line…');
	});

	it('pushes a turn or an editor save only to the chat branch; the base only for a CLI push', () => {
		// The agent is a Durable Object over a sandbox and does not stand up in a unit test (see
		// file-routes.test.ts), so its push sites are read off the source. A new push to the base
		// has to change this list on purpose: merges go through mergeIntoBase alone.
		const source = readFileSync(fileURLToPath(new URL('../src/agent.ts', import.meta.url)), 'utf8');
		const targets = [...source.matchAll(/saveRepository\(.*,\s*([^,()]+)\);$/gm)].map((m) => m[1]);
		// `#saveSource` (turns, editor saves) · a CLI snapshot of a studio project · a GitHub project's separate snapshot repo.
		expect(targets).toEqual(['chat.branch', 'entry.repository.branch', "'main'"]);
	});

	it('is merged only while the base has its last commit, and links GitHub compare for review', () => {
		const chat = { ...newChat('A', '2026-01-01'), revision: 'r2', mergedRevision: 'r1' };
		const statuses = [newChat('A', 'x'), { ...chat, startRevision: 'r2' }, chat, { ...chat, mergedRevision: 'r2' }].map(chatStatus);
		expect(statuses).toEqual(['empty', 'empty', 'unmerged', 'merged']);
		expect(compareUrl({ owner: 'acme', repo: 'todo.app', branch: 'release/main' }, chat)).toBe('https://github.com/acme/todo.app/compare/release/main...builder/a?expand=1');
	});
});
