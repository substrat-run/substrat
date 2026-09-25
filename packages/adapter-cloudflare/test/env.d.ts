// Type the bindings the contract tests reach through `cloudflare:test`'s `env`.
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    SCOPE: DurableObjectNamespace;
    CONTROL_PLANE: DurableObjectNamespace;
    /** Scopes whose migration fails closed — migration-failure.test.ts. */
    BROKEN_SCOPE: DurableObjectNamespace;
    /** The alarm-driven platform-sweep trigger — platform-sweeper.test.ts. */
    SWEEPER: DurableObjectNamespace;
    /** …and one whose every pass throws whole. */
    BROKEN_SWEEPER: DurableObjectNamespace;
    /** The sweeper tests' own directory + scope namespaces (same classes). */
    SWEEP_SCOPE: DurableObjectNamespace;
    SWEEP_CONTROL_PLANE: DurableObjectNamespace;
    /** #1242: the version identity the deploy would inject — version-stamp.test.ts. */
    SUBSTRAT_VERSION_ID: string;
    /** The CP-less scope-local sweep trigger (#461) — scope-sweeper.test.ts… */
    SCOPE_SWEEPER: DurableObjectNamespace;
    /** …and its own scope namespace (same ScopeDO class, no directory). */
    LOCAL_SWEEP_SCOPE: DurableObjectNamespace;
    /** #938: the live-read scope class, carrying only `liveMod` — live-reads.test.ts. */
    LIVE_SCOPE: DurableObjectNamespace;
    /** #1705: the cross-vertical suite's two deployments and their own directory. */
    CRM_SCOPE: DurableObjectNamespace;
    BOARD_SCOPE: DurableObjectNamespace;
    VE_CONTROL_PLANE: DurableObjectNamespace;
    /** #1710: three pushed versions' scripts, one namespace each, and their directory. */
    PC_V1_SCOPE: DurableObjectNamespace;
    PC_V2_SCOPE: DurableObjectNamespace;
    PC_V3_SCOPE: DurableObjectNamespace;
    PC_CONTROL_PLANE: DurableObjectNamespace;
    /** #1705 PR 2: the kick coalescer (recording, throwing, real) and the log its passes write. */
    KICK_TEST: DurableObjectNamespace;
    KICK_THROW: DurableObjectNamespace;
    KICK_REAL: DurableObjectNamespace;
    KICK_LOG: DurableObjectNamespace;
    KICK_SLOW: DurableObjectNamespace;
  }
}
