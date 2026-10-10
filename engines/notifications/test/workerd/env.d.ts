// The bindings `cloudflare:test`'s `env` carries — `test/workerd/wrangler.jsonc`.
declare namespace Cloudflare {
  interface Env {
    SCOPE: DurableObjectNamespace;
    CONTROL_PLANE: DurableObjectNamespace;
  }
}
