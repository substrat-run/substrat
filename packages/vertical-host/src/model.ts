/**
 * The platform's model host — governance around a model call, provider-neutral.
 *
 * D-18 splits the AI capability in two: the model is an adapter (any row of
 * `@substrat-run/model-providers`), the governance is the kernel's. This is the
 * governance, at the host layer, wrapped around one call:
 *
 *   1. resolve `provider:model` against PLATFORM-held credentials (the worker's own
 *      bindings — never a per-install token, that is what made ticket0's assistant
 *      bring-your-own-account, #1054);
 *   2. ask the host's `guard` whether this call may run at all (a tenant budget, a
 *      plan that does not include this model) — policy, enforced before the bytes go out;
 *   3. run it;
 *   4. turn the AI SDK's usage into one `ModelUsageLine`, priced from the rate card on
 *      OUR side, attributed with the five fixed keys, and hand it to `record`.
 *
 * It lives HERE, around operations, and not on `OperationContext`: a model call is a
 * multi-second network round-trip, and holding a scope's transaction open across it
 * would be exactly the "no network in module code" rule broken from the inside. A
 * vertical calls this from its harness — the way ticket0's assistant already runs —
 * and records the result through its own operations.
 *
 * Nothing in this file names a provider. Cloudflare's gateway extras (per-request
 * metadata, spend limits) are layered on that row by the provider package when the
 * host asks for them; the line this produces is the same for every row.
 */
import { generateText, type LanguageModelUsage } from 'ai';
import {
  createModel,
  credentialsFrom,
  hostingInfo,
  listCostOfSteps,
  normalizeModelSpec,
  parseModelSpec,
  ProviderError,
  requestHeadersFor,
  type CredentialEnv,
  type DirectFactories,
  type HostingInfo,
  type StepTokens,
} from '@substrat-run/model-providers';
import { modelAttribution, modelUsageLine, type ModelAttribution, type ModelUsageLine } from '@substrat-run/contracts';

export type { HostingInfo, ModelAttribution, ModelUsageLine };
export { ProviderError };

/** What the guard sees before anything is sent: which model, on whose behalf. */
export interface ModelIntent {
  readonly spec: string;
  readonly attribution: ModelAttribution;
}

export interface ModelRequest extends ModelIntent {
  readonly system?: string;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

export interface ModelRun {
  readonly text: string;
  readonly finishReason: string;
  /** `provider/modelId` — what a turn record shows. */
  readonly label: string;
  /** The one governance fact this call produced; already handed to `record`. */
  readonly line: ModelUsageLine;
}

/** What a settings screen shows for a spec before anyone runs it. */
export interface ModelStatus {
  readonly spec: string;
  readonly label: string;
  readonly provider: string;
  readonly modelId: string;
  /** The platform holds what this row needs. */
  readonly configured: boolean;
  /** The env vars it is missing, when not. */
  readonly missing: readonly string[];
  /** Where inference runs and what is sent there — the disclosure a settings screen shows. */
  readonly hosting: HostingInfo;
}

export interface ModelHostOptions {
  /** Platform-held credentials — the worker's own bindings. Only the row's own variables are read. */
  readonly env: CredentialEnv;
  /** Direct-provider factories this bundle statically carries (`{ anthropic: createAnthropic }`). */
  readonly factories?: DirectFactories;
  /**
   * The host's clock — stamped on every line.
   *
   * NOT `ctx.now()`, and it cannot be: a model call runs OUTSIDE any operation (D-59 —
   * no scope transaction may span a multi-second round-trip), so there is no `ctx` in
   * scope when this fires. The line's `at` is when the provider answered; the meter
   * entry the vertical writes afterwards carries `ctx.now()`, and the two are different
   * facts about different moments rather than one fact from two clocks. Injectable so a
   * scenario can freeze it — which is what R6 is really protecting.
   */
  readonly now?: () => Date;
  /** What this host sends to a model, for the disclosure: 'Customer messages and the excerpts they match'. */
  readonly sent?: string;
  /**
   * Policy, before the call. Throw to refuse: the model never runs, nothing is
   * recorded, and the caller sees the throw. A budget lives here.
   */
  readonly guard?: (intent: ModelIntent) => void | Promise<void>;
  /**
   * The ledger writes, after every successful call. A throw here fails the run —
   * a call that cannot be recorded must not look like one that was.
   */
  readonly record?: (line: ModelUsageLine) => void | Promise<void>;
}

export interface ModelHost {
  status(spec: string): ModelStatus;
  run(request: ModelRequest): Promise<ModelRun>;
}

const DESCRIBE_MISSING = (envVar: string) => `${envVar} is not set on the platform`;

/** The AI SDK's usage shape → the rate card's, with "reported" kept honest. */
export interface ReportedTokens extends StepTokens {
  readonly reported: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
}

export function stepTokensOf(usage: LanguageModelUsage | undefined): ReportedTokens {
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  return {
    reported: typeof input === 'number' || typeof output === 'number',
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

export function createModelHost(options: ModelHostOptions): ModelHost {
  const now = options.now ?? (() => new Date());

  const status = (spec: string): ModelStatus => {
    const { provider, modelId } = parseModelSpec(spec);
    const creds = credentialsFrom(provider, options.env);
    return {
      spec: normalizeModelSpec(spec),
      label: `${provider}/${modelId}`,
      provider,
      modelId,
      configured: creds.missing.length === 0,
      missing: creds.missing,
      hosting: hostingInfo(provider, options.env, options.sent ? { sent: options.sent } : {}),
    };
  };

  const run = async (request: ModelRequest): Promise<ModelRun> => {
    // Parse the attribution FIRST — before the guard, and long before anything
    // billable. It used to be validated only when the line was built, which is after
    // `generateText` has returned: a sixth key therefore bought a model call and then
    // threw, spending money that no ledger line accounted for. Parse, don't trust
    // (and the five-key limit is the whole reason this schema is `.strict()`).
    const attribution = modelAttribution.parse(request.attribution);

    // Then resolve: an unknown provider or an unconfigured row is refused before the
    // guard is consulted, so a budget is never charged for a call that could not have
    // happened.
    const resolved = createModel(request.spec, options.env, {
      factories: options.factories ?? {},
      hosted: true,
      describeMissing: DESCRIBE_MISSING,
    });
    // The guard sees the CANONICAL spec, never the caller's shorthand. `claude-opus-5`
    // and `anthropic:claude-opus-5` resolve to one model, so a policy written against
    // the canonical form would otherwise be bypassed by typing the short one.
    const model = normalizeModelSpec(request.spec);
    await options.guard?.({ spec: model, attribution });

    // The row's per-request extras — for Cloudflare's gateway, the attribution as
    // metadata and payload retention off; for every other row, nothing. The host does
    // not know which.
    const headers = requestHeadersFor(resolved.provider, { attribution: request.attribution, env: options.env });
    const started = now();
    const result = await generateText({
      model: resolved.model,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(request.system ? { system: request.system } : {}),
      prompt: request.prompt,
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    });
    const finished = now();

    const tokens = stepTokensOf(result.totalUsage);
    const line = modelUsageLine.parse({
      attribution,
      model,
      provider: resolved.provider,
      modelId: resolved.modelId,
      reported: tokens.reported,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cachedInputTokens: tokens.cachedInputTokens,
      cacheWriteTokens: tokens.cacheWriteTokens,
      listUsd: tokens.reported ? listCostOfSteps(model, [tokens]) : null,
      at: finished.toISOString(),
      elapsedMs: Math.max(0, finished.getTime() - started.getTime()),
    });
    await options.record?.(line);

    return { text: result.text, finishReason: result.finishReason, label: resolved.label, line };
  };

  return { status, run };
}
