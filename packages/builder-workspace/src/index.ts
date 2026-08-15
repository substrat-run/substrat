/**
 * The builder studio's workspace seam and gate runner.
 * Design: docs/design/builder-studio.md §3 (the seam), §9.1 (tier-1 gates).
 */
export type {
	ExecOptions,
	ExecResult,
	ExposedPort,
	Workspace,
} from './workspace.js';
export { WorkspacePathError } from './workspace.js';

export { LocalWorkspace, localWorkspace, type LocalWorkspaceOptions } from './local.js';

export {
	ContainerWorkspace,
	type ContainerWorkspaceOptions,
	type SandboxLike,
} from './container.js';

export {
	defaultGates,
	formatGateRun,
	gateRepairPrompt,
	gateReport,
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
