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
  }
}
