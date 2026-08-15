/**
 * The builder studio's generator seam.
 * Design: docs/design/builder-studio.md §5 (the provider seam), D-49.
 */
export type { BuildEvent, BuildEventOf, PlanAssumption, StepUsage } from './events.js';
export { formatEvent } from './events.js';

export {
	collect,
	NullGenerator,
	type GeneratorInput,
	type GeneratorTurn,
	type VerticalGenerator,
} from './generator.js';

export { workspaceTools, type WorkspaceToolOptions, type WorkspaceTools } from './tools.js';

export { AiSdkGenerator, type AiSdkGeneratorOptions } from './ai-sdk.js';

export { classifyProviderError, retryDelayMs, type RetryDecision } from './retry.js';

export { applyEdit, type EditOutcome } from './edit.js';
