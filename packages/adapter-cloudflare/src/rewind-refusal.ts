/**
 * #1819: the prefix every DEFINITE refusal of a PITR rewind carries. The scope DO refuses before
 * it arms the bookmark, so a refusal means nothing was rewound. Any other throw from a rewind is
 * ambiguous: the DO may already have armed the bookmark and restarted. The host tells the two
 * apart by this prefix, because an error crossing an RPC boundary keeps its message and little
 * else.
 */
export const REWIND_REFUSED = 'rewind refused: ';

/** Is this a rewind the scope DO definitely refused, before arming anything? */
export function isRewindRefusal(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(REWIND_REFUSED);
}
