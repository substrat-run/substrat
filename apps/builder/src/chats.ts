/**
 * A project's chats — each one a line of work on a branch of its own.
 *
 * A chat has its own conversation (history, record thread), its own branch
 * (`builder/<id>`), and the per-tree caches that follow the branch (editor
 * snapshot, phase). Turns and editor saves commit to the chat's branch; the
 * project's base branch — the one a release builds and a GitHub deploy
 * workflow watches — moves only when a chat is merged into it. So starting a
 * new chat is both a fresh context for the model and a fresh branch from the
 * base, and an old chat resumed is still on the code it was talking about.
 *
 * Pure registry logic; the agent (agent.ts) does the storage and the git
 * (repositories.ts `checkoutBranch`, `mergeIntoBase`).
 */
import { CHAT_BRANCH_PREFIX } from './repositories.js';

export interface ChatEntry {
	id: string;
	title: string;
	/** `user` once renamed: the first message no longer names it. */
	titleSource: 'auto' | 'user';
	branch: string;
	createdAt: string;
	updatedAt: string;
	/** The chat branch's commit, as last checked out or pushed; unset until it has one. */
	revision?: string;
	/** The base's commit the branch was started from. While `revision` is still this, the chat has no work. */
	startRevision?: string;
	/** The chat's commit the base last took from a merge in the studio. */
	mergedRevision?: string;
}

interface ChatHost {
	id: string;
	createdAt: string;
	chats?: ChatEntry[];
	currentChatId?: string;
}

export const chatBranch = (id: string): string => `${CHAT_BRANCH_PREFIX}${id.toLowerCase()}`;

export function newChat(id: string, now: string): ChatEntry {
	return { id, title: 'New chat', titleSource: 'auto', branch: chatBranch(id), createdAt: now, updatedAt: now };
}

/**
 * The project with its chats, and the current one. A project from before chats gets its first
 * chat here, under the PROJECT's id: its history, record thread, snapshot and phase are all
 * stored under that id, so they become the first chat's with nothing moved. Its branch starts
 * from the base, where everything that chat did already is.
 */
export function withChats<T extends ChatHost>(entry: T): { entry: T; chat: ChatEntry; changed: boolean } {
	const chats = entry.chats?.length ? entry.chats : [{ ...newChat(entry.id, entry.createdAt), title: 'First chat' }];
	const chat = chats.find((c) => c.id === entry.currentChatId) ?? chats[0]!;
	const changed = chats !== entry.chats || chat.id !== entry.currentChatId;
	return { entry: changed ? { ...entry, chats, currentChatId: chat.id } : entry, chat, changed };
}

/** A chat's title from its first message: the first line, cut at a word near 60 characters. */
export function titleFrom(message: string): string {
	const line = message.trim().split('\n')[0]!.trim();
	if (line.length <= 60) return line || 'New chat';
	const cut = line.slice(0, 60);
	const space = cut.lastIndexOf(' ');
	return `${space > 30 ? cut.slice(0, space) : cut}…`;
}

/** `empty`: no commit of its own yet. `merged`: the base has its last commit. Else work the base lacks. */
export function chatStatus(chat: ChatEntry): 'empty' | 'unmerged' | 'merged' {
	if (!chat.revision || chat.revision === chat.startRevision) return 'empty';
	return chat.revision === chat.mergedRevision ? 'merged' : 'unmerged';
}

/**
 * The project without chat `id`, or null when it has no such chat or it is the last one — a
 * project always has a chat to type into. Removing the current chat makes the most recently
 * touched one current.
 */
export function withoutChat<T extends ChatHost>(entry: T, id: string): { entry: T; removed: ChatEntry } | null {
	const chats = entry.chats ?? [];
	const removed = chats.find((c) => c.id === id);
	if (!removed || chats.length < 2) return null;
	const rest = chats.filter((c) => c.id !== id);
	const currentChatId = entry.currentChatId === id
		? rest.reduce((a, c) => (c.updatedAt > a.updatedAt ? c : a)).id
		: entry.currentChatId;
	return { entry: { ...entry, chats: rest, currentChatId }, removed };
}

/** Every key the hosted agent stores under one chat's id. */
export function chatStorageKeys(id: string): string[] {
	return [`state:${id}`, `phase:${id}`, `snapshot:${id}`, `record:${id}`, `record-turn:${id}`, `record-turn-seq:${id}`];
}

/**
 * A GitHub project's chat merges by pull request, opened on GitHub, where the repository's own
 * review and checks apply: the studio never writes a connected repository's base branch.
 */
export function compareUrl(repository: { owner: string; repo: string; branch: string }, chat: ChatEntry): string {
	const seg = (s: string) => s.split('/').map(encodeURIComponent).join('/');
	return `https://github.com/${seg(repository.owner)}/${seg(repository.repo)}/compare/${seg(repository.branch)}...${seg(chat.branch)}?expand=1`;
}
