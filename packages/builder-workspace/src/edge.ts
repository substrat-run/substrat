/**
 * The WORKER-SAFE entry — everything a Cloudflare Worker may import, and
 * nothing it may not. `LocalWorkspace` (node:fs, node:child_process) lives only
 * behind the package root entry; a worker importing the barrel drags node-only
 * modules into the bundle and fails deploy validation (error 10021 — learned
 * the hard way on substrat-builder's first deploy).
 *
 * Rule: apps/builder's worker code imports `@substrat-run/builder-workspace/edge`,
 * node code (server.ts, dev.ts, evals) imports the root. Adding anything here
 * means proving it touches no node:* module.
 */
export type {
	ExecOptions,
	ExecResult,
	ExposedPort,
	Workspace,
} from './workspace.js';
export { WorkspacePathError } from './workspace.js';

export {
	ContainerWorkspace,
	type ContainerWorkspaceOptions,
	type SandboxLike,
} from './container.js';

export {
	continuationPrompt,
	defaultGates,
	formatGateRun,
	gateRepairPrompt,
	gateReport,
	MAX_CONTINUATIONS,
	MAX_GATE_REPAIRS,
	repairNeeded,
	runGate,
	runGates,
	runInstall,
	standaloneGates,
	type GateName,
	type GateResult,
	type GateRun,
	type GateSpec,
	type GateStatus,
} from './gates.js';

export {
	changedFiles,
	commitTurn,
	ensureVerticalRepo,
	foreignChanges,
	isGitRepo,
	runTurn,
	workspaceBrief,
	type CommitOptions,
	type EnsureRepoResult,
	type RunTurnOptions,
	type TurnResult,
} from './turn.js';

export {
	runTurnLoop,
	type TurnLoopHooks,
	type TurnLoopInput,
	type TurnLoopResult,
} from './turn-loop.js';

export {
	SNAPSHOT_MAX_FILE_BYTES,
	snapshotWorkspace,
	type WorkspaceSnapshot,
} from './snapshot.js';
