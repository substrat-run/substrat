/**
 * #1834: the prefix a scope DO's refusal carries when a system-door call lands on an instance
 * other than the one the door's gate read. A PITR restore always restarts the scope's object, so
 * a call refused this way may be meeting rewound storage the gate never saw. The DO refuses before
 * anything opens, so the call can be gated again and retried. The host tells this refusal apart
 * by its prefix, because an error crossing an RPC boundary keeps its message and little else.
 */
export const SYSTEM_DOOR_MOVED = 'system door moved: ';

/** Is this the DO's refusal of a system-door call that landed on another instance? */
export function isSystemDoorMoved(err: unknown): boolean {
  const text = err instanceof Error ? err.message : typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : null;
  return typeof text === 'string' && text.startsWith(SYSTEM_DOOR_MOVED);
}

/**
 * #1834: how many times a system-door call is gated again after the DO refused it as moved. Each
 * refusal means the scope's object restarted between the gate and the call. A restart is rare, so
 * a call still moving after this many is refused (`unavailable`) rather than retried without end.
 */
export const SYSTEM_DOOR_REGATES = 3;
