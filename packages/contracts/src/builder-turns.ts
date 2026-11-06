/**
 * A builder-studio turn, summarised — the one shape the builder writes
 * (apps/builder/src/turns.ts), the control plane relays and the console renders.
 *
 * One row per turn across every team: who it was for (team, project), how it
 * ended, which gates its last run left red with the first line each printed,
 * how many repair passes it took, the commit and the tokens, and where its
 * events sit in its project's conversation thread (`firstSeq`..`lastSeq`), so a
 * reader opens exactly that turn. Who sent it is not here; it stays in the
 * thread, read only when a turn is opened.
 */
import { z } from 'zod';
import { assistantStreamEvent } from './assistant-stream.js';

/** `interrupted`: the turn died before it finished, and the next turn closed it. */
export const builderTurnOutcome = z.enum(['done', 'stopped', 'error', 'interrupted']);
export type BuilderTurnOutcome = z.infer<typeof builderTurnOutcome>;

/** A gate that was not green on the turn's last run, and the first line it printed. */
export const builderRedGate = z.object({
  name: z.string().min(1).max(64),
  status: z.enum(['failed', 'blocked']),
  line: z.string().max(400),
});
export type BuilderRedGate = z.infer<typeof builderRedGate>;

const instant = z.string().min(1).max(40);
const count = z.number().int().nonnegative();

/** One workspace tool across a turn. */
export const builderToolStat = z.object({ calls: count, errors: count, ms: count });
export type BuilderToolStat = z.infer<typeof builderToolStat>;

/**
 * What a turn needs to be compared with another: which model and which prompt actually ran,
 * and where its time and tokens went. Absent on a turn from before these were kept, and on
 * one the studio lost track of.
 */
export const builderTurnMetrics = z.object({
  /** The concrete model, where the turn's `model` may be `<provider>:auto`. */
  resolvedModel: z.string().max(200).nullable(),
  /** The image the turn ran on, and a digest of the skills it was given. */
  toolchain: z.string().max(128).nullable(),
  skills: z.string().max(64).nullable(),
  cachedInputTokens: count,
  cacheWriteTokens: count,
  /** Model requests across the turn's passes. */
  steps: count,
  passes: count,
  /** Time inside the generator, and inside every gate run. */
  generatorMs: count,
  gateMs: count,
  questions: count,
  filesWritten: count,
  bytesWritten: count,
  tools: z.record(z.string().max(64), builderToolStat),
  /** The last gate run, every gate. `redGates` keeps only the failures, with their line. */
  gates: z.array(z.object({ name: z.string().max(64), status: z.string().max(16), ms: count })).max(32),
});
export type BuilderTurnMetrics = z.infer<typeof builderTurnMetrics>;

/** What the studio knows about a turn when it closes it. */
export const builderTurnInput = z.object({
  turnId: z.string().min(1).max(64),
  tenantId: z.string().min(1).max(64),
  projectId: z.string().min(1).max(64),
  projectName: z.string().max(200),
  threadId: z.string().min(1).max(64).nullable(),
  /** The turn's events in its thread, inclusive. Null when the studio lost the turn. */
  firstSeq: count.nullable(),
  lastSeq: count.nullable(),
  model: z.string().max(200),
  phaseStart: z.string().max(32).nullable(),
  phaseEnd: z.string().max(32).nullable(),
  outcome: builderTurnOutcome,
  /** The fatal error a failed turn ended on. */
  failure: z.string().max(2_000).nullable(),
  /** Whether the turn's last gate run was green; null when no gates ran. */
  gatesOk: z.boolean().nullable(),
  redGates: z.array(builderRedGate).max(32),
  repairs: count,
  truncated: z.boolean(),
  commitSha: z.string().max(64).nullable(),
  inputTokens: count,
  outputTokens: count,
  /** Null for a turn the studio lost track of (`interrupted`). */
  startedAt: instant.nullable(),
  metrics: builderTurnMetrics.nullable().optional(),
});
export type BuilderTurnInput = z.infer<typeof builderTurnInput>;

export const builderTurn = builderTurnInput.extend({ id: z.string(), endedAt: instant });
export type BuilderTurn = z.infer<typeof builderTurn>;

/** The list read's filters. Every one narrows; none set lists every turn, most recent first. */
export const builderTurnsQuery = z.object({
  tenantId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  outcome: builderTurnOutcome.optional(),
  /** Only turns whose last gate run left this gate red. */
  redGate: z.string().min(1).max(64).optional(),
  /** Only turns that were not green: a red last gate run, or an outcome other than `done`. */
  troubled: z.boolean().optional(),
  /** Only turns that ended at or after this instant. */
  since: instant.optional(),
});
export type BuilderTurnsQuery = z.infer<typeof builderTurnsQuery>;

export const builderTurnsPage = z.object({ entries: z.array(builderTurn), nextCursor: z.string().nullable() });
export type BuilderTurnsPage = z.infer<typeof builderTurnsPage>;

/** One turn opened: its summary and its events, `cut` when there were more than one read returns. */
export const builderTurnDetail = z.object({
  turn: builderTurn,
  events: z.array(assistantStreamEvent),
  cut: z.boolean(),
});
export type BuilderTurnDetail = z.infer<typeof builderTurnDetail>;
