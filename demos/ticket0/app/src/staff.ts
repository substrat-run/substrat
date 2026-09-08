/**
 * Who on the desk is a colleague (#1154).
 *
 * A leaf on purpose — no imports at all, not even a type. `ticket0_agent_profiles` is
 * two things at once and the rule below is the seam between them, so the rule has to be
 * readable from both sides: the browser imports it through `agents.ts`, and the
 * vertical's own suite imports it directly to assert it still agrees with the module.
 * Reaching it through `agents.ts` would drag `api.ts` — and `location` with it — into a
 * test program that has no DOM.
 */

/**
 * What the desk's own assistant is called.
 *
 * The assistant holds an `agentProfile` row because it authors messages and a byline
 * needs a name rather than a ULID. The module decides an author's kind by exactly this
 * string (`ASSISTANT_NAME`, `demos/ticket0/src/module.ts`), and so does `notifyStaff`
 * when it works out who to tell — so this is a second READER of one rule about who the
 * assistant is, not a second rule. `test/assignee-directory.test.ts` asserts the two
 * spellings still agree; it is restated rather than imported because `src/module.ts` is
 * server code and none of it belongs in a browser bundle.
 */
export const ASSISTANT_DISPLAY_NAME = 'Assistant';

/**
 * The directory, minus whoever cannot own a conversation.
 *
 * The assistant is in the directory for the byline, not because anyone can hand it
 * work: assigning to it mints an `assigned` notification for a principal that reads no
 * notifications, and a roster headed "On the desk" that lists it claims the desk has a
 * person it does not. So every screen that presents the directory as *people* filters
 * through here, and every screen that resolves a NAME keeps reading the whole
 * directory — `agentName` must still turn the assistant's principal into "Assistant"
 * wherever it authored something.
 *
 * `ticket0/assign` is unchanged and still accepts the assistant: this narrows what the
 * app OFFERS, not what the server takes, so nothing that worked yesterday now fails and
 * the whole change is one filter to delete. The picker's contents are still wider than
 * "people who can own a conversation" — until a principal's kind is a fact its row
 * carries, or module code can ask who holds `conversation:assign`, a display name is
 * the only thing a browser has to go on.
 *
 * Structural rather than tied to `AgentProfile`, which is the only way this file stays
 * a leaf; the two callers pass the generated entity and get it back.
 */
export function assignableStaff<T extends { display_name: string }>(staff: Iterable<T>): T[] {
  return [...staff].filter((a) => a.display_name !== ASSISTANT_DISPLAY_NAME);
}
