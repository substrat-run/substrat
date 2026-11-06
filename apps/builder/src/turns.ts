/**
 * One row per builder turn, across every team — what the console filters on.
 *
 * The conversation record (record.ts) keeps everything a turn did, but it is a
 * thread per project, read one thread at a time: "which turns this week ended
 * with a red gate, and on what" would be a scan of every thread. So each turn
 * also leaves a summary here, in the studio scope beside the record: who it was
 * for (team, project), how it ended, which gates were red on its last run with
 * the first line of each, how many repair passes it took, the commit and the
 * tokens — and where in its thread the turn's events sit (`firstSeq`..`lastSeq`),
 * so a reader opens exactly that turn.
 *
 * Written by the studio as it closes a turn's record, and by the next turn for
 * one that died before it could (`interrupted`). Idempotent per turn: a replay
 * records nothing. Like the record, it is best-effort — a failed write is
 * logged and the turn goes on.
 *
 * Who sent a turn is deliberately NOT here: it is the issuer's subject, and it
 * stays in the record's `turn-context` event, read only when a turn is opened.
 */
import { z } from 'zod';
import {
	builderTurn,
	builderTurnInput,
	builderTurnsQuery,
	defineEntities,
	defineOperations,
	LIST_PAGE_DEFAULT,
	LIST_PAGE_MAX,
	moduleManifest,
	pageOf,
	permissionKey,
	type BuilderTurn,
	type BuilderTurnsQuery,
	type ListPage,
} from '@substrat-run/contracts';
import { assertAllowed, operationsFor, ulid, type ModuleRegistration, type OperationContext } from '@substrat-run/kernel';

export const TURNS_MODULE_ID = '@substrat-run/builder-turns';

export const TURNS_PERM = {
	record: permissionKey.parse('studio:record-turns'),
	read: permissionKey.parse('studio:read-turns'),
};

export const TURN_RECORDED = 'studio.turn-recorded';

const turnId = builderTurnInput.shape.turnId;

const entities = defineEntities({});
const PERMISSIONS = ['studio:record-turns', 'studio:read-turns'] as const;

export const turnOperations = defineOperations(entities, PERMISSIONS)({
	'studio/record-turn': {
		summary: "Record one turn's summary — idempotent per turn",
		permission: 'studio:record-turns',
		input: builderTurnInput,
		output: z.object({ id: z.string(), deduped: z.boolean() }),
	},
	'studio/list-turns': {
		summary: 'Turn summaries across every team, most recent first',
		permission: 'studio:read-turns',
		input: builderTurnsQuery,
		inputOptional: true,
		output: builderTurn,
		// Handler-composed: the red-gate filter reads into a JSON column, which the
		// kernel's equality filters cannot say. Ids are ULIDs, so `id` is unique and
		// orders by when the row was written; newest first.
		paged: { sortKey: 'id', order: 'desc' },
	},
	'studio/get-turn': {
		summary: "One turn's summary, by the turn's id",
		permission: 'studio:read-turns',
		input: z.object({ turnId }),
		output: builderTurn.nullable(),
	},
});

const COLUMNS =
	'id, turn_id, tenant_id, project_id, project_name, thread_id, first_seq, last_seq, model, phase_start, ' +
	'phase_end, outcome, failure, gates_ok, red_gates, repairs, truncated, commit_sha, input_tokens, ' +
	'output_tokens, started_at, ended_at, metrics';

interface TurnRow {
	id: string;
	turn_id: string;
	tenant_id: string;
	project_id: string;
	project_name: string;
	thread_id: string | null;
	first_seq: number | null;
	last_seq: number | null;
	model: string;
	phase_start: string | null;
	phase_end: string | null;
	outcome: string;
	failure: string | null;
	gates_ok: number | null;
	red_gates: string;
	repairs: number;
	truncated: number;
	commit_sha: string | null;
	input_tokens: number;
	output_tokens: number;
	started_at: string | null;
	ended_at: string;
	metrics: string | null;
}

function summaryOf(r: TurnRow): BuilderTurn {
	return builderTurn.parse({
		id: r.id,
		turnId: r.turn_id,
		tenantId: r.tenant_id,
		projectId: r.project_id,
		projectName: r.project_name,
		threadId: r.thread_id,
		firstSeq: r.first_seq,
		lastSeq: r.last_seq,
		model: r.model,
		phaseStart: r.phase_start,
		phaseEnd: r.phase_end,
		outcome: r.outcome,
		failure: r.failure,
		gatesOk: r.gates_ok === null ? null : r.gates_ok === 1,
		redGates: JSON.parse(r.red_gates) as unknown,
		repairs: r.repairs,
		truncated: r.truncated === 1,
		commitSha: r.commit_sha,
		inputTokens: r.input_tokens,
		outputTokens: r.output_tokens,
		startedAt: r.started_at,
		endedAt: r.ended_at,
		metrics: r.metrics === null ? null : (JSON.parse(r.metrics) as unknown),
	});
}

function turnByTurnId(ctx: OperationContext, turnId: string): BuilderTurn | null {
	const [row] = ctx.sql.query<TurnRow>(`SELECT ${COLUMNS} FROM studio_turns WHERE turn_id = ?`, [turnId]);
	return row ? summaryOf(row) : null;
}

const manifest = moduleManifest.parse({
	id: TURNS_MODULE_ID,
	version: '0.0.1',
	kernelContract: '^0.0.1',
	permissions: [
		{ key: 'studio:record-turns', description: "Record a builder turn's summary" },
		{ key: 'studio:read-turns', description: 'Read builder turn summaries across every team' },
	],
	events: { emits: [{ type: TURN_RECORDED, schemaVersion: 1 }], consumes: [] },
	migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
	attachmentTargets: [],
	entityRelations: [],
	entitlementKey: 'builder',
	schedules: [],
});

export const turnsModule: ModuleRegistration = {
	manifest,
	migrations: [
		{
			version: '0001-studio-turns',
			sql: `CREATE TABLE studio_turns (
	id TEXT PRIMARY KEY,
	turn_id TEXT NOT NULL UNIQUE,
	tenant_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	project_name TEXT NOT NULL,
	thread_id TEXT,
	first_seq INTEGER,
	last_seq INTEGER,
	model TEXT NOT NULL,
	phase_start TEXT,
	phase_end TEXT,
	outcome TEXT NOT NULL,
	failure TEXT,
	gates_ok INTEGER,
	red_gates TEXT NOT NULL,
	repairs INTEGER NOT NULL,
	truncated INTEGER NOT NULL,
	commit_sha TEXT,
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	started_at TEXT,
	ended_at TEXT NOT NULL
);
CREATE INDEX studio_turns_tenant ON studio_turns (tenant_id, id);
CREATE INDEX studio_turns_project ON studio_turns (project_id, id);`,
		},
		{
			version: '0002-studio-turn-metrics',
			sql: 'ALTER TABLE studio_turns ADD COLUMN metrics TEXT;',
		},
	],
	...operationsFor(turnOperations)({
		'studio/record-turn': async (ctx, input) => {
			assertAllowed(await ctx.check(TURNS_PERM.record));
			const existing = turnByTurnId(ctx, input.turnId);
			if (existing) return { id: existing.id, deduped: true };
			const row = builderTurn.parse({ ...input, id: ulid(), endedAt: ctx.now() });
			ctx.sql.exec(
				`INSERT INTO studio_turns (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					row.id,
					row.turnId,
					row.tenantId,
					row.projectId,
					row.projectName,
					row.threadId,
					row.firstSeq,
					row.lastSeq,
					row.model,
					row.phaseStart,
					row.phaseEnd,
					row.outcome,
					row.failure,
					row.gatesOk === null ? null : row.gatesOk ? 1 : 0,
					JSON.stringify(row.redGates),
					row.repairs,
					row.truncated ? 1 : 0,
					row.commitSha,
					row.inputTokens,
					row.outputTokens,
					row.startedAt,
					row.endedAt,
					row.metrics ? JSON.stringify(row.metrics) : null,
				],
			);
			ctx.emit({
				type: TURN_RECORDED,
				schemaVersion: 1,
				entity: { entityType: 'studio-turn', entityId: row.id },
				piiClass: 'none',
				payload: row,
			});
			return { id: row.id, deduped: false };
		},
		'studio/list-turns': async (ctx, input) => {
			assertAllowed(await ctx.check(TURNS_PERM.read));
			const page = (input ?? {}) as BuilderTurnsQuery & ListPage;
			const clauses: string[] = [];
			const params: (string | number)[] = [];
			if (page.tenantId) {
				clauses.push('tenant_id = ?');
				params.push(page.tenantId);
			}
			if (page.projectId) {
				clauses.push('project_id = ?');
				params.push(page.projectId);
			}
			if (page.outcome) {
				clauses.push('outcome = ?');
				params.push(page.outcome);
			}
			if (page.redGate) {
				clauses.push("EXISTS (SELECT 1 FROM json_each(red_gates) WHERE json_extract(value, '$.name') = ?)");
				params.push(page.redGate);
			}
			if (page.troubled) clauses.push("(outcome <> 'done' OR gates_ok = 0)");
			if (page.since) {
				clauses.push('ended_at >= ?');
				params.push(page.since);
			}
			if (page.cursor) {
				clauses.push('id < ?');
				params.push(page.cursor);
			}
			const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
			const limit = Math.min(page.limit ?? LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
			const rows = ctx.sql.query<TurnRow>(`SELECT ${COLUMNS} FROM studio_turns${where} ORDER BY id DESC LIMIT ?`, [
				...params,
				limit,
			]);
			return pageOf(rows.map(summaryOf), limit, (t) => t.id);
		},
		'studio/get-turn': async (ctx, input) => {
			assertAllowed(await ctx.check(TURNS_PERM.read));
			return turnByTurnId(ctx, input.turnId);
		},
	}),
};

/** The list read's filters plus its page, as `GET /internal/turns` takes them. */
export const listTurnsQuery = builderTurnsQuery.extend({
	limit: z.number().int().min(1).max(LIST_PAGE_MAX).optional(),
	cursor: z.string().min(1).max(64).optional(),
});

/** What a refused list query says: the fields it got wrong, never their values. */
export function turnQueryRefusal(error: z.ZodError): string {
	return `invalid turn query: ${error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`;
}

/**
 * The turn id in `/internal/turns/:id`, as `studio/get-turn` takes it. `'malformed'` is a
 * segment that is not valid percent-encoding (the caller's 400); `null` is an id the
 * operation could never hold, so it is an unknown turn without asking the scope.
 */
export function turnIdOfSegment(segment: string): string | null | 'malformed' {
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		return 'malformed';
	}
	const id = turnId.safeParse(decoded);
	return id.success ? id.data : null;
}
