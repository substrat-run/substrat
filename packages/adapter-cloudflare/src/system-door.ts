/**
 * #1834: what the scope DO answers, INSTEAD of running anything, when a system-door call lands on an
 * instance other than the one the door's gate read. A PITR restore always restarts the scope's
 * object, so such a call may be meeting rewound storage the gate never saw; the door gates again
 * and retries. It is an answer, not an error: only the DO's pin check produces it, and nothing an
 * operation throws can look like it, because an operation's failure travels as `failure`.
 */
export interface SystemDoorMoved {
  readonly systemDoorMoved: true;
}

/** The one value of `SystemDoorMoved`. */
export const SYSTEM_DOOR_MOVED: SystemDoorMoved = { systemDoorMoved: true };

/** Is this answer the DO's "the pin missed", rather than the call's own answer? */
export function isSystemDoorMoved(answer: unknown): answer is SystemDoorMoved {
  return typeof answer === 'object' && answer !== null && (answer as { systemDoorMoved?: unknown }).systemDoorMoved === true;
}

/**
 * #1834: how many times a system-door call is gated again after the DO answered moved. Each such
 * answer means the scope's object restarted between the gate and the call. A restart is rare, so a
 * call still moving after this many is refused (`unavailable`) rather than retried without end.
 */
export const SYSTEM_DOOR_REGATES = 3;
